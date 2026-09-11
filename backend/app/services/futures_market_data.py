from __future__ import annotations

import asyncio
import json
from email.utils import parsedate_to_datetime
from time import time
from typing import Any

import httpx
import websockets

FUTURES_API = "https://fapi.binance.com"
WS_MARKET_URL = "wss://fstream.binance.com/market/stream"

MAX_CACHED_CANDLES = 320
REST_MIN_INTERVAL_SECONDS = 0.15
REST_SOFT_WEIGHT_LIMIT = 1800
DEFAULT_429_BACKOFF_SECONDS = 60
DEFAULT_418_BACKOFF_SECONDS = 5 * 60
MAX_BACKOFF_SECONDS = 60 * 60
WS_RECONNECT_SECONDS = 5
WS_SYNC_SECONDS = 2
WS_SUBSCRIPTION_BATCH = 100

INTERVAL_MS = {
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
}


class BinanceRateLimitError(RuntimeError):
    def __init__(self, status_code: int, retry_seconds: int) -> None:
        self.status_code = status_code
        self.retry_seconds = retry_seconds
        super().__init__(f"Binance HTTP {status_code}; retry in {retry_seconds}s")


def _normalize_candle(row: list[Any]) -> dict[str, Any]:
    return {
        "open_time": int(row[0]),
        "open": str(row[1]),
        "high": str(row[2]),
        "low": str(row[3]),
        "close": str(row[4]),
        "volume": str(row[5]),
        "close_time": int(row[6]),
    }


def _merge_candles(
    current: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
    *,
    max_items: int = MAX_CACHED_CANDLES,
) -> list[dict[str, Any]]:
    now_ms = int(time() * 1000)
    merged: dict[int, dict[str, Any]] = {}
    for candle in [*current, *incoming]:
        try:
            open_time = int(candle["open_time"])
            close_time = int(candle["close_time"])
        except (KeyError, TypeError, ValueError):
            continue
        if close_time > now_ms:
            continue
        merged[open_time] = candle
    rows = [merged[key] for key in sorted(merged)]
    return rows[-max_items:]


def _latest_expected_close(interval: str, now_ms: int | None = None) -> int:
    interval_ms = INTERVAL_MS[interval]
    stamp = int(time() * 1000) if now_ms is None else now_ms
    current_slot_start = (stamp // interval_ms) * interval_ms
    return current_slot_start - 1


class FuturesMarketDataHub:
    """Hybrid Binance USD-M public market-data collector.

    REST is used for history/bootstrap and low-frequency metadata/OI calls.
    WebSocket kline streams maintain 15m/5m caches after bootstrap so repeated
    downstream engine runs do not refetch full candle history.
    """

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._rest_lock = asyncio.Lock()
        self._last_rest_at = 0.0
        self._last_weight_minute = -1
        self._last_used_weight_1m = 0
        self._rest_request_count = 0
        self._rest_history_bootstraps = 0
        self._rest_history_refreshes = 0
        self._history_cache_hits = 0

        self.blocked_until = 0.0
        self.last_rate_limit_status: int | None = None

        self._json_cache: dict[str, tuple[float, Any]] = {}
        self._candles: dict[tuple[str, str], list[dict[str, Any]]] = {}

        self._desired_by_interval: dict[str, set[str]] = {"15m": set(), "5m": set()}
        self._desired_changed = asyncio.Event()
        self._ws_task: asyncio.Task[None] | None = None
        self._ws_running = False
        self._ws_connected = False
        self._ws_subscribed: set[str] = set()
        self._ws_request_id = 0
        self._ws_messages = 0
        self._last_ws_error: str | None = None

    async def start(self) -> None:
        if self._client is None:
            timeout = httpx.Timeout(30.0, connect=10.0)
            self._client = httpx.AsyncClient(
                timeout=timeout,
                headers={"User-Agent": "RakibTrade/2.0"},
            )
        if self._ws_task and not self._ws_task.done():
            return
        self._ws_running = True
        self._ws_task = asyncio.create_task(self._ws_loop(), name="binance-market-ws")

    async def stop(self) -> None:
        self._ws_running = False
        self._desired_changed.set()
        if self._ws_task:
            self._ws_task.cancel()
            try:
                await self._ws_task
            except asyncio.CancelledError:
                pass
            self._ws_task = None
        self._ws_connected = False
        self._ws_subscribed.clear()
        if self._client:
            await self._client.aclose()
            self._client = None

    def status(self) -> dict[str, Any]:
        retry = max(0, int(self.blocked_until - time()))
        return {
            "mode": "REST bootstrap/cache + WebSocket live candles",
            "rate_limited": retry > 0,
            "retry_in_seconds": retry,
            "last_rate_limit_status": self.last_rate_limit_status,
            "rest_used_weight_1m": self._last_used_weight_1m,
            "rest_request_count": self._rest_request_count,
            "rest_history_bootstraps": self._rest_history_bootstraps,
            "rest_history_refreshes": self._rest_history_refreshes,
            "history_cache_hits": self._history_cache_hits,
            "websocket_connected": self._ws_connected,
            "websocket_streams": len(self._ws_subscribed),
            "websocket_messages": self._ws_messages,
            "websocket_last_error": self._last_ws_error,
            "cached_series": len(self._candles),
        }

    async def set_stream_symbols(self, interval: str, symbols: list[str]) -> None:
        if interval not in self._desired_by_interval:
            return
        normalized = {str(symbol).upper() for symbol in symbols if symbol}
        if normalized == self._desired_by_interval[interval]:
            return
        self._desired_by_interval[interval] = normalized
        self._desired_changed.set()

    def _desired_streams(self) -> set[str]:
        streams: set[str] = set()
        for interval, symbols in self._desired_by_interval.items():
            streams.update(f"{symbol.lower()}@kline_{interval}" for symbol in symbols)
        return streams

    def _retry_after_seconds(self, response: httpx.Response) -> int:
        raw = response.headers.get("Retry-After")
        if raw:
            try:
                return max(1, int(float(raw)))
            except ValueError:
                try:
                    dt = parsedate_to_datetime(raw)
                    return max(1, int(dt.timestamp() - time()))
                except Exception:
                    pass
        return (
            DEFAULT_418_BACKOFF_SECONDS
            if response.status_code == 418
            else DEFAULT_429_BACKOFF_SECONDS
        )

    async def _pace_rest(self) -> None:
        now = time()
        minute = int(now // 60)
        if minute != self._last_weight_minute:
            self._last_weight_minute = minute
            self._last_used_weight_1m = 0

        if self._last_used_weight_1m >= REST_SOFT_WEIGHT_LIMIT:
            next_minute = ((minute + 1) * 60) + 1
            await asyncio.sleep(max(0.0, next_minute - time()))
            self._last_weight_minute = int(time() // 60)
            self._last_used_weight_1m = 0

        spacing = REST_MIN_INTERVAL_SECONDS - (time() - self._last_rest_at)
        if spacing > 0:
            await asyncio.sleep(spacing)

    async def request_json(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> Any:
        if self._client is None:
            await self.start()

        if time() < self.blocked_until:
            raise BinanceRateLimitError(
                self.last_rate_limit_status or 429,
                max(1, int(self.blocked_until - time())),
            )

        async with self._rest_lock:
            if time() < self.blocked_until:
                raise BinanceRateLimitError(
                    self.last_rate_limit_status or 429,
                    max(1, int(self.blocked_until - time())),
                )

            await self._pace_rest()
            assert self._client is not None
            response = await self._client.get(FUTURES_API + path, params=params)
            self._last_rest_at = time()
            self._rest_request_count += 1

            raw_weight = response.headers.get("X-MBX-USED-WEIGHT-1M")
            if raw_weight:
                try:
                    self._last_used_weight_1m = int(raw_weight)
                    self._last_weight_minute = int(time() // 60)
                except ValueError:
                    pass

            if response.status_code in {418, 429}:
                retry = min(self._retry_after_seconds(response), MAX_BACKOFF_SECONDS)
                self.blocked_until = time() + retry
                self.last_rate_limit_status = response.status_code
                raise BinanceRateLimitError(response.status_code, retry)

            response.raise_for_status()
            self.last_rate_limit_status = None
            return response.json()

    async def cached_json(self, key: str, ttl_seconds: int, path: str) -> Any:
        cached = self._json_cache.get(key)
        now = time()
        if cached and now - cached[0] < ttl_seconds:
            return cached[1]
        data = await self.request_json(path)
        self._json_cache[key] = (now, data)
        return data

    def _history_is_fresh(self, symbol: str, interval: str, limit: int) -> bool:
        rows = self._candles.get((symbol.upper(), interval)) or []
        if len(rows) < limit:
            return False
        return int(rows[-1].get("close_time", 0) or 0) >= _latest_expected_close(interval)

    async def get_klines(
        self,
        symbol: str,
        interval: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        normalized = symbol.upper()
        key = (normalized, interval)
        rows = self._candles.get(key) or []

        if self._history_is_fresh(normalized, interval, limit):
            self._history_cache_hits += 1
            return list(rows[-limit:])

        if len(rows) >= limit:
            fetch_limit = 3
            self._rest_history_refreshes += 1
        else:
            fetch_limit = max(limit, 250)
            self._rest_history_bootstraps += 1

        payload = await self.request_json(
            "/fapi/v1/klines",
            params={"symbol": normalized, "interval": interval, "limit": fetch_limit},
        )
        incoming = [_normalize_candle(item) for item in payload]
        merged = _merge_candles(rows, incoming)
        self._candles[key] = merged
        return list(merged[-limit:])

    async def get_oi_change(self, symbol: str) -> float:
        try:
            rows = await self.request_json(
                "/futures/data/openInterestHist",
                params={"symbol": symbol.upper(), "period": "1h", "limit": 2},
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

    async def _send_subscription_batches(
        self,
        websocket: Any,
        method: str,
        streams: set[str],
    ) -> None:
        ordered = sorted(streams)
        for index in range(0, len(ordered), WS_SUBSCRIPTION_BATCH):
            batch = ordered[index : index + WS_SUBSCRIPTION_BATCH]
            self._ws_request_id += 1
            await websocket.send(
                json.dumps(
                    {
                        "method": method,
                        "params": batch,
                        "id": self._ws_request_id,
                    }
                )
            )
            await asyncio.sleep(0.15)

    async def _sync_subscriptions(self, websocket: Any) -> None:
        desired = self._desired_streams()
        to_unsubscribe = self._ws_subscribed - desired
        to_subscribe = desired - self._ws_subscribed

        if to_unsubscribe:
            await self._send_subscription_batches(websocket, "UNSUBSCRIBE", to_unsubscribe)
            self._ws_subscribed.difference_update(to_unsubscribe)

        if to_subscribe:
            await self._send_subscription_batches(websocket, "SUBSCRIBE", to_subscribe)
            self._ws_subscribed.update(to_subscribe)

        self._desired_changed.clear()

    def _handle_ws_message(self, message: str) -> None:
        payload = json.loads(message)
        data = payload.get("data", payload)
        if not isinstance(data, dict) or data.get("e") != "kline":
            return

        kline = data.get("k") or {}
        if not kline.get("x"):
            return

        symbol = str(kline.get("s") or data.get("s") or "").upper()
        interval = str(kline.get("i") or "")
        if not symbol or interval not in INTERVAL_MS:
            return

        candle = {
            "open_time": int(kline["t"]),
            "open": str(kline["o"]),
            "high": str(kline["h"]),
            "low": str(kline["l"]),
            "close": str(kline["c"]),
            "volume": str(kline["v"]),
            "close_time": int(kline["T"]),
        }
        key = (symbol, interval)
        self._candles[key] = _merge_candles(self._candles.get(key) or [], [candle])
        self._ws_messages += 1

    async def _ws_loop(self) -> None:
        while self._ws_running:
            desired = self._desired_streams()
            if not desired:
                self._ws_connected = False
                try:
                    await asyncio.wait_for(self._desired_changed.wait(), timeout=WS_SYNC_SECONDS)
                except asyncio.TimeoutError:
                    pass
                continue

            try:
                async with websockets.connect(
                    WS_MARKET_URL,
                    open_timeout=10,
                    close_timeout=5,
                    max_size=2**20,
                ) as websocket:
                    self._ws_connected = True
                    self._last_ws_error = None
                    self._ws_subscribed.clear()
                    await self._sync_subscriptions(websocket)

                    while self._ws_running:
                        if self._desired_changed.is_set():
                            await self._sync_subscriptions(websocket)
                        try:
                            message = await asyncio.wait_for(
                                websocket.recv(),
                                timeout=WS_SYNC_SECONDS,
                            )
                        except asyncio.TimeoutError:
                            continue
                        self._handle_ws_message(message)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_ws_error = str(exc)
            finally:
                self._ws_connected = False
                self._ws_subscribed.clear()

            if self._ws_running:
                await asyncio.sleep(WS_RECONNECT_SECONDS)


market_data_hub = FuturesMarketDataHub()
