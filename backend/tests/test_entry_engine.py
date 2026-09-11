from app.strategies.entry_engine import EntryEngine


class FakeIndicator:
    def calculate(self, symbol, timeframe, candles, log_result=False):
        return {
            "ema_9": 99.0,
            "ema_20": 98.0,
            "ema_50": 97.0,
            "rsi_14": 60.0,
            "macd_histogram": 1.0,
            "volume_ratio": 1.2,
        }


def _candles(latest_close: float, latest_high: float) -> list[dict]:
    rows = []
    for index in range(198):
        rows.append(
            {
                "open_time": index,
                "open": "100",
                "high": "101",
                "low": "99",
                "close": "100",
                "volume": "1000",
                "close_time": 0,
            }
        )
    rows.append(
        {
            "open_time": 198,
            "open": "100",
            "high": "101",
            "low": "99",
            "close": "100",
            "volume": "1000",
            "close_time": 0,
        }
    )
    rows.append(
        {
            "open_time": 199,
            "open": "99",
            "high": str(latest_high),
            "low": "98",
            "close": str(latest_close),
            "volume": "1200",
            "close_time": 0,
        }
    )
    return rows


def test_long_entry_requires_15m_pass_and_5m_trigger():
    engine = EntryEngine(indicator=FakeIndicator())
    strategy_row = {"symbol": "BTCUSDT", "side": "LONG", "status": "PASS", "score": 85}

    result = engine.analyze(strategy_row, _candles(latest_close=102.0, latest_high=103.0))

    assert result["status"] == "ENTRY"
    assert result["side"] == "LONG"
    assert result["score"] >= 75


def test_long_entry_holds_without_previous_candle_break():
    engine = EntryEngine(indicator=FakeIndicator())
    strategy_row = {"symbol": "BTCUSDT", "side": "LONG", "status": "PASS", "score": 85}

    result = engine.analyze(strategy_row, _candles(latest_close=100.0, latest_high=100.5))

    assert result["status"] == "HOLD"
    assert "5m entry trigger not broken" in result["hold_reasons"]
