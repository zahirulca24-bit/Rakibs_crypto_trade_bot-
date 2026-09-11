from __future__ import annotations

import asyncio
import json
from time import monotonic, time
from typing import Any, Awaitable, Callable

import httpx
import websockets

FUTURES_WS = "wss://fstream.binance.com/ws"
CACHE_LIMIT = 500
REST_CONCURRENCY = 2
REST_PACE_SECONDS = 0.15
SUBSCRIPTION_TTL_SECONDS = 2 * 60 * 60
SYNC_SECONDS = 2.0

INTERVAL_MS = {
    "1m": 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "1d": 24 * 60 * 60_000,
}

RequestJson = Callable[..., Awaitable[Any]]


class HybridFuturesMarketData:
    """REST warm-up + WebSocket closed-candle cache for Binance USD-M futures.

    Existing engines keep asking scanner_worker._request_json for klines. This
    service transparently intercepts only kline requests, serves fresh history
    from memory when available, and keeps that history current from Binance
    WebSocket closed-kline events. Non-kline requests continue unchanged.
    """

    def __init__(self) -> None:
        self._candles: dict[tuple[str, str], list[list[Any]]] = {}
        self._last_requested: dict[tuple[str, str], float] = {}
        self._rest_semaphore = asyncio.Semaphore(REST_CONCURRENCY)
        self._rest_pace_lock = asyncio.Lock()
        self._last_rest_at = 0.0
        self._task: asyncio.Task[None] | None = None
        self._running = False
        self._original_request: RequestJson | None = None
        self._installed_worker: Any = None
        self._connected = False
        self._last_error: str | None = None
        self._message_id = 0

    def install(self, worker: Any) -> None:
        if self._original_request is not None:
            return
        self._installed_worker = worker
        self._original_request = worker._request_json

        async def wrapped(
            client: httpx.AsyncClient,
            path: str,
            *,
            params: dict[str, Any] | None = None,
        ) -> Any:
            if path == "/fapi/v1/klines" and params:
                symbol = str(params.get("symbol", "")).upper()
                interval = str(params.get("interval", ""))
                limit = int(params.get("limit", 250) or 250)
                if symbol and interval in INTERVAL_MS:
                    return await self.klines(client, symbol, interval, limit)
            assert self._original_request is not None
            return await self._original_request(client, path, params=params)

        worker._request_json = wrapped

    def uninstall(self) -> None:
        if self._installed_worker is not None and self._original_request is not None:
            self._installed_worker._request_json = self._original_request
        self._installed_worker = None
        self._original_request = None

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._running = True
        self._task = asyncio.create_task(self._ws_loop(), name="binance-market-data-ws")

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self._connected = False
        self.uninstall()

    def status(self) -> dict[str, Any]:
        active = self._active_streams()
        return {
            "running": self._running,
            "websocket_connected": self._connected,
            "active_streams": len(active),
            "cached_series": len(self._candles),
            "last_error": self._last_error,
            "rest_concurrency": REST_CONCURRENCY,
            "rest_pace_seconds": REST_PACE_SECONDS,
        }

    async def klines(
        self,
        client: httpx.AsyncClient,
        symbol: str,
        interval: str,
        limit: int,
    ) -> list[list[Any]]:
        key = (symbol, interval)
        self._last_requested[key] = monotonic()
        cached = self._candles.get(key)
        if cached and len(cached) >= limit and self._is_fresh(cached, interval):
            return [list(row) for row in cached[-limit:]]

        async with self._rest_semaphore:
            cached = self._candles.get(key)
            if cached and len(cached) >= limit and self._is_fresh(cached, interval):
                return [list(row) for row in cached[-limit:]]

            await self._pace_rest()
            assert self._original_request is not None
            rows = await self._original_request(
                client,
                "/fapi/v1/klines",
                params={"symbol": symbol, "interval": interval, "limit": limit},
            )
            normalized = [list(row) for row in rows]
            self._candles[key] = normalized[-CACHE_LIMIT:]
            return [list(row) for row in normalized[-limit:]]

    async def _pace_rest(self) -> None:
        async with self._rest_pace_lock:
            elapsed = monotonic() - self._last_rest_at
            delay = REST_PACE_SECONDS - elapsed
            if delay > 0:
                await asyncio.sleep(delay)
            self._last_rest_at = monotonic()

    def _is_fresh(self, rows: list[list[Any]], interval: str) -> bool:
        if not rows:
            return False
        try:
            last_close_time = int(rows[-1][6])
        except (IndexError, TypeError, ValueError):
            return False
        max_age = INTERVAL_MS[interval] * 2
        return last_close_time >= int(time() * 1000) - max_age

    def _active_streams(self) -> set[str]:
        now = monotonic()
        stale = [
            key
            for key, requested_at in self._last_requested.items()
            if now - requested_at > SUBSCRIPTION_TTL_SECONDS
        ]
        for key in stale:
            self._last_requested.pop(key, None)
        return {
            f"{symbol.lower()}@kline_{interval}"
            for symbol, interval in self._last_requested
        }

    async def _ws_loop(self) -> None:
        while self._running:
            try:
                async with websockets.connect(
                    FUTURES_WS,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                    max_size=2_000_000,
                ) as socket:
                    self._connected = True
                    self._last_error = None
                    subscribed: set[str] = set()
                    while self._running:
                        desired = self._active_streams()
                        add = sorted(desired - subscribed)
                        remove = sorted(subscribed - desired)
                        if add:
                            await self._send_subscription(socket, "SUBSCRIBE", add)
                            subscribed.update(add)
                        if remove:
                            await self._send_subscription(socket, "UNSUBSCRIBE", remove)
                            subscribed.difference_update(remove)

                        try:
                            raw = await asyncio.wait_for(socket.recv(), timeout=SYNC_SECONDS)
                        except asyncio.TimeoutError:
                            continue
                        self._handle_ws_message(raw)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._connected = False
                self._last_error = str(exc)
                await asyncio.sleep(5)
            finally:
                self._connected = False

    async def _send_subscription(self, socket: Any, method: str, streams: list[str]) -> None:
        # Binance accepts up to 1024 streams per connection. Chunk control
        # messages so a changing scanner universe never creates a giant frame.
        for index in range(0, len(streams), 200):
            self._message_id += 1
            await socket.send(
                json.dumps(
                    {
                        "method": method,
                        "params": streams[index : index + 200],
                        "id": self._message_id,
                    }
                )
            )

    def _handle_ws_message(self, raw: Any) -> None:
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return
        if payload.get("e") != "kline":
            return
        kline = payload.get("k") or {}
        if not kline.get("x"):
            return
        symbol = str(payload.get("s", "")).upper()
        interval = str(kline.get("i", ""))
        if not symbol or interval not in INTERVAL_MS:
            return

        row: list[Any] = [
            int(kline["t"]),
            str(kline["o"]),
            str(kline["h"]),
            str(kline["l"]),
            str(kline["c"]),
            str(kline["v"]),
            int(kline["T"]),
            str(kline.get("q", "0")),
            int(kline.get("n", 0)),
            str(kline.get("V", "0")),
            str(kline.get("Q", "0")),
            "0",
        ]
        self._upsert((symbol, interval), row)

    def _upsert(self, key: tuple[str, str], row: list[Any]) -> None:
        rows = self._candles.setdefault(key, [])
        open_time = int(row[0])
        for index in range(len(rows) - 1, -1, -1):
            existing_open = int(rows[index][0])
            if existing_open == open_time:
                rows[index] = row
                break
            if existing_open < open_time:
                rows.insert(index + 1, row)
                break
        else:
            rows.insert(0, row)
        if len(rows) > CACHE_LIMIT:
            del rows[:-CACHE_LIMIT]


hybrid_market_data = HybridFuturesMarketData()
