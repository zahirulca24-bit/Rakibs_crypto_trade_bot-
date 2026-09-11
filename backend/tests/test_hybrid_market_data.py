import json

from app.services.hybrid_market_data import HybridFuturesMarketData


def test_closed_websocket_kline_updates_cached_series():
    service = HybridFuturesMarketData()
    service._candles[("BTCUSDT", "5m")] = [
        [1000, "1", "2", "0.5", "1.5", "10", 1999, "0", 0, "0", "0", "0"]
    ]

    service._handle_ws_message(
        json.dumps(
            {
                "e": "kline",
                "s": "BTCUSDT",
                "k": {
                    "t": 2000,
                    "T": 2999,
                    "s": "BTCUSDT",
                    "i": "5m",
                    "o": "1.5",
                    "c": "1.8",
                    "h": "2.0",
                    "l": "1.4",
                    "v": "12",
                    "q": "20",
                    "n": 5,
                    "V": "6",
                    "Q": "10",
                    "x": True,
                },
            }
        )
    )

    rows = service._candles[("BTCUSDT", "5m")]
    assert len(rows) == 2
    assert rows[-1][0] == 2000
    assert rows[-1][4] == "1.8"


def test_open_websocket_kline_is_not_cached():
    service = HybridFuturesMarketData()

    service._handle_ws_message(
        json.dumps(
            {
                "e": "kline",
                "s": "BTCUSDT",
                "k": {"i": "5m", "x": False},
            }
        )
    )

    assert service._candles == {}
