from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from time import perf_counter, time
from typing import Any

import httpx

from app.strategies.scanner_engine import MIN_QUOTE_VOLUME, SCAN_POOL_LIMIT, TOP_LIMIT, ScannerEngine

FUTURES_API = "https://fapi.binance.com"
LOOP_TICK_SECONDS = 30
HISTORY_LIMIT = 250
ALLOWED_QUOTES = {"USDT", "USDC"}
STABLE_BASES = {"USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "USD1", "USDE", "PYUSD", "BUSD"}

EXCHANGE_CACHE_SECONDS = 6 * 60 * 60
TICKER_CACHE_SECONDS = 5 * 60
BOOK_CACHE_SECONDS = 60
DEFAULT_BACKOFF_SECONDS = 5 * 60
MAX_BACKOFF_SECONDS = 60 * 60

TF_MS = {"5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000}


def _candles(rows: list[list[Any]]) -> list[dict[str, Any]]:
    return [
        {
            "open_time": int(item[0]), "open": str(item[1]), "high": str(item[2]),
            "low": str(item[3]), "close": str(item[4]), "volume": str(item[5]),
            "close_time": int(item[6]),
        }
        for item in rows
    ]


def _closed_slot(tf: str) -> int:
    return int(time() * 1000) // TF_MS[tf]


class BinanceRateLimitError(RuntimeError):
    pass


class FuturesScannerWorker:
    def __init__(self) -> None:
        self.engine = ScannerEngine()
        self.task: asyncio.Task[None] | None = None
        self.running = False
        self.last_started_at: str | None = None
        self.last_finished_at: str | None = None
        self.last_error: str | None = None
        self.last_candidate_count = 0
        self.last_long_candidates = 0
        self.last_short_candidates = 0
        self.last_scan_pool = 0
        self.last_trend_passed = 0
        self.last_top30 = 0
        self.run_count = 0

        self.blocked_until = 0.0
        self.backoff_seconds = DEFAULT_BACKOFF_SECONDS
        self.last_layer = "startup"

        self._cache: dict[str, tuple[float, Any]] = {}
        self._scan_pool: list[dict[str, Any]] = []
        self._trend_rows: list[dict[str, Any]] = []
        self._participation_rows: list[dict[str, Any]] = []
        self._top_rows: list[dict[str, Any]] = []
        self._setup_rows: list[dict[str, Any]] = []
        self._last_slots = {"1h": -1, "15m": -1, "5m": -1}

    async def start(self) -> None:
        if self.task and not self.task.done():
            return
        self.running = True
        self.task = asyncio.create_task(self._loop(), name="futures-scanner-worker")

    async def stop(self) -> None:
        self.running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None

    def status(self) -> dict[str, Any]:
        wait = max(0, int(self.blocked_until - time()))
        return {
            "running": self.running and self.task is not None and not self.task.done(),
            "interval_seconds": LOOP_TICK_SECONDS,
            "architecture": "1H cached trend -> 15m setup -> 5m entry",
            "schedule": {"trend": "new 1H candle", "setup": "new 15m candle", "entry": "new 5m candle"},
            "scan_pool_limit": SCAN_POOL_LIMIT,
            "top_limit": TOP_LIMIT,
            "min_quote_volume": MIN_QUOTE_VOLUME,
            "last_started_at": self.last_started_at,
            "last_finished_at": self.last_finished_at,
            "last_error": self.last_error,
            "last_candidate_count": self.last_candidate_count,
            "last_long_candidates": self.last_long_candidates,
            "last_short_candidates": self.last_short_candidates,
            "last_scan_pool": self.last_scan_pool,
            "last_trend_passed": self.last_trend_passed,
            "last_top30": self.last_top30,
            "last_layer": self.last_layer,
            "rate_limited": wait > 0,
            "retry_in_seconds": wait,
            "run_count": self.run_count,
        }

    async def _loop(self) -> None:
        while self.running:
            try:
                await self.run_scheduled()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = str(exc)
            await asyncio.sleep(LOOP_TICK_SECONDS)

    def _retry_after_seconds(self, response: httpx.Response) -> int:
        raw = response.headers.get("Retry-After")
        if not raw:
            return self.backoff_seconds
        try:
            return max(1, int(float(raw)))
        except ValueError:
            try:
                dt = parsedate_to_datetime(raw)
                return max(1, int(dt.timestamp() - time()))
            except Exception:
                return self.backoff_seconds

    async def _request_json(
        self,
        client: httpx.AsyncClient,
        path: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> Any:
        if time() < self.blocked_until:
            raise BinanceRateLimitError(f"Binance cooldown active; retry in {int(self.blocked_until-time())}s")
        response = await client.get(FUTURES_API + path, params=params)
        if response.status_code in {418, 429}:
            retry = self._retry_after_seconds(response)
            if response.status_code == 418:
                retry = max(retry, self.backoff_seconds)
            self.blocked_until = time() + min(retry, MAX_BACKOFF_SECONDS)
            self.backoff_seconds = min(max(retry * 2, DEFAULT_BACKOFF_SECONDS), MAX_BACKOFF_SECONDS)
            raise BinanceRateLimitError(
                f"Binance HTTP {response.status_code}; cooldown {min(retry, MAX_BACKOFF_SECONDS)}s"
            )
        response.raise_for_status()
        self.backoff_seconds = DEFAULT_BACKOFF_SECONDS
        return response.json()

    async def _cached_json(
        self,
        client: httpx.AsyncClient,
        key: str,
        ttl: int,
        path: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> Any:
        cached = self._cache.get(key)
        now = time()
        if cached and now - cached[0] < ttl:
            return cached[1]
        data = await self._request_json(client, path, params=params)
        self._cache[key] = (now, data)
        return data

    async def _load_klines(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
        symbol: str,
        interval: str,
    ) -> list[dict[str, Any]]:
        async with semaphore:
            rows = await self._request_json(
                client, "/fapi/v1/klines",
                params={"symbol": symbol, "interval": interval, "limit": HISTORY_LIMIT},
            )
            return _candles(rows)

    async def _load_oi_change(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
        symbol: str,
    ) -> float:
        async with semaphore:
            try:
                rows = await self._request_json(
                    client, "/futures/data/openInterestHist",
                    params={"symbol": symbol, "period": "1h", "limit": 2},
                )
                if len(rows) < 2:
                    return 0.0
                old = float(rows[-2].get("sumOpenInterest", 0) or 0)
                new = float(rows[-1].get("sumOpenInterest", 0) or 0)
                return ((new - old) / old * 100) if old else 0.0
            except BinanceRateLimitError:
                raise
            except Exception:
                return 0.0

    async def _market_maps(self, client: httpx.AsyncClient, need_book: bool) -> tuple[Any, dict[str, float], dict[str, Any]]:
        exchange = await self._cached_json(
            client, "exchangeInfo", EXCHANGE_CACHE_SECONDS, "/fapi/v1/exchangeInfo"
        )
        tickers = await self._cached_json(
            client, "ticker24h", TICKER_CACHE_SECONDS, "/fapi/v1/ticker/24hr"
        )
        book = []
        if need_book:
            book = await self._cached_json(
                client, "bookTicker", BOOK_CACHE_SECONDS, "/fapi/v1/ticker/bookTicker"
            )
        ticker_map = {
            str(item.get("symbol", "")): float(item.get("quoteVolume", 0) or 0)
            for item in tickers
        }
        book_map = {str(item.get("symbol", "")): item for item in book}
        return exchange, ticker_map, book_map

    def _build_scan_pool(self, exchange: Any, ticker_map: dict[str, float]) -> list[dict[str, Any]]:
        best_by_base: dict[str, dict[str, Any]] = {}
        for item in exchange.get("symbols", []):
            if item.get("status") != "TRADING" or item.get("contractType") != "PERPETUAL":
                continue
            quote = str(item.get("quoteAsset", ""))
            base = str(item.get("baseAsset", ""))
            symbol = str(item.get("symbol", ""))
            if quote not in ALLOWED_QUOTES or base in STABLE_BASES or not symbol:
                continue
            quote_volume = ticker_map.get(symbol, 0.0)
            if quote_volume < MIN_QUOTE_VOLUME:
                continue
            existing = best_by_base.get(base)
            if existing is None or quote_volume > float(existing["quote_volume"]):
                best_by_base[base] = {
                    "symbol": symbol, "base_asset": base, "quote_volume": quote_volume
                }
        return sorted(
            best_by_base.values(), key=lambda row: float(row["quote_volume"]), reverse=True
        )[:SCAN_POOL_LIMIT]

    async def _refresh_1h(self, client: httpx.AsyncClient) -> None:
        exchange, ticker_map, book_map = await self._market_maps(client, need_book=True)
        self._scan_pool = self._build_scan_pool(exchange, ticker_map)
        if not self._scan_pool:
            raise RuntimeError("No eligible liquid USD-M perpetual contracts found")

        semaphore = asyncio.Semaphore(4)
        trend_inputs = await asyncio.gather(
            *(
                self._load_klines(client, semaphore, str(row["symbol"]), "1h")
                for row in self._scan_pool
            ),
            return_exceptions=True,
        )
        trend_rows: list[dict[str, Any]] = []
        for row, candles_1h in zip(self._scan_pool, trend_inputs):
            if isinstance(candles_1h, Exception):
                if isinstance(candles_1h, BinanceRateLimitError):
                    raise candles_1h
                continue
            try:
                analyzed = self.engine.analyze_trend({**row, "candles_1h": candles_1h})
                if analyzed:
                    trend_rows.append(analyzed)
            except Exception:
                continue
        self._trend_rows = trend_rows

        async def enrich(row: dict[str, Any]) -> dict[str, Any]:
            symbol = str(row["symbol"])
            oi_change = await self._load_oi_change(client, semaphore, symbol)
            book = book_map.get(symbol) or {}
            bid = float(book.get("bidPrice", 0) or 0)
            ask = float(book.get("askPrice", 0) or 0)
            mid = (bid + ask) / 2 if bid and ask else 0.0
            spread_pct = ((ask - bid) / mid * 100) if mid else 999.0
            return {**row, "oi_change_1h_pct": oi_change, "spread_pct": spread_pct}

        enriched = await asyncio.gather(*(enrich(row) for row in trend_rows))
        self._participation_rows = self.engine.rank_participation(enriched)
        self._top_rows = self._participation_rows[:TOP_LIMIT]
        self._setup_rows = []
        self.last_layer = "1H trend + quality"

    async def _refresh_15m(self, client: httpx.AsyncClient) -> None:
        if not self._top_rows:
            self._setup_rows = []
            return

        semaphore = asyncio.Semaphore(4)
        loaded = await asyncio.gather(
            *(
                self._load_klines(client, semaphore, str(row["symbol"]), "15m")
                for row in self._top_rows
            ),
            return_exceptions=True,
        )
        next_top: list[dict[str, Any]] = []
        setup_rows: list[dict[str, Any]] = []
        for row, c15 in zip(self._top_rows, loaded):
            if isinstance(c15, Exception):
                if isinstance(c15, BinanceRateLimitError):
                    raise c15
                next_top.append({**row, "setup_15m": False, "hold_reason": "15m data unavailable"})
                continue
            enriched = {**row, "candles_15m": c15}
            try:
                evaluated = self.engine.evaluate_setup_15m(enriched)
            except Exception as exc:
                evaluated = {**enriched, "setup_15m": False, "hold_reason": f"15m evaluation error: {exc}"}
            next_top.append(evaluated)
            if evaluated.get("setup_15m"):
                setup_rows.append(evaluated)

        self._top_rows = next_top
        self._setup_rows = setup_rows
        self.last_layer = "15m setup"

    async def _refresh_5m(self, client: httpx.AsyncClient) -> dict[str, Any]:
        started = perf_counter()
        if not self._top_rows:
            return self.engine.build_result(
                universe_symbols=[str(row["symbol"]) for row in self._scan_pool],
                trend_rows=self._trend_rows,
                participation_rows=self._participation_rows,
                top_rows=[],
                decisions=[],
                started=started,
            )

        decisions: list[dict[str, Any]] = []
        setup_by_symbol = {str(row["symbol"]): row for row in self._setup_rows}

        # Preserve HOLD decisions for Top30 contracts that did not pass the 15m setup.
        for row in self._top_rows:
            if str(row["symbol"]) not in setup_by_symbol:
                decisions.append({
                    **row,
                    "decision": "HOLD",
                    "entry_5m": False,
                    "hold_reason": row.get("hold_reason") or "15m setup not confirmed",
                })

        if self._setup_rows:
            semaphore = asyncio.Semaphore(4)
            loaded = await asyncio.gather(
                *(
                    self._load_klines(client, semaphore, str(row["symbol"]), "5m")
                    for row in self._setup_rows
                ),
                return_exceptions=True,
            )
            refreshed_setup: list[dict[str, Any]] = []
            for row, c5 in zip(self._setup_rows, loaded):
                if isinstance(c5, Exception):
                    if isinstance(c5, BinanceRateLimitError):
                        raise c5
                    decisions.append({
                        **row,
                        "decision": "HOLD",
                        "entry_5m": False,
                        "hold_reason": "5m data unavailable",
                    })
                    refreshed_setup.append(row)
                    continue
                combined = {**row, "candles_5m": c5}
                refreshed_setup.append(combined)
                try:
                    decisions.append(self.engine.evaluate_entry_5m(combined))
                except Exception as exc:
                    decisions.append({
                        **combined,
                        "decision": "HOLD",
                        "entry_5m": False,
                        "hold_reason": f"5m evaluation error: {exc}",
                    })
            self._setup_rows = refreshed_setup

        self.last_layer = "5m entry"
        return self.engine.build_result(
            universe_symbols=[str(row["symbol"]) for row in self._scan_pool],
            trend_rows=self._trend_rows,
            participation_rows=self._participation_rows,
            top_rows=self._top_rows,
            decisions=decisions,
            started=started,
        )

    def _record_result(self, result: dict[str, Any]) -> dict[str, Any]:
        self.last_error = None
        self.last_candidate_count = int(result.get("candidate_count", 0))
        self.last_long_candidates = int(result.get("long_candidates", 0))
        self.last_short_candidates = int(result.get("short_candidates", 0))
        pipeline = result.get("pipeline") or {}
        self.last_scan_pool = int((pipeline.get("scan_pool") or {}).get("passed", 0))
        self.last_trend_passed = int((pipeline.get("trend_1h") or {}).get("passed", 0))
        self.last_top30 = int((pipeline.get("top_30") or {}).get("passed", 0))
        self.run_count += 1
        return result

    async def run_scheduled(self) -> dict[str, Any] | None:
        if time() < self.blocked_until:
            self.last_layer = "rate-limit cooldown"
            return None
        now_slots = {tf: _closed_slot(tf) for tf in self._last_slots}
        need_1h = not self._top_rows or now_slots["1h"] != self._last_slots["1h"]
        need_15m = need_1h or now_slots["15m"] != self._last_slots["15m"]
        need_5m = need_15m or now_slots["5m"] != self._last_slots["5m"]
        if not need_5m:
            return None

        self.last_started_at = datetime.now(timezone.utc).isoformat()
        timeout = httpx.Timeout(30.0, connect=10.0)
        try:
            async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "RakibTrade/1.0"}) as client:
                if need_1h:
                    await self._refresh_1h(client)
                    self._last_slots["1h"] = now_slots["1h"]
                if need_15m:
                    await self._refresh_15m(client)
                    self._last_slots["15m"] = now_slots["15m"]
                result = await self._refresh_5m(client)
                self._last_slots["5m"] = now_slots["5m"]
            return self._record_result(result)
        except Exception as exc:
            self.last_error = str(exc)
            raise
        finally:
            self.last_finished_at = datetime.now(timezone.utc).isoformat()

    async def run_once(self, force: bool = False) -> dict[str, Any]:
        """Manual run. Reuses cached 1H/15m layers unless force=True."""
        if time() < self.blocked_until:
            raise BinanceRateLimitError(f"Binance cooldown active; retry in {int(self.blocked_until-time())}s")
        self.last_started_at = datetime.now(timezone.utc).isoformat()
        timeout = httpx.Timeout(30.0, connect=10.0)
        started = perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "RakibTrade/1.0"}) as client:
                if force or not self._top_rows:
                    await self._refresh_1h(client)
                if force or not any(row.get("candles_15m") for row in self._top_rows):
                    await self._refresh_15m(client)
                result = await self._refresh_5m(client)
            result["processing_ms"] = round((perf_counter() - started) * 1000, 2)
            return self._record_result(result)
        except Exception as exc:
            self.last_error = str(exc)
            raise
        finally:
            self.last_finished_at = datetime.now(timezone.utc).isoformat()


scanner_worker = FuturesScannerWorker()
