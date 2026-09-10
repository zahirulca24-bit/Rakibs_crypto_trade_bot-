from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from time import perf_counter
from typing import Any

import httpx

from app.strategies.scanner_engine import (
    MIN_QUOTE_VOLUME,
    SCAN_POOL_LIMIT,
    TOP_LIMIT,
    ScannerEngine,
)

FUTURES_API = "https://fapi.binance.com"
FUTURES_DATA_API = "https://fapi.binance.com"
SCAN_INTERVAL_SECONDS = 60
HISTORY_LIMIT = 250
ALLOWED_QUOTES = {"USDT", "USDC"}
STABLE_BASES = {"USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "USD1", "USDE", "PYUSD", "BUSD"}


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
        return {
            "running": self.running and self.task is not None and not self.task.done(),
            "interval_seconds": SCAN_INTERVAL_SECONDS,
            "architecture": "1H trend -> OI/spread quality -> Top30 -> 15m setup -> 5m entry",
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
            "run_count": self.run_count,
        }

    async def _loop(self) -> None:
        while self.running:
            self.last_started_at = datetime.now(timezone.utc).isoformat()
            try:
                result = await self.run_once()
                self.last_error = None
                self.last_candidate_count = int(result.get("candidate_count", 0))
                self.last_long_candidates = int(result.get("long_candidates", 0))
                self.last_short_candidates = int(result.get("short_candidates", 0))
                pipeline = result.get("pipeline") or {}
                self.last_scan_pool = int((pipeline.get("scan_pool") or {}).get("passed", 0))
                self.last_trend_passed = int((pipeline.get("trend_1h") or {}).get("passed", 0))
                self.last_top30 = int((pipeline.get("top_30") or {}).get("passed", 0))
                self.run_count += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = str(exc)
            finally:
                self.last_finished_at = datetime.now(timezone.utc).isoformat()
            await asyncio.sleep(SCAN_INTERVAL_SECONDS)

    async def _load_klines(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
        symbol: str,
        interval: str,
    ) -> list[dict[str, Any]]:
        async with semaphore:
            response = await client.get(
                f"{FUTURES_API}/fapi/v1/klines",
                params={"symbol": symbol, "interval": interval, "limit": HISTORY_LIMIT},
            )
            response.raise_for_status()
            return _candles(response.json())

    async def _load_oi_change(self, client: httpx.AsyncClient, semaphore: asyncio.Semaphore, symbol: str) -> float:
        async with semaphore:
            try:
                response = await client.get(
                    f"{FUTURES_DATA_API}/futures/data/openInterestHist",
                    params={"symbol": symbol, "period": "1h", "limit": 2},
                )
                response.raise_for_status()
                rows = response.json()
                if len(rows) < 2:
                    return 0.0
                old = float(rows[-2].get("sumOpenInterest", 0) or 0)
                new = float(rows[-1].get("sumOpenInterest", 0) or 0)
                return ((new - old) / old * 100) if old else 0.0
            except Exception:
                return 0.0

    async def run_once(self) -> dict[str, Any]:
        started = perf_counter()
        timeout = httpx.Timeout(30.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "RakibTrade/1.0"}) as client:
            exchange_response, ticker_response, book_response = await asyncio.gather(
                client.get(f"{FUTURES_API}/fapi/v1/exchangeInfo"),
                client.get(f"{FUTURES_API}/fapi/v1/ticker/24hr"),
                client.get(f"{FUTURES_API}/fapi/v1/ticker/bookTicker"),
            )
            exchange_response.raise_for_status()
            ticker_response.raise_for_status()
            book_response.raise_for_status()

            exchange = exchange_response.json()
            ticker_map = {
                str(item.get("symbol", "")): float(item.get("quoteVolume", 0) or 0)
                for item in ticker_response.json()
            }
            book_map = {str(item.get("symbol", "")): item for item in book_response.json()}

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
                        "symbol": symbol,
                        "base_asset": base,
                        "quote_volume": quote_volume,
                    }

            unique_liquid = sorted(
                best_by_base.values(),
                key=lambda row: float(row["quote_volume"]),
                reverse=True,
            )
            scan_pool = unique_liquid[:SCAN_POOL_LIMIT]
            if not scan_pool:
                raise RuntimeError("No eligible liquid USD-M perpetual contracts found")

            semaphore = asyncio.Semaphore(10)

            async def trend_market(row: dict[str, Any]) -> dict[str, Any]:
                candles_1h = await self._load_klines(client, semaphore, str(row["symbol"]), "1h")
                return {**row, "candles_1h": candles_1h}

            trend_inputs = await asyncio.gather(*(trend_market(row) for row in scan_pool), return_exceptions=True)
            trend_rows: list[dict[str, Any]] = []
            for value in trend_inputs:
                if isinstance(value, Exception):
                    continue
                try:
                    analyzed = self.engine.analyze_trend(value)
                    if analyzed:
                        trend_rows.append(analyzed)
                except Exception:
                    continue

            if not trend_rows:
                return self.engine.build_result(
                    universe_symbols=[str(row["symbol"]) for row in scan_pool],
                    trend_rows=[],
                    participation_rows=[],
                    top_rows=[],
                    decisions=[],
                    started=started,
                )

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
            participation_rows = self.engine.rank_participation(enriched)
            top_rows = participation_rows[:TOP_LIMIT]

            async def load_setup_entry(row: dict[str, Any]) -> dict[str, Any]:
                symbol = str(row["symbol"])
                c15, c5 = await asyncio.gather(
                    self._load_klines(client, semaphore, symbol, "15m"),
                    self._load_klines(client, semaphore, symbol, "5m"),
                )
                return {**row, "candles_15m": c15, "candles_5m": c5}

            loaded = await asyncio.gather(*(load_setup_entry(row) for row in top_rows), return_exceptions=True)
            decisions: list[dict[str, Any]] = []
            loaded_map: dict[str, dict[str, Any]] = {}
            for value in loaded:
                if isinstance(value, Exception):
                    continue
                loaded_map[str(value["symbol"])] = value
            for row in top_rows:
                symbol = str(row["symbol"])
                loaded_row = loaded_map.get(symbol)
                if not loaded_row:
                    decisions.append({**row, "decision": "HOLD", "hold_reason": "15m/5m market data unavailable"})
                    continue
                try:
                    decisions.append(self.engine.evaluate_setup_entry(loaded_row))
                except Exception as exc:
                    decisions.append({**row, "decision": "HOLD", "hold_reason": f"evaluation error: {exc}"})

        return self.engine.build_result(
            universe_symbols=[str(row["symbol"]) for row in scan_pool],
            trend_rows=trend_rows,
            participation_rows=participation_rows,
            top_rows=top_rows,
            decisions=decisions,
            started=started,
        )


scanner_worker = FuturesScannerWorker()
