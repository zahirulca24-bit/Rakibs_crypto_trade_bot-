from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from time import perf_counter, time
from typing import Any

import httpx

from app.services.scanner_worker import BinanceRateLimitError, FUTURES_API, scanner_worker
from app.strategies.scanner_engine import get_scanner_logs
from app.strategies.strategy_engine import StrategyEngine, get_strategy_logs

LOOP_TICK_SECONDS = 30
HISTORY_LIMIT = 250
FIFTEEN_MINUTES_MS = 15 * 60_000


def _slot_15m() -> int:
    return int(time() * 1000) // FIFTEEN_MINUTES_MS


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


class StrategyWorker:
    def __init__(self) -> None:
        self.engine = StrategyEngine()
        self.task: asyncio.Task[None] | None = None
        self.running = False
        self.last_started_at: str | None = None
        self.last_finished_at: str | None = None
        self.last_error: str | None = None
        self.last_layer = "waiting for Scanner Top30"
        self.run_count = 0
        self.last_input_count = 0
        self.last_pass_count = 0
        self.last_hold_count = 0
        self.last_long_pass = 0
        self.last_short_pass = 0
        self._last_slot = -1
        self._last_scanner_timestamp: str | None = None
        self._run_lock = asyncio.Lock()

    async def start(self) -> None:
        if self.task and not self.task.done():
            return
        self.running = True
        self.task = asyncio.create_task(self._loop(), name="strategy-worker")

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
        scanner_status = scanner_worker.status()
        return {
            "running": self.running and self.task is not None and not self.task.done(),
            "architecture": "Scanner Top30 -> 15m Strategy PASS/HOLD",
            "schedule": "each new closed 15m candle",
            "last_started_at": self.last_started_at,
            "last_finished_at": self.last_finished_at,
            "last_error": self.last_error,
            "last_layer": self.last_layer,
            "run_count": self.run_count,
            "last_input_count": self.last_input_count,
            "last_pass_count": self.last_pass_count,
            "last_hold_count": self.last_hold_count,
            "last_long_pass": self.last_long_pass,
            "last_short_pass": self.last_short_pass,
            "waiting_for_scanner_cooldown": bool(scanner_status.get("rate_limited")),
            "scanner_retry_in_seconds": int(scanner_status.get("retry_in_seconds", 0) or 0),
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

    async def _load_15m(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
        symbol: str,
    ) -> list[dict[str, Any]]:
        async with semaphore:
            rows = await scanner_worker._request_json(
                client,
                "/fapi/v1/klines",
                params={"symbol": symbol, "interval": "15m", "limit": HISTORY_LIMIT},
            )
            return _candles(rows)

    async def _run(self) -> dict[str, Any] | None:
        async with self._run_lock:
            scanner_logs = get_scanner_logs()
            if not scanner_logs:
                self.last_layer = "waiting for Scanner Top30"
                return None

            scanner_result = scanner_logs[0]
            candidates = list(scanner_result.get("candidates") or [])
            scanner_timestamp = str(scanner_result.get("timestamp", ""))
            if not candidates:
                self.last_layer = "Scanner Top30 empty"
                return None

            started = perf_counter()
            self.last_started_at = datetime.now(timezone.utc).isoformat()
            timeout = httpx.Timeout(30.0, connect=10.0)

            try:
                semaphore = asyncio.Semaphore(3)
                async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": "RakibTrade/1.0"}) as client:
                    candle_results = await asyncio.gather(
                        *(self._load_15m(client, semaphore, str(row["symbol"])) for row in candidates),
                        return_exceptions=True,
                    )

                rows: list[dict[str, Any]] = []
                for scanner_row, candles in zip(candidates, candle_results):
                    if isinstance(candles, Exception):
                        if isinstance(candles, BinanceRateLimitError):
                            raise candles
                        rows.append(
                            {
                                "symbol": scanner_row.get("symbol"),
                                "side": scanner_row.get("side"),
                                "status": "HOLD",
                                "score": 0,
                                "scanner_score": scanner_row.get("score"),
                                "reasons": [],
                                "hold_reasons": [f"15m data error: {candles}"],
                            }
                        )
                        continue
                    try:
                        rows.append(self.engine.analyze(scanner_row, candles))
                    except Exception as exc:
                        rows.append(
                            {
                                "symbol": scanner_row.get("symbol"),
                                "side": scanner_row.get("side"),
                                "status": "HOLD",
                                "score": 0,
                                "scanner_score": scanner_row.get("score"),
                                "reasons": [],
                                "hold_reasons": [str(exc)],
                            }
                        )

                result = self.engine.build_result(scanner_timestamp, rows, started)
                self.last_input_count = int(result["input_count"])
                self.last_pass_count = int(result["pass_count"])
                self.last_hold_count = int(result["hold_count"])
                self.last_long_pass = int(result["long_pass"])
                self.last_short_pass = int(result["short_pass"])
                self.run_count += 1
                self._last_slot = _slot_15m()
                self._last_scanner_timestamp = scanner_timestamp
                self.last_error = None
                self.last_layer = "15m Strategy complete"
                return result
            except Exception as exc:
                self.last_error = str(exc)
                self.last_layer = "15m Strategy error"
                raise
            finally:
                self.last_finished_at = datetime.now(timezone.utc).isoformat()

    async def run_scheduled(self) -> dict[str, Any] | None:
        scanner_status = scanner_worker.status()
        if scanner_status.get("rate_limited"):
            self.last_layer = "waiting for Scanner Binance cooldown"
            return None

        scanner_logs = get_scanner_logs()
        if not scanner_logs:
            self.last_layer = "waiting for Scanner Top30"
            return None

        scanner_timestamp = str(scanner_logs[0].get("timestamp", ""))
        current_slot = _slot_15m()

        if self.run_count > 0 and current_slot == self._last_slot and scanner_timestamp == self._last_scanner_timestamp:
            self.last_layer = "15m result locked"
            return None

        return await self._run()

    async def run_once(self) -> dict[str, Any]:
        scanner_status = scanner_worker.status()
        if scanner_status.get("rate_limited"):
            raise BinanceRateLimitError(
                f"Binance cooldown active; retry in {int(scanner_status.get('retry_in_seconds', 0) or 0)}s"
            )
        result = await self._run()
        if result is not None:
            return result
        logs = get_strategy_logs()
        if logs:
            return logs[0]
        raise RuntimeError("No Scanner Top30 available for Strategy Engine")


strategy_worker = StrategyWorker()
