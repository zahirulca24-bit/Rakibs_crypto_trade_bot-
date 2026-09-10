from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from app.strategies.indicator_engine import IndicatorEngine, _ema, closed_candles

MAX_SCANNER_LOGS = 2000
SCANNER_LOGS: list[dict[str, Any]] = []
MIN_CLOSED_CANDLES = 200
MIN_QUOTE_VOLUME = 10_000_000.0
SCAN_POOL_LIMIT = 200
TOP_LIMIT = 30
MAX_SPREAD_PCT = 0.15


def _stage(previous: list[str], passed: list[str]) -> dict[str, Any]:
    keep = set(passed)
    dropped = [symbol for symbol in previous if symbol not in keep]
    return {
        "passed": len(passed),
        "dropped": len(dropped),
        "passed_symbols": passed,
        "dropped_symbols": dropped,
    }


def _atr_pct(candles: list[dict[str, Any]], period: int = 14) -> float:
    usable = closed_candles(candles)
    if len(usable) < period + 1:
        raise ValueError("ATR requires more candles")
    trs: list[float] = []
    for index in range(1, len(usable)):
        high = float(usable[index]["high"])
        low = float(usable[index]["low"])
        prev_close = float(usable[index - 1]["close"])
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    atr = sum(trs[-period:]) / period
    close = float(usable[-1]["close"])
    return (atr / close * 100) if close else 0.0


def _market_structure(candles: list[dict[str, Any]], window: int = 40, span: int = 2) -> str:
    usable = closed_candles(candles)[-window:]
    if len(usable) < 12:
        return "MIXED"
    highs = [float(item["high"]) for item in usable]
    lows = [float(item["low"]) for item in usable]
    swing_highs: list[float] = []
    swing_lows: list[float] = []
    for i in range(span, len(usable) - span):
        if highs[i] == max(highs[i - span : i + span + 1]):
            swing_highs.append(highs[i])
        if lows[i] == min(lows[i - span : i + span + 1]):
            swing_lows.append(lows[i])
    if len(swing_highs) < 2 or len(swing_lows) < 2:
        return "MIXED"
    if swing_highs[-1] > swing_highs[-2] and swing_lows[-1] > swing_lows[-2]:
        return "HH_HL"
    if swing_highs[-1] < swing_highs[-2] and swing_lows[-1] < swing_lows[-2]:
        return "LH_LL"
    return "MIXED"


def _recent_cross(candles: list[dict[str, Any]], long_side: bool) -> bool:
    usable = closed_candles(candles)
    closes = [float(item["close"]) for item in usable]
    if len(closes) < 30:
        return False
    ema9 = _ema(closes, 9)
    ema21 = _ema(closes, 21)
    start = max(1, len(closes) - 4)
    for i in range(start, len(closes)):
        if long_side and ema9[i] > ema21[i] and ema9[i - 1] <= ema21[i - 1]:
            return True
        if not long_side and ema9[i] < ema21[i] and ema9[i - 1] >= ema21[i - 1]:
            return True
    return False


class ScannerEngine:
    """Multi-timeframe USD-M futures scanner.

    1H decides trend, 15m validates setup, 5m confirms entry.
    OI/spread/ATR/RSI/RVOL are quality/participation inputs, not duplicated legacy gates.
    """

    def __init__(self, indicator_engine: IndicatorEngine | None = None) -> None:
        self.indicator_engine = indicator_engine or IndicatorEngine()

    def analyze_trend(self, market: dict[str, Any]) -> dict[str, Any] | None:
        symbol = str(market["symbol"])
        candles = closed_candles(market.get("candles_1h") or [])
        if len(candles) < MIN_CLOSED_CANDLES:
            return None
        ind = self.indicator_engine.calculate(symbol, "1h", candles, log_result=False)
        close = float(candles[-1]["close"])
        structure = _market_structure(candles)
        ema20 = float(ind["ema_20"])
        ema50 = float(ind["ema_50"])
        ema200 = float(ind["ema_200"])
        rsi = float(ind["rsi_14"])
        rvol = float(ind["volume_ratio"])
        atr_pct = _atr_pct(candles)

        long_trend = close > ema20 > ema50 > ema200 and structure == "HH_HL"
        short_trend = close < ema20 < ema50 < ema200 and structure == "LH_LL"
        if not long_trend and not short_trend:
            return None
        side = "LONG" if long_trend else "SHORT"

        score = 50
        reasons = [
            f"1H {structure}",
            "1H EMA20 > EMA50 > EMA200" if side == "LONG" else "1H EMA20 < EMA50 < EMA200",
        ]
        if (side == "LONG" and 50 <= rsi <= 70) or (side == "SHORT" and 30 <= rsi < 50):
            score += 15
            reasons.append(f"1H RSI {rsi:.1f} confirms trend")
        if rvol >= 1.10:
            score += 10
            reasons.append(f"1H RVOL {rvol:.2f}x")
        elif rvol >= 0.90:
            score += 5
        if 0.30 <= atr_pct <= 6.0:
            score += 10
            reasons.append(f"1H ATR {atr_pct:.2f}% healthy")

        return {
            **market,
            "trend_side": side,
            "trend_score": score,
            "structure_1h": structure,
            "ema20_1h": ema20,
            "ema50_1h": ema50,
            "ema200_1h": ema200,
            "rsi_1h": rsi,
            "rvol_1h": rvol,
            "atr_pct_1h": atr_pct,
            "last_price": close,
            "trend_reasons": reasons,
        }

    def rank_participation(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        ranked: list[dict[str, Any]] = []
        for row in rows:
            spread_pct = float(row.get("spread_pct", 999.0))
            if spread_pct > MAX_SPREAD_PCT:
                continue
            oi_change = float(row.get("oi_change_1h_pct", 0.0))
            quality = int(row["trend_score"])
            reasons = list(row["trend_reasons"])
            if spread_pct <= 0.05:
                quality += 10
                reasons.append(f"Spread {spread_pct:.3f}%")
            elif spread_pct <= 0.10:
                quality += 5
            if oi_change >= 0.50:
                quality += 15
                reasons.append(f"OI +{oi_change:.2f}% / 1H")
            elif oi_change > 0:
                quality += 8
                reasons.append(f"OI rising {oi_change:.2f}% / 1H")
            ranked.append({**row, "quality_score": quality, "quality_reasons": reasons})
        ranked.sort(
            key=lambda item: (
                int(item["quality_score"]),
                float(item.get("rvol_1h", 0)),
                float(item.get("quote_volume", 0)),
            ),
            reverse=True,
        )
        return ranked[:TOP_LIMIT]

    def evaluate_setup_entry(self, row: dict[str, Any]) -> dict[str, Any]:
        symbol = str(row["symbol"])
        side = str(row["trend_side"])
        c15 = closed_candles(row.get("candles_15m") or [])
        c5 = closed_candles(row.get("candles_5m") or [])
        if len(c15) < MIN_CLOSED_CANDLES or len(c5) < MIN_CLOSED_CANDLES:
            return {**row, "decision": "HOLD", "hold_reason": "insufficient 15m/5m candles"}

        i15 = self.indicator_engine.calculate(symbol, "15m", c15, log_result=False)
        i5 = self.indicator_engine.calculate(symbol, "5m", c5, log_result=False)

        close15 = float(c15[-1]["close"])
        ema20_15 = float(i15["ema_20"])
        ema50_15 = float(i15["ema_50"])
        macd15 = float(i15["macd"])
        signal15 = float(i15["macd_signal"])
        recent15 = c15[-3:]
        setup_long = (
            side == "LONG"
            and ema20_15 > ema50_15
            and min(float(c["low"]) for c in recent15) <= ema20_15 * 1.01
            and close15 > ema20_15
            and macd15 > signal15
        )
        setup_short = (
            side == "SHORT"
            and ema20_15 < ema50_15
            and max(float(c["high"]) for c in recent15) >= ema20_15 * 0.99
            and close15 < ema20_15
            and macd15 < signal15
        )
        setup_ok = setup_long or setup_short
        if not setup_ok:
            return {
                **row,
                "decision": "HOLD",
                "setup_15m": False,
                "entry_5m": False,
                "hold_reason": "15m EMA20/50 pullback + MACD setup not confirmed",
                "ema20_15m": ema20_15,
                "ema50_15m": ema50_15,
                "macd_15m": macd15,
                "macd_signal_15m": signal15,
            }

        close5 = float(c5[-1]["close"])
        open5 = float(c5[-1]["open"])
        ema9_5 = float(i5["ema_9"])
        ema21_5 = float(i5["ema_21"])
        cross_recent = _recent_cross(c5, side == "LONG")
        if side == "LONG":
            entry_ok = ema9_5 > ema21_5 and close5 > ema9_5 and close5 > open5
        else:
            entry_ok = ema9_5 < ema21_5 and close5 < ema9_5 and close5 < open5

        if not entry_ok:
            return {
                **row,
                "decision": "HOLD",
                "setup_15m": True,
                "entry_5m": False,
                "hold_reason": "5m EMA9/21 + candle confirmation not ready",
                "ema20_15m": ema20_15,
                "ema50_15m": ema50_15,
                "macd_15m": macd15,
                "macd_signal_15m": signal15,
                "ema9_5m": ema9_5,
                "ema21_5m": ema21_5,
                "entry_cross_recent": cross_recent,
            }

        score = int(row["quality_score"]) + 20 + (10 if cross_recent else 5)
        reasons = list(row["quality_reasons"]) + [
            "15m setup confirmed",
            "5m EMA9/21 entry confirmed",
        ]
        if cross_recent:
            reasons.append("5m recent EMA crossover")

        return {
            **row,
            "decision": side,
            "score": score,
            "setup_15m": True,
            "entry_5m": True,
            "ema20_15m": ema20_15,
            "ema50_15m": ema50_15,
            "macd_15m": macd15,
            "macd_signal_15m": signal15,
            "ema9_5m": ema9_5,
            "ema21_5m": ema21_5,
            "rsi_5m": float(i5["rsi_14"]),
            "entry_cross_recent": cross_recent,
            "reasons": reasons,
        }

    def build_result(
        self,
        *,
        universe_symbols: list[str],
        trend_rows: list[dict[str, Any]],
        participation_rows: list[dict[str, Any]],
        top_rows: list[dict[str, Any]],
        decisions: list[dict[str, Any]],
        started: float,
    ) -> dict[str, Any]:
        trend_symbols = [str(row["symbol"]) for row in trend_rows]
        participation_symbols = [str(row["symbol"]) for row in participation_rows]
        top_symbols = [str(row["symbol"]) for row in top_rows]
        setup_symbols = [str(row["symbol"]) for row in decisions if row.get("setup_15m")]
        entry_symbols = [str(row["symbol"]) for row in decisions if row.get("entry_5m")]
        candidates = [row for row in decisions if row.get("decision") in {"LONG", "SHORT"}]
        candidates.sort(key=lambda row: (int(row.get("score", 0)), float(row.get("quality_score", 0))), reverse=True)
        long_count = sum(1 for row in candidates if row["decision"] == "LONG")
        short_count = sum(1 for row in candidates if row["decision"] == "SHORT")

        public_candidates = [
            {
                "symbol": row["symbol"],
                "side": row["decision"],
                "score": row["score"],
                "quote_volume": round(float(row.get("quote_volume", 0)), 2),
                "last_price": round(float(row.get("last_price", 0)), 8),
                "structure_1h": row.get("structure_1h"),
                "rsi_1h": round(float(row.get("rsi_1h", 0)), 2),
                "rvol_1h": round(float(row.get("rvol_1h", 0)), 2),
                "atr_pct_1h": round(float(row.get("atr_pct_1h", 0)), 3),
                "oi_change_1h_pct": round(float(row.get("oi_change_1h_pct", 0)), 3),
                "spread_pct": round(float(row.get("spread_pct", 0)), 4),
                "ema20_15m": round(float(row.get("ema20_15m", 0)), 8),
                "ema50_15m": round(float(row.get("ema50_15m", 0)), 8),
                "ema9_5m": round(float(row.get("ema9_5m", 0)), 8),
                "ema21_5m": round(float(row.get("ema21_5m", 0)), 8),
                "reasons": row.get("reasons", []),
            }
            for row in candidates
        ]

        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "engine": "Scanner Engine",
            "version": "mtf-v1",
            "status": "success",
            "market": "Binance USD-M Perpetual Futures",
            "scan_pool_limit": SCAN_POOL_LIMIT,
            "top_limit": TOP_LIMIT,
            "candidate_count": len(public_candidates),
            "long_candidates": long_count,
            "short_candidates": short_count,
            "hold_count": len(decisions) - len(public_candidates),
            "pipeline": {
                "scan_pool": _stage(universe_symbols, universe_symbols),
                "trend_1h": _stage(universe_symbols, trend_symbols),
                "participation": _stage(trend_symbols, participation_symbols),
                "top_30": _stage(participation_symbols, top_symbols),
                "setup_15m": _stage(top_symbols, setup_symbols),
                "entry_5m": _stage(setup_symbols, entry_symbols),
                "final": _stage(entry_symbols, [row["symbol"] for row in candidates]),
            },
            "processing_ms": round((perf_counter() - started) * 1000, 2),
            "candidates": public_candidates,
            "decisions": [
                {
                    "symbol": row["symbol"],
                    "trend_side": row.get("trend_side"),
                    "decision": row.get("decision", "HOLD"),
                    "hold_reason": row.get("hold_reason"),
                    "quality_score": row.get("quality_score"),
                }
                for row in decisions
            ],
        }
        SCANNER_LOGS.append(result)
        del SCANNER_LOGS[:-MAX_SCANNER_LOGS]
        return result


def get_scanner_logs() -> list[dict[str, Any]]:
    return list(reversed(SCANNER_LOGS))
