from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter, time
from typing import Any

from app.strategies.indicator_engine import _ema, _rsi

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
        score += 20
        reasons.append("EMA 9 above EMA 21")
    if metrics["close"] > metrics["ema_50"]:
        score += 15
        reasons.append("Price above EMA 50")
    if metrics["ema_50"] > metrics["ema_200"]:
        score += 20
        reasons.append("EMA 50 above EMA 200")
    if 50 <= metrics["rsi_14"] <= 70:
        score += 15
        reasons.append("RSI in bullish momentum zone")
    if metrics["macd"] > metrics["macd_signal"]:
        score += 15
        reasons.append("MACD above signal")
    if metrics["volume_ratio"] >= MIN_VOLUME_RATIO:
        score += 15
        reasons.append("Volume expansion >= 1.5x")

    return score, reasons


def _score_short(metrics: dict[str, float]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []

    if metrics["ema_9"] < metrics["ema_21"]:
        score += 20
        reasons.append("EMA 9 below EMA 21")
    if metrics["close"] < metrics["ema_50"]:
        score += 15
        reasons.append("Price below EMA 50")
    if metrics["ema_50"] < metrics["ema_200"]:
        score += 20
        reasons.append("EMA 50 below EMA 200")
    if 30 <= metrics["rsi_14"] <= 50:
        score += 15
        reasons.append("RSI in bearish momentum zone")
    if metrics["macd"] < metrics["macd_signal"]:
        score += 15
        reasons.append("MACD below signal")
    if metrics["volume_ratio"] >= MIN_VOLUME_RATIO:
        score += 15
        reasons.append("Volume expansion >= 1.5x")

    return score, reasons


def _base_asset(symbol: str) -> str:
    for quote in QUOTE_ASSETS:
        if symbol.endswith(quote):
            return symbol[: -len(quote)]
    return symbol


def _closed_candles(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return already-closed candles ordered oldest -> newest."""
    now_ms = int(time() * 1000)
    normalized: list[dict[str, Any]] = []
    for candle in candles:
        try:
            close_time = int(candle.get("close_time", 0))
            float(candle["close"])
            float(candle["volume"])
        except (KeyError, TypeError, ValueError):
            continue
        if close_time and close_time <= now_ms:
            normalized.append(candle)

    normalized.sort(key=lambda item: int(item.get("open_time", 0)))
    return normalized


def _prepare_markets(
    markets: list[dict[str, Any]], min_quote_volume: float
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Keep one highest-liquidity market for each base asset."""
    best_by_base: dict[str, dict[str, Any]] = {}
    stats = {
        "skipped_liquidity": 0,
        "skipped_stablecoin": 0,
        "skipped_duplicate_base": 0,
        "invalid_markets": 0,
    }

    for market in markets:
        try:
            symbol = str(market["symbol"]).replace("/", "").replace("-", "").upper()
            quote_volume = float(market.get("quote_volume", 0))
            if not symbol:
                stats["invalid_markets"] += 1
                continue

            base = _base_asset(symbol)
            if base in STABLE_BASE_ASSETS:
                stats["skipped_stablecoin"] += 1
                continue
            if quote_volume < min_quote_volume:
                stats["skipped_liquidity"] += 1
                continue

            normalized = {**market, "symbol": symbol, "quote_volume": quote_volume}
            existing = best_by_base.get(base)
            if existing is None:
                best_by_base[base] = normalized
            elif quote_volume > float(existing.get("quote_volume", 0)):
                best_by_base[base] = normalized
                stats["skipped_duplicate_base"] += 1
            else:
                stats["skipped_duplicate_base"] += 1
        except (KeyError, TypeError, ValueError):
            stats["invalid_markets"] += 1

    selected = sorted(best_by_base.values(), key=lambda item: float(item["quote_volume"]), reverse=True)
    return selected, stats


class ScannerEngine:
    def scan(
        self,
        markets: list[dict[str, Any]],
        timeframe: str = "15m",
        min_quote_volume: float = 10_000_000,
    ) -> dict[str, Any]:
        if timeframe not in SUPPORTED_TIMEFRAMES:
            raise ValueError(f"Unsupported timeframe: {timeframe}")
        if min_quote_volume < 0:
            raise ValueError("min_quote_volume must be non-negative")

        started = perf_counter()
        timestamp = datetime.now(timezone.utc).isoformat()
        candidates: list[dict[str, Any]] = []
        prepared_markets, prep_stats = _prepare_markets(markets, min_quote_volume)
        evaluated = 0
        skipped_candles = 0
        skipped_volume = 0
        skipped_direction = 0
        invalid_markets = prep_stats["invalid_markets"]

        for market in prepared_markets:
            try:
                symbol = str(market["symbol"])
                quote_volume = float(market["quote_volume"])
                candles = _closed_candles(market.get("candles") or [])
                if len(candles) < MIN_CLOSED_CANDLES:
                    skipped_candles += 1
                    continue

                closes = [float(item["close"]) for item in candles]
                volumes = [float(item["volume"]) for item in candles]
                if len(volumes) < 21:
                    skipped_candles += 1
                    continue

                ema_9 = _ema(closes, 9)[-1]
                ema_21 = _ema(closes, 21)[-1]
                ema_50 = _ema(closes, 50)[-1]
                ema_200 = _ema(closes, 200)[-1]
                ema12 = _ema(closes, 12)
                ema26 = _ema(closes, 26)
                macd_values = [a - b for a, b in zip(ema12, ema26)]
                macd_signal_values = _ema(macd_values, 9)

                current_volume = volumes[-1]
                previous_20 = volumes[-21:-1]
                avg_volume_20 = sum(previous_20) / len(previous_20)
                volume_ratio = current_volume / avg_volume_20 if avg_volume_20 > 0 else 0.0
                evaluated += 1

                if volume_ratio < MIN_VOLUME_RATIO:
                    skipped_volume += 1
                    continue

                metrics = {
                    "close": closes[-1],
                    "ema_9": ema_9,
                    "ema_21": ema_21,
                    "ema_50": ema_50,
                    "ema_200": ema_200,
                    "rsi_14": _rsi(closes),
                    "macd": macd_values[-1],
                    "macd_signal": macd_signal_values[-1],
                    "volume_ratio": volume_ratio,
                }
                long_score, long_reasons = _score_long(metrics)
                short_score, short_reasons = _score_short(metrics)

                long_aligned = (
                    50 <= metrics["rsi_14"] <= 70
                    and metrics["macd"] > metrics["macd_signal"]
                )
                short_aligned = (
                    30 <= metrics["rsi_14"] <= 50
                    and metrics["macd"] < metrics["macd_signal"]
                )

                eligible_long = long_aligned and long_score >= MIN_CANDIDATE_SCORE
                eligible_short = short_aligned and short_score >= MIN_CANDIDATE_SCORE
                if not eligible_long and not eligible_short:
                    skipped_direction += 1
                    continue

                if eligible_long and (not eligible_short or long_score >= short_score):
                    side = "LONG"
                    score = long_score
                    reasons = long_reasons
                else:
                    side = "SHORT"
                    score = short_score
                    reasons = short_reasons

                candidates.append(
                    {
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
                        "volume_ratio": round(volume_ratio, 2),
                        "ema_9": round(ema_9, 8),
                        "ema_21": round(ema_21, 8),
                        "ema_50": round(ema_50, 8),
                        "ema_200": round(ema_200, 8),
                        "reasons": reasons,
                    }
                )
            except (KeyError, TypeError, ValueError, ZeroDivisionError):
                invalid_markets += 1
                continue

        candidates.sort(
            key=lambda item: (item["score"], item["volume_ratio"], item["quote_volume"]),
            reverse=True,
        )
        long_candidates = sum(1 for item in candidates if item["side"] == "LONG")
        short_candidates = sum(1 for item in candidates if item["side"] == "SHORT")
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
            "evaluated_markets": evaluated,
            "candidate_count": len(candidates),
            "long_candidates": long_candidates,
            "short_candidates": short_candidates,
            "skipped_liquidity": prep_stats["skipped_liquidity"],
            "skipped_stablecoin": prep_stats["skipped_stablecoin"],
            "skipped_duplicate_base": prep_stats["skipped_duplicate_base"],
            "skipped_candles": skipped_candles,
            "skipped_volume": skipped_volume,
            "skipped_direction": skipped_direction,
            "invalid_markets": invalid_markets,
            "processing_ms": round((perf_counter() - started) * 1000, 2),
            "candidates": candidates,
        }
        SCANNER_LOGS.append(result)
        del SCANNER_LOGS[:-MAX_SCANNER_LOGS]
        return result


def get_scanner_logs() -> list[dict[str, Any]]:
    return list(reversed(SCANNER_LOGS))
