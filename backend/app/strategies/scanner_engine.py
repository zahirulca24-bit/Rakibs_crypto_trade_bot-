from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from app.strategies.indicator_engine import IndicatorEngine, closed_candles

MAX_SCANNER_LOGS = 2000
SCANNER_LOGS: list[dict[str, Any]] = []
SUPPORTED_TIMEFRAMES = {"1m", "5m", "15m", "1h", "4h", "1d"}
MIN_CLOSED_CANDLES = 200
MIN_VOLUME_RATIO = 1.5
MIN_CANDIDATE_SCORE = 50
QUOTE_ASSETS = ("FDUSD", "USDT", "USDC")
STABLE_BASE_ASSETS = {
    "USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "USD1", "USDE", "PYUSD", "BUSD",
}


def _score_long(metrics: dict[str, float]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    if metrics["ema_9"] > metrics["ema_21"]:
        score += 20; reasons.append("EMA 9 above EMA 21")
    if metrics["close"] > metrics["ema_50"]:
        score += 15; reasons.append("Price above EMA 50")
    if metrics["ema_50"] > metrics["ema_200"]:
        score += 20; reasons.append("EMA 50 above EMA 200")
    if 50 <= metrics["rsi_14"] <= 70:
        score += 15; reasons.append("RSI in bullish momentum zone")
    if metrics["macd"] > metrics["macd_signal"]:
        score += 15; reasons.append("MACD above signal")
    if metrics["volume_ratio"] >= MIN_VOLUME_RATIO:
        score += 15; reasons.append("Volume expansion >= 1.5x")
    return score, reasons


def _score_short(metrics: dict[str, float]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    if metrics["ema_9"] < metrics["ema_21"]:
        score += 20; reasons.append("EMA 9 below EMA 21")
    if metrics["close"] < metrics["ema_50"]:
        score += 15; reasons.append("Price below EMA 50")
    if metrics["ema_50"] < metrics["ema_200"]:
        score += 20; reasons.append("EMA 50 below EMA 200")
    if 30 <= metrics["rsi_14"] < 50:
        score += 15; reasons.append("RSI in bearish momentum zone")
    if metrics["macd"] < metrics["macd_signal"]:
        score += 15; reasons.append("MACD below signal")
    if metrics["volume_ratio"] >= MIN_VOLUME_RATIO:
        score += 15; reasons.append("Volume expansion >= 1.5x")
    return score, reasons


def _base_asset(symbol: str) -> str:
    for quote in QUOTE_ASSETS:
        if symbol.endswith(quote):
            return symbol[: -len(quote)]
    return symbol


def _prepare_markets(markets: list[dict[str, Any]], min_quote_volume: float) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Backend safety gate. Frontend already sends the top unique liquid universe."""
    best_by_base: dict[str, dict[str, Any]] = {}
    stats: dict[str, Any] = {
        "skipped_liquidity": 0, "skipped_stablecoin": 0, "skipped_duplicate_base": 0, "invalid_markets": 0,
        "dropped": [],
    }
    for market in markets:
        try:
            symbol = str(market["symbol"]).replace("/", "").replace("-", "").upper()
            quote_volume = float(market.get("quote_volume", 0))
            if not symbol:
                raise ValueError("empty symbol")
            base = _base_asset(symbol)
            if base in STABLE_BASE_ASSETS:
                stats["skipped_stablecoin"] += 1; stats["dropped"].append(symbol); continue
            if quote_volume < min_quote_volume:
                stats["skipped_liquidity"] += 1; stats["dropped"].append(symbol); continue
            normalized = {**market, "symbol": symbol, "quote_volume": quote_volume}
            existing = best_by_base.get(base)
            if existing is None:
                best_by_base[base] = normalized
            elif quote_volume > float(existing.get("quote_volume", 0)):
                stats["skipped_duplicate_base"] += 1; stats["dropped"].append(str(existing["symbol"])); best_by_base[base] = normalized
            else:
                stats["skipped_duplicate_base"] += 1; stats["dropped"].append(symbol)
        except (KeyError, TypeError, ValueError):
            stats["invalid_markets"] += 1; stats["dropped"].append(str(market.get("symbol", "<invalid>")))
    return sorted(best_by_base.values(), key=lambda item: float(item["quote_volume"]), reverse=True), stats


class ScannerEngine:
    def __init__(self, indicator_engine: IndicatorEngine | None = None) -> None:
        self.indicator_engine = indicator_engine or IndicatorEngine()

    def scan(self, markets: list[dict[str, Any]], timeframe: str = "15m", min_quote_volume: float = 10_000_000) -> dict[str, Any]:
        if timeframe not in SUPPORTED_TIMEFRAMES:
            raise ValueError(f"Unsupported timeframe: {timeframe}")
        if min_quote_volume < 0:
            raise ValueError("min_quote_volume must be non-negative")

        started = perf_counter()
        timestamp = datetime.now(timezone.utc).isoformat()
        candidates: list[dict[str, Any]] = []
        prepared_markets, prep = _prepare_markets(markets, min_quote_volume)

        indicator_passed: list[str] = []
        indicator_dropped: list[str] = []
        volume_passed: list[str] = []
        volume_dropped: list[str] = []
        direction_passed: list[str] = []
        direction_dropped: list[str] = []
        invalid_markets = prep["invalid_markets"]

        for market in prepared_markets:
            symbol = str(market.get("symbol", "<invalid>"))
            try:
                quote_volume = float(market["quote_volume"])
                candles = closed_candles(market.get("candles") or [])
                if len(candles) < MIN_CLOSED_CANDLES:
                    indicator_dropped.append(symbol)
                    continue

                indicator = self.indicator_engine.calculate(symbol, timeframe, candles)
                indicator_passed.append(symbol)
                close = float(candles[-1]["close"])
                metrics = {
                    "close": close,
                    "ema_9": float(indicator["ema_9"]),
                    "ema_21": float(indicator["ema_21"]),
                    "ema_50": float(indicator["ema_50"]),
                    "ema_200": float(indicator["ema_200"]),
                    "rsi_14": float(indicator["rsi_14"]),
                    "macd": float(indicator["macd"]),
                    "macd_signal": float(indicator["macd_signal"]),
                    "volume_ratio": float(indicator["volume_ratio"]),
                }

                if metrics["volume_ratio"] < MIN_VOLUME_RATIO:
                    volume_dropped.append(symbol)
                    continue
                volume_passed.append(symbol)

                long_score, long_reasons = _score_long(metrics)
                short_score, short_reasons = _score_short(metrics)
                long_aligned = 50 <= metrics["rsi_14"] <= 70 and metrics["macd"] > metrics["macd_signal"]
                short_aligned = 30 <= metrics["rsi_14"] < 50 and metrics["macd"] < metrics["macd_signal"]
                eligible_long = long_aligned and long_score >= MIN_CANDIDATE_SCORE
                eligible_short = short_aligned and short_score >= MIN_CANDIDATE_SCORE

                if not eligible_long and not eligible_short:
                    direction_dropped.append(symbol)
                    continue
                direction_passed.append(symbol)

                if eligible_long and not eligible_short:
                    side, score, reasons = "LONG", long_score, long_reasons
                elif eligible_short and not eligible_long:
                    side, score, reasons = "SHORT", short_score, short_reasons
                elif long_score > short_score:
                    side, score, reasons = "LONG", long_score, long_reasons
                elif short_score > long_score:
                    side, score, reasons = "SHORT", short_score, short_reasons
                else:
                    direction_dropped.append(symbol)
                    direction_passed.pop()
                    continue

                candidates.append({
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "side": side,
                    "score": score,
                    "long_score": long_score,
                    "short_score": short_score,
                    "quote_volume": round(quote_volume, 2),
                    "last_price": round(metrics["close"], 8),
                    "rsi_14": round(metrics["rsi_14"], 2),
                    "macd": round(metrics["macd"], 8),
                    "macd_signal": round(metrics["macd_signal"], 8),
                    "volume_ratio": round(metrics["volume_ratio"], 2),
                    "ema_9": round(metrics["ema_9"], 8),
                    "ema_21": round(metrics["ema_21"], 8),
                    "ema_50": round(metrics["ema_50"], 8),
                    "ema_200": round(metrics["ema_200"], 8),
                    "reasons": reasons,
                })
            except (KeyError, TypeError, ValueError, ZeroDivisionError):
                invalid_markets += 1
                if symbol not in indicator_dropped and symbol not in indicator_passed:
                    indicator_dropped.append(symbol)

        candidates.sort(key=lambda item: (item["score"], item["volume_ratio"], item["quote_volume"]), reverse=True)
        shortlist_symbols = [item["symbol"] for item in candidates]
        long_candidates = sum(1 for item in candidates if item["side"] == "LONG")
        short_candidates = len(candidates) - long_candidates

        result = {
            "timestamp": timestamp,
            "engine": "Scanner Engine",
            "status": "success",
            "timeframe": timeframe,
            "min_quote_volume": min_quote_volume,
            "min_volume_ratio": MIN_VOLUME_RATIO,
            "min_candidate_score": MIN_CANDIDATE_SCORE,
            "input_markets": len(markets),
            "prepared_markets": len(prepared_markets),
            "evaluated_markets": len(indicator_passed),
            "candidate_count": len(candidates),
            "long_candidates": long_candidates,
            "short_candidates": short_candidates,
            "skipped_liquidity": prep["skipped_liquidity"],
            "skipped_stablecoin": prep["skipped_stablecoin"],
            "skipped_duplicate_base": prep["skipped_duplicate_base"],
            "skipped_candles": len(indicator_dropped),
            "skipped_volume": len(volume_dropped),
            "skipped_direction": len(direction_dropped),
            "invalid_markets": invalid_markets,
            "pipeline": {
                "backend_input": {"passed": len(markets), "dropped": 0, "dropped_symbols": [], "passed_symbols": [str(m.get("symbol", "")) for m in markets]},
                "backend_safety": {"passed": len(prepared_markets), "dropped": len(prep["dropped"]), "dropped_symbols": prep["dropped"], "passed_symbols": [str(m["symbol"]) for m in prepared_markets]},
                "indicator_analysis": {"passed": len(indicator_passed), "dropped": len(indicator_dropped), "dropped_symbols": indicator_dropped, "passed_symbols": indicator_passed},
                "volume": {"passed": len(volume_passed), "dropped": len(volume_dropped), "dropped_symbols": volume_dropped, "passed_symbols": volume_passed},
                "direction": {"passed": len(direction_passed), "dropped": len(direction_dropped), "dropped_symbols": direction_dropped, "passed_symbols": direction_passed},
                "shortlist": {"passed": len(shortlist_symbols), "dropped": max(0, len(direction_passed) - len(shortlist_symbols)), "dropped_symbols": [], "passed_symbols": shortlist_symbols},
            },
            "processing_ms": round((perf_counter() - started) * 1000, 2),
            "candidates": candidates,
        }
        SCANNER_LOGS.append(result)
        del SCANNER_LOGS[:-MAX_SCANNER_LOGS]
        return result


def get_scanner_logs() -> list[dict[str, Any]]:
    return list(reversed(SCANNER_LOGS))
