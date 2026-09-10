from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

import httpx

from app.strategies.scanner_engine import DEFAULT_MIN_VOLUME_RATIO, ScannerEngine

FUTURES_API = "https://fapi.binance.com"
SCAN_INTERVAL_SECONDS = 60
SCAN_POOL_LIMIT = 200
SCAN_LIMIT = 30
HISTORY_LIMIT = 500
MIN_QUOTE_VOLUME = 10_000_000
TIMEFRAME = "15m"
ALLOWED_QUOTES = {"USDT", "USDC"}
STABLE_BASES = {"USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "USD1", "USDE", "PYUSD", "BUSD"}


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
            "timeframe": TIMEFRAME,
            "scan_pool_limit": SCAN_POOL_LIMIT,
            "scan_limit": SCAN_LIMIT,
            "min_quote_volume": MIN_QUOTE_VOLUME,
            "min_volume_ratio": DEFAULT_MIN_VOLUME_RATIO,
            "last_started_at": self.last_started_at,
            "last_finished_at": self.last_finished_at,
            "last_error": self.last_error,
            "last_candidate_count": self.last_candidate_count,
            "last_long_candidates": self.last_long_candidates,
            "last_short_candidates": self.last_short_candidates,
            "run_count": self.run_count,
        }

    async def _loop(self) -> None:
        while self.running:
            self.last_started_at = datetime.now(timezone.utc).isoformat()
            try:
                result = await self._run_once()
                self.last_error = None
                self.last_candidate_count = int(result.get("candidate_count", 0))
                self.last_long_candidates = int(result.get("long_candidates", 0))
                self.last_short_candidates = int(result.get("short_candidates", 0))
                self.run_count += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = str(exc)
            finally:
                self.last_finished_at = datetime.now(timezone.utc).isoformat()
            await asyncio.sleep(SCAN_INTERVAL_SECONDS)

    async def _run_once(self) -> dict[str, Any]:
        timeout = httpx.Timeout(25.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "RakibTrade/1.0"}) as client:
            exchange_response, ticker_response = await asyncio.gather(
                client.get(f"{FUTURES_API}/fapi/v1/exchangeInfo"),
                client.get(f"{FUTURES_API}/fapi/v1/ticker/24hr"),
            )
            exchange_response.raise_for_status()
            ticker_response.raise_for_status()
            exchange = exchange_response.json()
            tickers = ticker_response.json()
            ticker_map = {str(item.get("symbol", "")): float(item.get("quoteVolume", 0) or 0) for item in tickers}

            best_by_base: dict[str, dict[str, Any]] = {}
            for symbol_info in exchange.get("symbols", []):
                if symbol_info.get("status") != "TRADING":
                    continue
                if symbol_info.get("contractType") != "PERPETUAL":
                    continue
                quote_asset = str(symbol_info.get("quoteAsset", ""))
                base_asset = str(symbol_info.get("baseAsset", ""))
                symbol = str(symbol_info.get("symbol", ""))
                if quote_asset not in ALLOWED_QUOTES or base_asset in STABLE_BASES or not symbol:
                    continue
                quote_volume = ticker_map.get(symbol, 0.0)
                existing = best_by_base.get(base_asset)
                if existing is None or quote_volume > float(existing["quote_volume"]):
                    best_by_base[base_asset] = {
                        "symbol": symbol,
                        "base_asset": base_asset,
                        "quote_volume": quote_volume,
                    }

            unique_rows = sorted(best_by_base.values(), key=lambda row: float(row["quote_volume"]), reverse=True)
            scan_pool = unique_rows[:SCAN_POOL_LIMIT]
            liquid = [row for row in scan_pool if float(row["quote_volume"]) >= MIN_QUOTE_VOLUME]
            top_rows = liquid[:SCAN_LIMIT]
            if not top_rows:
                raise RuntimeError("No eligible USD-M perpetual futures contracts found")

            semaphore = asyncio.Semaphore(5)

            async def load_market(row: dict[str, Any]) -> dict[str, Any]:
                async with semaphore:
                    response = await client.get(
                        f"{FUTURES_API}/fapi/v1/klines",
                        params={"symbol": row["symbol"], "interval": TIMEFRAME, "limit": HISTORY_LIMIT},
                    )
                    response.raise_for_status()
                    candles = [
                        {
                            "open_time": int(item[0]),
                            "open": str(item[1]),
                            "high": str(item[2]),
                            "low": str(item[3]),
                            "close": str(item[4]),
                            "volume": str(item[5]),
                            "close_time": int(item[6]),
                        }
                        for item in response.json()
                    ]
                    return {"symbol": row["symbol"], "quote_volume": row["quote_volume"], "candles": candles}

            markets = await asyncio.gather(*(load_market(row) for row in top_rows))

        return await asyncio.to_thread(
            self.engine.scan,
            markets,
            TIMEFRAME,
            MIN_QUOTE_VOLUME,
            DEFAULT_MIN_VOLUME_RATIO,
        )


scanner_worker = FuturesScannerWorker()
