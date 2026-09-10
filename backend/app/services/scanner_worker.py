from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from time import perf_counter, time
from typing import Any

import httpx

from app.strategies.scanner_engine import MIN_QUOTE_VOLUME, SCAN_POOL_LIMIT, TOP_LIMIT, ScannerEngine, restore_scanner_result
from app.services.state_store import ensure_state_schema, load_scanner_result, save_scanner_result

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
ONE_HOUR_MS = 60 * 60_000


def _candles(rows: list[list[Any]]) -> list[dict[str, Any]]:
    return [
        {
            "open_time": int(item[0]),
            "open": str(item[1]),
            "high": str(item[2]),
            "low": str(item[3]),
            "close": str(item[4]),
            "volume": str(item[5]),
            "close_time": int(item[6]),
        }
        for item in rows
    ]


def _hour_slot() -> int:
    return int(time() * 1000) // ONE_HOUR_MS


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

        # Protect Render/shared IP after deploy: do not immediately re-hit Binance if a prior instance was banned.
        self.blocked_until = time() + 60 * 60
        self.backoff_seconds = DEFAULT_BACKOFF_SECONDS
        self.last_layer = "startup cooldown"

        self._cache: dict[str, tuple[float, Any]] = {}
        self._scan_pool: list[dict[str, Any]] = []
        self._trend_rows: list[dict[str, Any]] = []
        self._participation_rows: list[dict[str, Any]] = []
        self._top_rows: list[dict[str, Any]] = []
        self._last_hour_slot = -1

    async def restore_persisted_state(self) -> None:
        try:
            ready = await asyncio.to_thread(ensure_state_schema)
            if not ready:
                return
            result = await asyncio.to_thread(load_scanner_result)
            if not result:
                return
            restore_scanner_result(result)
            self.last_candidate_count = int(result.get("candidate_count", 0))
            self.last_long_candidates = int(result.get("long_candidates", 0))
            self.last_short_candidates = int(result.get("short_candidates", 0))
            pipeline = result.get("pipeline") or {}
            self.last_scan_pool = int((pipeline.get("scan_pool") or {}).get("passed", 0))
            self.last_trend_passed = int((pipeline.get("trend_1h") or {}).get("passed", 0))
            self.last_top30 = int((pipeline.get("top_30") or {}).get("passed", 0))
            self.run_count = 1
            self.last_layer = "restored 1H Top30"
            ts = str(result.get("timestamp", ""))
            try:
                restored = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                self._last_hour_slot = int(restored.timestamp() * 1000) // ONE_HOUR_MS
            except Exception:
                self._last_hour_slot = -1
        except Exception as exc:
            self.last_error = f"state restore failed: {exc}"

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
        now_slot = _hour_slot()
        next_hour_seconds = max(0, int(((now_slot + 1) * ONE_HOUR_MS / 1000) - time()))
        return {
            "running": self.running and self.task is not None and not self.task.done(),
            "interval_seconds": LOOP_TICK_SECONDS,
            "architecture": "1H Scanner only -> Top 30",
            "schedule": {"scanner": "first successful run, then next new 1H candle"},
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
            "next_scan_in_seconds": wait if wait > 0 else next_hour_seconds,
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

    async def _request_json(self, client: httpx.AsyncClient, path: str, *, params: dict[str, Any] | None = None) -> Any:
        if time() < self.blocked_until:
            raise BinanceRateLimitError(f"Binance cooldown active; retry in {int(self.blocked_until - time())}s")
        response = await client.get(FUTURES_API + path, params=params)
        if response.status_code in {418, 429}:
            retry = self._retry_after_seconds(response)
            if response.status_code == 418:
                retry = max(retry, self.backoff_seconds)
            retry = min(retry, MAX_BACKOFF_SECONDS)
            self.blocked_until = time() + retry
            self.backoff_seconds = min(max(retry * 2, DEFAULT_BACKOFF_SECONDS), MAX_BACKOFF_SECONDS)
            raise BinanceRateLimitError(f"Binance HTTP {response.status_code}; cooldown {retry}s")
        response.raise_for_status()
        self.backoff_seconds = DEFAULT_BACKOFF_SECONDS
        return response.json()

    async def _cached_json(self, client: httpx.AsyncClient, key: str, ttl: int, path: str) -> Any:
        cached = self._cache.get(key)
        now = time()
        if cached and now - cached[0] < ttl:
            return cached[1]
        data = await self._request_json(client, path)
        self._cache[key] = (now, data)
        return data

    async def _load_klines(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
        symbol: str,
    ) -> list[dict[str, Any]]:
        async with semaphore:
            rows = await self._request_json(
                client,
                "/fapi/v1/klines",
                params={"symbol": symbol, "interval": "1h", "limit": HISTORY_LIMIT},
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
                    client,
                    "/futures/data/openInterestHist",
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
            current = best_by_base.get(base)
            if current is None or quote_volume > float(current["quote_volume"]):
                best_by_base[base] = {
                    "symbol": symbol,
                    "base_asset": base,
                    "quote_volume": quote_volume,
                }

        return sorted(
            best_by_base.values(),
            key=lambda row: float(row["quote_volume"]),
            reverse=True,
        )[:SCAN_POOL_LIMIT]

    async def _run_1h_scan(self) -> dict[str, Any]:
        started = perf_counter()
        self.last_started_at = datetime.now(timezone.utc).isoformat()
        timeout = httpx.Timeout(30.0, connect=10.0)

        try:
            async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "RakibTrade/1.0"}) as client:
                exchange = await self._cached_json(
                    client, "exchangeInfo", EXCHANGE_CACHE_SECONDS, "/fapi/v1/exchangeInfo"
                )
                tickers = await self._cached_json(
                    client, "ticker24h", TICKER_CACHE_SECONDS, "/fapi/v1/ticker/24hr"
                )
                book = await self._cached_json(
                    client, "bookTicker", BOOK_CACHE_SECONDS, "/fapi/v1/ticker/bookTicker"
                )

                ticker_map = {
                    str(item.get("symbol", "")): float(item.get("quoteVolume", 0) or 0)
                    for item in tickers
                }
                book_map = {str(item.get("symbol", "")): item for item in book}

                self._scan_pool = self._build_scan_pool(exchange, ticker_map)
                if not self._scan_pool:
                    raise RuntimeError("No eligible liquid USD-M perpetual contracts found")

                semaphore = asyncio.Semaphore(4)
                candle_results = await asyncio.gather(
                    *(self._load_klines(client, semaphore, str(row["symbol"])) for row in self._scan_pool),
                    return_exceptions=True,
                )

                trend_rows: list[dict[str, Any]] = []
                for row, candles in zip(self._scan_pool, candle_results):
                    if isinstance(candles, Exception):
                        if isinstance(candles, BinanceRateLimitError):
                            raise candles
                        continue
                    try:
                        analyzed = self.engine.analyze_trend({**row, "candles_1h": candles})
                        if analyzed:
                            trend_rows.append(analyzed)
                    except Exception:
                        continue
                self._trend_rows = trend_rows

                async def enrich(row: dict[str, Any]) -> dict[str, Any]:
                    symbol = str(row["symbol"])
                    oi_change = await self._load_oi_change(client, semaphore, symbol)
                    book_row = book_map.get(symbol) or {}
                    bid = float(book_row.get("bidPrice", 0) or 0)
                    ask = float(book_row.get("askPrice", 0) or 0)
                    mid = (bid + ask) / 2 if bid and ask else 0.0
                    spread_pct = ((ask - bid) / mid * 100) if mid else 999.0
                    return {**row, "oi_change_1h_pct": oi_change, "spread_pct": spread_pct}

                enriched = await asyncio.gather(*(enrich(row) for row in trend_rows))
                self._participation_rows = self.engine.rank_participation(enriched)
                self._top_rows = self._participation_rows[:TOP_LIMIT]

            result = self.engine.build_result(
                universe_symbols=[str(row["symbol"]) for row in self._scan_pool],
                trend_rows=self._trend_rows,
                participation_rows=self._participation_rows,
                top_rows=self._top_rows,
                started=started,
            )
            self.last_error = None
            self.last_candidate_count = int(result.get("candidate_count", 0))
            self.last_long_candidates = int(result.get("long_candidates", 0))
            self.last_short_candidates = int(result.get("short_candidates", 0))
            pipeline = result.get("pipeline") or {}
            self.last_scan_pool = int((pipeline.get("scan_pool") or {}).get("passed", 0))
            self.last_trend_passed = int((pipeline.get("trend_1h") or {}).get("passed", 0))
            self.last_top30 = int((pipeline.get("top_30") or {}).get("passed", 0))
            self.run_count += 1
            self.last_layer = "1H scan complete · Top30 locked"
            self._last_hour_slot = _hour_slot()
            try:
                await asyncio.to_thread(save_scanner_result, result)
            except Exception as exc:
                self.last_error = f"state save failed: {exc}"
            return result
        except Exception as exc:
            self.last_error = str(exc)
            raise
        finally:
            self.last_finished_at = datetime.now(timezone.utc).isoformat()

    async def run_scheduled(self) -> dict[str, Any] | None:
        if time() < self.blocked_until:
            self.last_layer = "Binance cooldown"
            return None

        current_slot = _hour_slot()
        first_scan = self.run_count == 0
        if not first_scan and current_slot == self._last_hour_slot:
            self.last_layer = "1H Top30 locked"
            return None

        return await self._run_1h_scan()

    async def run_once(self) -> dict[str, Any]:
        if time() < self.blocked_until:
            raise BinanceRateLimitError(
                f"Binance cooldown active; retry in {int(self.blocked_until - time())}s"
            )
        if self.run_count > 0 and _hour_slot() == self._last_hour_slot:
            self.last_layer = "1H Top30 locked"
            logs = __import__("app.strategies.scanner_engine", fromlist=["get_scanner_logs"]).get_scanner_logs()
            if logs:
                return logs[0]
        return await self._run_1h_scan()


scanner_worker = FuturesScannerWorker()
