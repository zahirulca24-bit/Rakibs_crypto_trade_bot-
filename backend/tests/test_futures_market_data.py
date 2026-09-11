from app.services.futures_market_data import _latest_expected_close, _merge_candles


def test_merge_candles_replaces_same_open_time_and_sorts():
    current = [
        {
            "open_time": 2,
            "open": "2",
            "high": "2",
            "low": "2",
            "close": "2",
            "volume": "2",
            "close_time": 0,
        },
        {
            "open_time": 1,
            "open": "1",
            "high": "1",
            "low": "1",
            "close": "1",
            "volume": "1",
            "close_time": 0,
        },
    ]
    incoming = [
        {
            "open_time": 2,
            "open": "2",
            "high": "3",
            "low": "1",
            "close": "2.5",
            "volume": "5",
            "close_time": 0,
        }
    ]

    rows = _merge_candles(current, incoming)

    assert [row["open_time"] for row in rows] == [1, 2]
    assert rows[-1]["close"] == "2.5"


def test_latest_expected_close_uses_previous_closed_slot():
    assert _latest_expected_close("5m", now_ms=600_000) == 599_999
    assert _latest_expected_close("15m", now_ms=1_800_000) == 1_799_999
    assert _latest_expected_close("1h", now_ms=7_200_000) == 7_199_999
