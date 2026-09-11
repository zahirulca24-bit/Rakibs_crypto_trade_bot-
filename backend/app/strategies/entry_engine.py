from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from app.strategies.indicator_engine import IndicatorEngine, closed_candles

MAX_ENTRY_LOGS = 1000
ENTRY_LOGS: list[dict[str, Any]] = []
MIN_CLOSED_CANDLES = 200
ENTRY_SCORE = 75.0


def _atr(candles: list[dict[str, Any]], period: int = 14) -> float:
    usable = closed_candles(candles)
    if len(usable) < period + 1:
        raise ValueError("ATR requires more candles")
    trs: list[float] = []
    for index in range(1, len(usable)):
        high = float(usable[index]["high"])
        low = float(usable[index]["low"])
        prev_close = float(usable[index - 1]["close"])
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return sum(trs[-period:]) / period


class EntryEngine:
    """5m entry validator for symbols that already passed the 15m Strategy Engine.

    The 1H scanner bias is preserved end-to-end. This engine never creates a new
    symbol universe and never flips LONG to SHORT or SHORT to LONG.
    """

    def __init__(self, indicator: IndicatorEngine | None = None) -> None:
        self.indicator = indicator or IndicatorEngine()

    def analyze(self, strategy_row: dict[str, Any], candles_5m: list[dict[str, Any]]) -> dict[str, Any]:
        started = perf_counter()
        symbol = str(strategy_row["symbol"])
        side = str(strategy_row["side"]).upper()
        if side not in {"LONG", "SHORT"}:
            raise ValueError("Strategy bias must be LONG or SHORT")
        if strategy_row.get("status") != "PASS":
            raise ValueError("5m Entry requires a 15m PASS setup")

        usable = closed_candles(candles_5m)
        if len(usable) < MIN_CLOSED_CANDLES:
            raise ValueError(f"Entry Engine requires at least {MIN_CLOSED_CANDLES} closed 5m candles")

        ind = self.indicator.calculate(symbol, "5m", usable, log_result=False)
        latest = usable[-1]
        previous = usable[-2]
        close = float(latest["close"])
        open_price = float(latest["open"])
        high = float(latest["high"])
        low = float(latest["low"])
        previous_high = float(previous["high"])
        previous_low = float(previous["low"])

        ema9 = float(ind["ema_9"])
        ema20 = float(ind["ema_20"])
        ema50 = float(ind["ema_50"])
        rsi = float(ind["rsi_14"])
        macd_hist = float(ind["macd_histogram"])
        rvol = float(ind["volume_ratio"])
        atr = _atr(usable)
        atr_pct = (atr / close * 100) if close else 0.0

        reasons: list[str] = []
        holds: list[str] = []
        score = 0.0

        if side == "LONG":
            ema_ok = close > ema9 > ema20 > ema50
            momentum_ok = macd_hist > 0
            rsi_ok = 50 <= rsi <= 72
            rejection_ok = close > open_price and low <= ema20 + (0.30 * atr)
            trigger_ok = close > previous_high
        else:
            ema_ok = close < ema9 < ema20 < ema50
            momentum_ok = macd_hist < 0
            rsi_ok = 28 <= rsi <= 50
            rejection_ok = close < open_price and high >= ema20 - (0.30 * atr)
            trigger_ok = close < previous_low

        if ema_ok:
            score += 25
            reasons.append("5m EMA9/20/50 aligned")
        else:
            holds.append("5m EMA structure not aligned")

        if rejection_ok:
            score += 20
            reasons.append("5m rejection candle confirms bias")
        else:
            holds.append("no 5m rejection confirmation")

        if trigger_ok:
            score += 25
            reasons.append("5m previous-candle trigger broken")
        else:
            holds.append("5m entry trigger not broken")

        if momentum_ok:
            score += 15
            reasons.append("5m MACD momentum confirms bias")
        else:
            holds.append("5m MACD momentum not confirmed")

        if rsi_ok:
            score += 10
            reasons.append("5m RSI in entry zone")
        else:
            holds.append("5m RSI outside entry zone")

        if rvol >= 1.0:
            score += 5
            reasons.append("5m volume participation confirmed")
        else:
            holds.append("5m relative volume below 1.0x")

        atr_ok = 0.08 <= atr_pct <= 2.5
        if not atr_ok:
            holds.append("5m volatility outside entry band")

        hard_gate = ema_ok and trigger_ok and atr_ok
        status = "ENTRY" if hard_gate and score >= ENTRY_SCORE else "HOLD"

        return {
            "symbol": symbol,
            "side": side,
            "status": status,
            "score": round(score, 2),
            "strategy_score": strategy_row.get("score"),
            "close_5m": round(close, 8),
            "ema9_5m": round(ema9, 8),
            "ema20_5m": round(ema20, 8),
            "ema50_5m": round(ema50, 8),
            "rsi_5m": round(rsi, 4),
            "macd_histogram_5m": round(macd_hist, 8),
            "rvol_5m": round(rvol, 4),
            "atr_pct_5m": round(atr_pct, 4),
            "reasons": reasons,
            "hold_reasons": holds,
            "processing_ms": round((perf_counter() - started) * 1000, 2),
        }

    def build_result(self, strategy_timestamp: str, rows: list[dict[str, Any]], started: float) -> dict[str, Any]:
        entries = [row for row in rows if row.get("status") == "ENTRY"]
        holds = [row for row in rows if row.get("status") != "ENTRY"]
        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "engine": "Entry Engine",
            "version": "5m-v1",
            "timeframe": "5m",
            "strategy_timestamp": strategy_timestamp,
            "input_count": len(rows),
            "entry_count": len(entries),
            "hold_count": len(holds),
            "long_entry": sum(1 for row in entries if row.get("side") == "LONG"),
            "short_entry": sum(1 for row in entries if row.get("side") == "SHORT"),
            "status": "success",
            "processing_ms": round((perf_counter() - started) * 1000, 2),
            "rows": rows,
        }
        ENTRY_LOGS.append(result)
        del ENTRY_LOGS[:-MAX_ENTRY_LOGS]
        return result


def get_entry_logs() -> list[dict[str, Any]]:
    return list(reversed(ENTRY_LOGS))
