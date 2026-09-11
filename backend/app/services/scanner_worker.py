from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from time import perf_counter, time
from typing import Any

from app.services.futures_market_data import BinanceRateLimitError, market_data_hub
from app.services.state_store import ensure_state_schema, load_scanner_result, save_scanner_result
from app.strategies.scanner_engine import (
    MIN_QUOTE_VOLUME,
    SCAN_POOL_LIMIT,
    TOP_LIMIT,
    ScannerEngine,
    restore_scanner_result,
)

LOOP_TICK_SECONDS = 30
HISTORY_LIMIT = 250
ALLOWED_QUOTES = {"USDT", "USDC"}
STABLE_BASES = {"USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "USD1", "USDE", "PYUSD", "BUSD"}

EXCHANGE_CACHE_SECONDS = 6 * 60 * 60
TICKER_CACHE_SECONDS = 5 * 60
BOOK_CACHE_SECONDS = 60
ONE_HOUR_MS = 60 * 60_000


def _hour_slot() -> int:
    return int(time() * 1000) // ONE_HOUR_MS


class ScannerBusyError(RuntimeError):
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

        self.last_layer = "startup ready"
        self._scan_pool: list[dict[str, Any]] = []
        self._trend_rows: list[dict[str, Any]] = []
        self._participation_rows: list[dict[str, Any]] = []
        self._top_rows: list[dict[str, Any]] = []
        self._last_hour_slot = -1
        self._run_lock = asyncio.Lock()

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

            # Warm-start display state only. A restart still schedules one fresh 1H scan.
            self._last_hour_slot = -1
            self.last_layer = "restored 1H Top30 · fresh scan pending"

            restored_symbols = [
                str(row.get("symbol"))
                for row in list(result.get("candidates") or [])
                if row.get("symbol")
            ]
            await market_data_hub.set_stream_symbols("15m", restored_symbols)
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
        market_status = market_data_hub.status()
        wait = int(market_status.get("retry_in_seconds", 0) or 0)
        now_slot = _hour_slot()
        next_hour_seconds = max(0, int(((now_slot + 1) * ONE_HOUR_MS / 1000) - time()))
        scan_due_now = self._last_hour_slot != now_slot
        return {
            "running": self.running and self.task is not None and not self.task.done(),
            "scan_in_progress": self._run_lock.locked(),
            "interval_seconds": LOOP_TICK_SECONDS,
            "architecture": "1H Scanner -> Top 30 -> 15m -> 5m",
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
            "rate_limited": bool(market_status.get("rate_limited")),
            "retry_in_seconds": wait,
            "next_scan_in_seconds": wait if wait > 0 else (0 if scan_due_now else next_hour_seconds),
            "run_count": self.run_count,
            "data_mode": market_status.get("mode"),
            "websocket_connected": market_status.get("websocket_connected"),
            "websocket_streams": market_status.get("websocket_streams"),
            "websocket_last_error": market_status.get("websocket_last_error"),
            "rest_used_weight_1m": market_status.get("rest_used_weight_1m"),
            "rest_request_count": market_status.get("rest_request_count"),
            "history_cache_hits": market_status.get("history_cache_hits"),
            "cached_series": market_status.get("cached_series"),
            "last_rate_limit_status": market_status.get("last_rate_limit_status"),
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

    async def _execute_1h_scan(self) -> dict[str, Any]:
        started = perf_counter()
        self.last_started_at = datetime.now(timezone.utc).isoformat()

        try:
            exchange = await market_data_hub.cached_json(
                "exchangeInfo",
                EXCHANGE_CACHE_SECONDS,
                "/fapi/v1/exchangeInfo",
            )
            tickers = await market_data_hub.cached_json(
                "ticker24h",
                TICKER_CACHE_SECONDS,
                "/fapi/v1/ticker/24hr",
            )
            book = await market_data_hub.cached_json(
                "bookTicker",
                BOOK_CACHE_SECONDS,
                "/fapi/v1/ticker/bookTicker",
            )

            ticker_map = {
                str(item.get("symbol", "")): float(item.get("quoteVolume", 0) or 0)
                for item in tickers
            }
            book_map = {str(item.get("symbol", "")): item for item in book}

            self._scan_pool = self._build_scan_pool(exchange, ticker_map)
            if not self._scan_pool:
                raise RuntimeError("No eligible liquid USD-M perpetual contracts found")

            candle_results = await asyncio.gather(
                *(
                    market_data_hub.get_klines(
                        str(row["symbol"]),
                        "1h",
                        HISTORY_LIMIT,
                    )
                    for row in self._scan_pool
                ),
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
                oi_change = await market_data_hub.get_oi_change(symbol)
                book_row = book_map.get(symbol) or {}
                bid = float(book_row.get("bidPrice", 0) or 0)
                ask = float(book_row.get("askPrice", 0) or 0)
                mid = (bid + ask) / 2 if bid and ask else 0.0
                spread_pct = ((ask - bid) / mid * 100) if mid else 999.0
                return {**row, "oi_change_1h_pct": oi_change, "spread_pct": spread_pct}

            enriched = await asyncio.gather(
                *(enrich(row) for row in trend_rows),
                return_exceptions=True,
            )
            participation_input: list[dict[str, Any]] = []
            for item in enriched:
                if isinstance(item, Exception):
                    if isinstance(item, BinanceRateLimitError):
                        raise item
                    continue
                participation_input.append(item)

            self._participation_rows = self.engine.rank_participation(participation_input)
            self._top_rows = self._participation_rows[:TOP_LIMIT]

            top_symbols = [str(row["symbol"]) for row in self._top_rows]
            await market_data_hub.set_stream_symbols("15m", top_symbols)

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
            self.last_layer = "1H scan complete · Top30 updated"
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

    async def _run_1h_scan(self) -> dict[str, Any]:
        async with self._run_lock:
            return await self._execute_1h_scan()

    async def run_scheduled(self) -> dict[str, Any] | None:
        market_status = market_data_hub.status()
        if market_status.get("rate_limited"):
            self.last_layer = "Binance cooldown"
            return None

        if self._run_lock.locked():
            self.last_layer = "1H scan already running"
            return None

        current_slot = _hour_slot()
        first_scan = self.run_count == 0
        if not first_scan and current_slot == self._last_hour_slot:
            self.last_layer = "1H auto schedule waiting"
            return None

        return await self._run_1h_scan()

    async def run_once(self) -> dict[str, Any]:
        market_status = market_data_hub.status()
        if market_status.get("rate_limited"):
            raise BinanceRateLimitError(
                int(market_status.get("last_rate_limit_status") or 429),
                int(market_status.get("retry_in_seconds", 1) or 1),
            )
        if self._run_lock.locked():
            raise ScannerBusyError("Scanner run already in progress")
        return await self._run_1h_scan()


scanner_worker = FuturesScannerWorker()
