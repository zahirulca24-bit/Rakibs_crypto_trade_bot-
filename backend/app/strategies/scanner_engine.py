from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from app.strategies.indicator_engine import IndicatorEngine, closed_candles

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


class ScannerEngine:
    """1H-only USD-M futures scanner.

    Scanner ownership ends at Top 30.
    Strategy/entry/risk/position engines are separate downstream components.
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

            ranked.append({
                **row,
                "quality_score": quality,
                "quality_reasons": reasons,
            })

        ranked.sort(
            key=lambda item: (
                int(item["quality_score"]),
                float(item.get("rvol_1h", 0)),
                float(item.get("quote_volume", 0)),
            ),
            reverse=True,
        )
        return ranked

    def build_result(
        self,
        *,
        universe_symbols: list[str],
        trend_rows: list[dict[str, Any]],
        participation_rows: list[dict[str, Any]],
        top_rows: list[dict[str, Any]],
        started: float,
    ) -> dict[str, Any]:
        trend_symbols = [str(row["symbol"]) for row in trend_rows]
        participation_symbols = [str(row["symbol"]) for row in participation_rows]
        top_symbols = [str(row["symbol"]) for row in top_rows]

        shortlist = [
            {
                "symbol": row["symbol"],
                "side": row["trend_side"],
                "score": int(row["quality_score"]),
                "quote_volume": round(float(row.get("quote_volume", 0)), 2),
                "last_price": round(float(row.get("last_price", 0)), 8),
                "structure_1h": row.get("structure_1h"),
                "ema20_1h": round(float(row.get("ema20_1h", 0)), 8),
                "ema50_1h": round(float(row.get("ema50_1h", 0)), 8),
                "ema200_1h": round(float(row.get("ema200_1h", 0)), 8),
                "rsi_1h": round(float(row.get("rsi_1h", 0)), 2),
                "rvol_1h": round(float(row.get("rvol_1h", 0)), 2),
                "atr_pct_1h": round(float(row.get("atr_pct_1h", 0)), 3),
                "oi_change_1h_pct": round(float(row.get("oi_change_1h_pct", 0)), 3),
                "spread_pct": round(float(row.get("spread_pct", 0)), 4),
                "reasons": row.get("quality_reasons", []),
            }
            for row in top_rows
        ]

        long_count = sum(1 for row in shortlist if row["side"] == "LONG")
        short_count = sum(1 for row in shortlist if row["side"] == "SHORT")

        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "engine": "Scanner Engine",
            "version": "1h-v1",
            "status": "success",
            "market": "Binance USD-M Perpetual Futures",
            "timeframe": "1h",
            "scan_pool_limit": SCAN_POOL_LIMIT,
            "top_limit": TOP_LIMIT,
            "candidate_count": len(shortlist),
            "long_candidates": long_count,
            "short_candidates": short_count,
            "pipeline": {
                "scan_pool": _stage(universe_symbols, universe_symbols),
                "trend_1h": _stage(universe_symbols, trend_symbols),
                "participation": _stage(trend_symbols, participation_symbols),
                "top_30": _stage(participation_symbols, top_symbols),
            },
            "processing_ms": round((perf_counter() - started) * 1000, 2),
            "candidates": shortlist,
        }
        SCANNER_LOGS.append(result)
        del SCANNER_LOGS[:-MAX_SCANNER_LOGS]
        return result


def get_scanner_logs() -> list[dict[str, Any]]:
    return list(reversed(SCANNER_LOGS))


def restore_scanner_result(result: dict[str, Any]) -> None:
    if not result or result.get("engine") != "Scanner Engine":
        return
    SCANNER_LOGS.append(result)
    del SCANNER_LOGS[:-MAX_SCANNER_LOGS]
