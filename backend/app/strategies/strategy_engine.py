from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from app.strategies.indicator_engine import IndicatorEngine, closed_candles

MAX_STRATEGY_LOGS = 1000
STRATEGY_LOGS: list[dict[str, Any]] = []
MIN_CLOSED_CANDLES = 200
PASS_SCORE = 70.0


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


class StrategyEngine:
    """15m setup validator.

    Input universe is ONLY the current locked Scanner Top30.
    Scanner 1H bias is preserved; this engine never creates a new universe
    and never flips LONG to SHORT or SHORT to LONG.
    """

    def __init__(self) -> None:
        self.indicator = IndicatorEngine()

    def analyze(self, scanner_row: dict[str, Any], candles_15m: list[dict[str, Any]]) -> dict[str, Any]:
        started = perf_counter()
        symbol = str(scanner_row["symbol"])
        side = str(scanner_row["side"]).upper()
        if side not in {"LONG", "SHORT"}:
            raise ValueError("Scanner bias must be LONG or SHORT")

        usable = closed_candles(candles_15m)
        if len(usable) < MIN_CLOSED_CANDLES:
            raise ValueError(f"Strategy Engine requires at least {MIN_CLOSED_CANDLES} closed 15m candles")

        ind = self.indicator.calculate(symbol, "15m", usable, log_result=False)
        latest = usable[-1]
        close = float(latest["close"])
        open_price = float(latest["open"])
        high = float(latest["high"])
        low = float(latest["low"])
        ema20 = float(ind["ema_20"])
        ema50 = float(ind["ema_50"])
        rsi = float(ind["rsi_14"])
        macd_hist = float(ind["macd_histogram"])
        rvol = float(ind["volume_ratio"])
        atr = _atr(usable)
        atr_pct = (atr / close * 100) if close else 0.0

        reasons: list[str] = []
        fails: list[str] = []
        score = 0.0

        if side == "LONG":
            ema_ok = close > ema20 > ema50
            momentum_ok = macd_hist > 0
            rsi_ok = 45 <= rsi <= 70
            rejection_ok = close > open_price and low <= ema20 + (0.35 * atr)
        else:
            ema_ok = close < ema20 < ema50
            momentum_ok = macd_hist < 0
            rsi_ok = 30 <= rsi <= 55
            rejection_ok = close < open_price and high >= ema20 - (0.35 * atr)

        if ema_ok:
            score += 30
            reasons.append("15m EMA20/50 structure aligned")
        else:
            fails.append("15m EMA structure not aligned")

        distance_to_ema20 = abs(close - ema20)
        pullback_ok = distance_to_ema20 <= max(atr, close * 0.001)
        if pullback_ok:
            score += 20
            reasons.append("price within 1 ATR of EMA20")
        else:
            fails.append("price extended from EMA20")

        if rejection_ok:
            score += 15
            reasons.append("15m rejection candle confirms bias")
        else:
            fails.append("no confirming rejection candle")

        if momentum_ok:
            score += 15
            reasons.append("MACD momentum confirms bias")
        else:
            fails.append("MACD momentum not confirmed")

        if rsi_ok:
            score += 10
            reasons.append("RSI in supportive zone")
        else:
            fails.append("RSI outside supportive zone")

        if rvol >= 1.0:
            score += 10
            reasons.append("volume participation confirmed")
        elif rvol >= 0.8:
            score += 5
            reasons.append("volume participation acceptable")
        else:
            fails.append("weak relative volume")

        atr_ok = 0.15 <= atr_pct <= 4.0
        if not atr_ok:
            fails.append("15m volatility outside quality band")

        hard_gate = ema_ok and atr_ok
        status = "PASS" if hard_gate and score >= PASS_SCORE else "HOLD"

        return {
            "symbol": symbol,
            "side": side,
            "status": status,
            "score": round(score, 2),
            "scanner_score": scanner_row.get("score"),
            "close_15m": round(close, 8),
            "ema20_15m": round(ema20, 8),
            "ema50_15m": round(ema50, 8),
            "rsi_15m": round(rsi, 4),
            "macd_histogram_15m": round(macd_hist, 8),
            "rvol_15m": round(rvol, 4),
            "atr_pct_15m": round(atr_pct, 4),
            "reasons": reasons,
            "hold_reasons": fails,
            "processing_ms": round((perf_counter() - started) * 1000, 2),
        }

    def build_result(self, scanner_timestamp: str, rows: list[dict[str, Any]], started: float) -> dict[str, Any]:
        passed = [row for row in rows if row.get("status") == "PASS"]
        held = [row for row in rows if row.get("status") != "PASS"]
        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "engine": "Strategy Engine",
            "version": "15m-v1",
            "timeframe": "15m",
            "scanner_timestamp": scanner_timestamp,
            "input_count": len(rows),
            "pass_count": len(passed),
            "hold_count": len(held),
            "long_pass": sum(1 for row in passed if row.get("side") == "LONG"),
            "short_pass": sum(1 for row in passed if row.get("side") == "SHORT"),
            "status": "success",
            "processing_ms": round((perf_counter() - started) * 1000, 2),
            "rows": rows,
        }
        STRATEGY_LOGS.append(result)
        del STRATEGY_LOGS[:-MAX_STRATEGY_LOGS]
        return result


def get_strategy_logs() -> list[dict[str, Any]]:
    return list(reversed(STRATEGY_LOGS))
