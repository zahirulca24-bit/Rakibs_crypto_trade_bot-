from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from time import perf_counter, time
from typing import Any

import httpx

from app.services.scanner_worker import BinanceRateLimitError, scanner_worker
from app.strategies.entry_engine import EntryEngine, get_entry_logs
from app.strategies.strategy_engine import get_strategy_logs

LOOP_TICK_SECONDS = 30
HISTORY_LIMIT = 250
FIVE_MINUTES_MS = 5 * 60_000


def _slot_5m() -> int:
    return int(time() * 1000) // FIVE_MINUTES_MS


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


class EntryWorker:
    def __init__(self) -> None:
        self.engine = EntryEngine()
        self.task: asyncio.Task[None] | None = None
        self.running = False
        self.last_started_at: str | None = None
        self.last_finished_at: str | None = None
        self.last_error: str | None = None
        self.last_layer = "waiting for 15m PASS setup"
        self.run_count = 0
        self.last_input_count = 0
        self.last_entry_count = 0
        self.last_hold_count = 0
        self.last_long_entry = 0
        self.last_short_entry = 0
        self._last_slot = -1
        self._last_strategy_timestamp: str | None = None
        self._run_lock = asyncio.Lock()

    async def start(self) -> None:
        if self.task and not self.task.done():
            return
        self.running = True
        self.task = asyncio.create_task(self._loop(), name="entry-worker")

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
            "architecture": "15m PASS -> 5m Entry ENTRY/HOLD",
            "schedule": "each new closed 5m candle",
            "last_started_at": self.last_started_at,
            "last_finished_at": self.last_finished_at,
            "last_error": self.last_error,
            "last_layer": self.last_layer,
            "run_count": self.run_count,
            "last_input_count": self.last_input_count,
            "last_entry_count": self.last_entry_count,
            "last_hold_count": self.last_hold_count,
            "last_long_entry": self.last_long_entry,
            "last_short_entry": self.last_short_entry,
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

    async def _load_5m(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
        symbol: str,
    ) -> list[dict[str, Any]]:
        async with semaphore:
            rows = await scanner_worker._request_json(
                client,
                "/fapi/v1/klines",
                params={"symbol": symbol, "interval": "5m", "limit": HISTORY_LIMIT},
            )
            return _candles(rows)

    async def _run(self) -> dict[str, Any] | None:
        async with self._run_lock:
            strategy_logs = get_strategy_logs()
            if not strategy_logs:
                self.last_layer = "waiting for 15m Strategy result"
                return None

            strategy_result = strategy_logs[0]
            strategy_timestamp = str(strategy_result.get("timestamp", ""))
            pass_rows = [
                row
                for row in list(strategy_result.get("rows") or [])
                if row.get("status") == "PASS"
            ]

            started = perf_counter()
            self.last_started_at = datetime.now(timezone.utc).isoformat()

            try:
                rows: list[dict[str, Any]] = []
                if pass_rows:
                    timeout = httpx.Timeout(30.0, connect=10.0)
                    semaphore = asyncio.Semaphore(3)
                    async with httpx.AsyncClient(
                        timeout=timeout,
                        headers={"User-Agent": "RakibTrade/1.0"},
                    ) as client:
                        candle_results = await asyncio.gather(
                            *(
                                self._load_5m(client, semaphore, str(row["symbol"]))
                                for row in pass_rows
                            ),
                            return_exceptions=True,
                        )

                    for strategy_row, candles in zip(pass_rows, candle_results):
                        if isinstance(candles, Exception):
                            if isinstance(candles, BinanceRateLimitError):
                                raise candles
                            rows.append(
                                {
                                    "symbol": strategy_row.get("symbol"),
                                    "side": strategy_row.get("side"),
                                    "status": "HOLD",
                                    "score": 0,
                                    "strategy_score": strategy_row.get("score"),
                                    "reasons": [],
                                    "hold_reasons": [f"5m data error: {candles}"],
                                }
                            )
                            continue
                        try:
                            rows.append(self.engine.analyze(strategy_row, candles))
                        except Exception as exc:
                            rows.append(
                                {
                                    "symbol": strategy_row.get("symbol"),
                                    "side": strategy_row.get("side"),
                                    "status": "HOLD",
                                    "score": 0,
                                    "strategy_score": strategy_row.get("score"),
                                    "reasons": [],
                                    "hold_reasons": [str(exc)],
                                }
                            )

                result = self.engine.build_result(strategy_timestamp, rows, started)
                self.last_input_count = int(result["input_count"])
                self.last_entry_count = int(result["entry_count"])
                self.last_hold_count = int(result["hold_count"])
                self.last_long_entry = int(result["long_entry"])
                self.last_short_entry = int(result["short_entry"])
                self.run_count += 1
                self._last_slot = _slot_5m()
                self._last_strategy_timestamp = strategy_timestamp
                self.last_error = None
                self.last_layer = (
                    "5m Entry complete"
                    if pass_rows
                    else "15m PASS empty · 5m Entry complete"
                )
                return result
            except Exception as exc:
                self.last_error = str(exc)
                self.last_layer = "5m Entry error"
                raise
            finally:
                self.last_finished_at = datetime.now(timezone.utc).isoformat()

    async def run_scheduled(self) -> dict[str, Any] | None:
        scanner_status = scanner_worker.status()
        if scanner_status.get("rate_limited"):
            self.last_layer = "waiting for Scanner Binance cooldown"
            return None

        strategy_logs = get_strategy_logs()
        if not strategy_logs:
            self.last_layer = "waiting for 15m Strategy result"
            return None

        strategy_timestamp = str(strategy_logs[0].get("timestamp", ""))
        current_slot = _slot_5m()

        if (
            self.run_count > 0
            and current_slot == self._last_slot
            and strategy_timestamp == self._last_strategy_timestamp
        ):
            self.last_layer = "5m result locked"
            return None

        return await self._run()


entry_worker = EntryWorker()
