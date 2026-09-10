from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from app.strategies.indicator_engine import _ema, _rsi

MAX_SCANNER_LOGS = 2000
SCANNER_LOGS: list[dict[str, Any]] = []


def _score_candidate(metrics: dict[str, float]) -> tuple[int, list[str]]:
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
    if metrics["volume_ratio"] >= 1.5:
        score += 15
        reasons.append("Volume expansion >= 1.5x")

    return score, reasons


class ScannerEngine:
    def scan(self, markets: list[dict[str, Any]], timeframe: str = "15m", min_quote_volume: float = 10_000_000) -> dict[str, Any]:
        started = perf_counter()
        timestamp = datetime.now(timezone.utc).isoformat()
        candidates: list[dict[str, Any]] = []
        evaluated = 0

        for market in markets:
            try:
                symbol = str(market["symbol"]).replace("/", "").replace("-", "").upper()
                quote_volume = float(market.get("quote_volume", 0))
                if quote_volume < min_quote_volume:
                    continue

                candles = market.get("candles") or []
                if len(candles) < 200:
                    continue

                closes = [float(item["close"]) for item in candles]
                volumes = [float(item["volume"]) for item in candles]
                ema_9 = _ema(closes, 9)[-1]
                ema_21 = _ema(closes, 21)[-1]
                ema_50 = _ema(closes, 50)[-1]
                ema_200 = _ema(closes, 200)[-1]
                ema12 = _ema(closes, 12)
                ema26 = _ema(closes, 26)
                macd_values = [a - b for a, b in zip(ema12, ema26)]
                macd_signal_values = _ema(macd_values, 9)
                current_volume = volumes[-1]
                avg_volume_20 = sum(volumes[-20:]) / 20
                volume_ratio = current_volume / avg_volume_20 if avg_volume_20 else 0.0

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
                score, reasons = _score_candidate(metrics)
                evaluated += 1

                if score >= 50:
                    candidates.append({
                        "symbol": symbol,
                        "timeframe": timeframe,
                        "score": score,
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
                    })
            except (KeyError, TypeError, ValueError):
                continue

        candidates.sort(key=lambda item: (item["score"], item["quote_volume"]), reverse=True)
        result = {
            "timestamp": timestamp,
            "engine": "Scanner Engine",
            "status": "success",
            "timeframe": timeframe,
            "min_quote_volume": min_quote_volume,
            "input_markets": len(markets),
            "evaluated_markets": evaluated,
            "candidate_count": len(candidates),
            "processing_ms": round((perf_counter() - started) * 1000, 2),
            "candidates": candidates,
        }
        SCANNER_LOGS.append(result)
        del SCANNER_LOGS[:-MAX_SCANNER_LOGS]
        return result


def get_scanner_logs() -> list[dict[str, Any]]:
    return list(reversed(SCANNER_LOGS))
