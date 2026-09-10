from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from app.market_data.service import MarketDataService

EMA_PERIODS = (9, 20, 21, 50, 200)
MAX_LOGS = 5000
INDICATOR_LOGS: list[dict[str, Any]] = []


@dataclass
class IndicatorResult:
    timestamp: str
    engine: str
    symbol: str
    timeframe: str
    status: str
    ema_9: float
    ema_20: float
    ema_21: float
    ema_50: float
    ema_200: float
    rsi_14: float
    macd: float
    macd_signal: float
    macd_histogram: float
    avg_volume_20: float
    current_volume: float
    volume_ratio: float
    processing_ms: float


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    multiplier = 2 / (period + 1)
    output = [values[0]]
    for value in values[1:]:
        output.append((value - output[-1]) * multiplier + output[-1])
    return output


def _rsi(values: list[float], period: int = 14) -> float:
    if len(values) <= period:
        raise ValueError(f"RSI requires at least {period + 1} candles")
    gains = 0.0
    losses = 0.0
    for index in range(1, period + 1):
        change = values[index] - values[index - 1]
        gains += max(change, 0.0)
        losses += max(-change, 0.0)
    avg_gain = gains / period
    avg_loss = losses / period
    for index in range(period + 1, len(values)):
        change = values[index] - values[index - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0.0)) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


class IndicatorEngine:
    def __init__(self, market_data: MarketDataService | None = None) -> None:
        self.market_data = market_data or MarketDataService()

    async def run(self, symbol: str, timeframe: str = "15m", limit: int = 500) -> dict[str, Any]:
        started = perf_counter()
        normalized = self.market_data.normalize_symbol(symbol)
        timestamp = datetime.now(timezone.utc).isoformat()
        try:
            payload = await self.market_data.klines(normalized, timeframe, max(250, min(limit, 1000)))
            candles = payload["candles"]
            closes = [float(item["close"]) for item in candles]
            volumes = [float(item["volume"]) for item in candles]
            if len(closes) < 200:
                raise ValueError("Indicator Engine requires at least 200 candles")

            emas = {period: _ema(closes, period)[-1] for period in EMA_PERIODS}
            ema12 = _ema(closes, 12)
            ema26 = _ema(closes, 26)
            macd_values = [a - b for a, b in zip(ema12, ema26)]
            signal_values = _ema(macd_values, 9)
            macd = macd_values[-1]
            signal = signal_values[-1]
            current_volume = volumes[-1]
            avg_volume_20 = sum(volumes[-20:]) / min(20, len(volumes))
            volume_ratio = current_volume / avg_volume_20 if avg_volume_20 else 0.0

            result = IndicatorResult(
                timestamp=timestamp,
                engine="Indicator Engine",
                symbol=normalized,
                timeframe=timeframe,
                status="success",
                ema_9=round(emas[9], 8),
                ema_20=round(emas[20], 8),
                ema_21=round(emas[21], 8),
                ema_50=round(emas[50], 8),
                ema_200=round(emas[200], 8),
                rsi_14=round(_rsi(closes), 4),
                macd=round(macd, 8),
                macd_signal=round(signal, 8),
                macd_histogram=round(macd - signal, 8),
                avg_volume_20=round(avg_volume_20, 8),
                current_volume=round(current_volume, 8),
                volume_ratio=round(volume_ratio, 4),
                processing_ms=round((perf_counter() - started) * 1000, 2),
            )
            log = asdict(result)
            INDICATOR_LOGS.append(log)
            del INDICATOR_LOGS[:-MAX_LOGS]
            return log
        except Exception as exc:
            log = {
                "timestamp": timestamp,
                "engine": "Indicator Engine",
                "symbol": normalized,
                "timeframe": timeframe,
                "status": "error",
                "error": str(exc),
                "processing_ms": round((perf_counter() - started) * 1000, 2),
            }
            INDICATOR_LOGS.append(log)
            del INDICATOR_LOGS[:-MAX_LOGS]
            raise


def get_indicator_logs(start: datetime | None = None, end: datetime | None = None) -> list[dict[str, Any]]:
    rows = INDICATOR_LOGS
    if start is None and end is None:
        return list(reversed(rows))
    filtered: list[dict[str, Any]] = []
    for row in rows:
        ts = datetime.fromisoformat(row["timestamp"])
        if start is not None and ts < start:
            continue
        if end is not None and ts > end:
            continue
        filtered.append(row)
    return list(reversed(filtered))
