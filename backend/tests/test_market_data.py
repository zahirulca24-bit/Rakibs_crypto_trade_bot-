import pytest

from app.market_data.service import MarketDataService


class FakeBinanceClient:
    async def get_price(self, symbol: str):
        return {"symbol": symbol, "price": "67842.10"}

    async def get_ticker(self, symbol: str):
        return {
            "symbol": symbol,
            "lastPrice": "67842.10",
            "priceChange": "1210.20",
            "priceChangePercent": "1.82",
            "highPrice": "68400.00",
            "lowPrice": "66100.00",
            "volume": "12345.67",
            "quoteVolume": "832000000.00",
        }

    async def get_klines(self, symbol: str, interval: str, limit: int):
        return [[1, "10", "12", "9", "11", "100", 2, "0", 0, "0", "0", "0"]]

    async def get_order_book(self, symbol: str, limit: int):
        return {
            "lastUpdateId": 42,
            "bids": [["10", "2"]],
            "asks": [["11", "3"]],
        }


@pytest.mark.asyncio
async def test_price_normalizes_symbol():
    service = MarketDataService(client=FakeBinanceClient())
    result = await service.price("btc/usdt")
    assert result == {"symbol": "BTCUSDT", "price": "67842.10"}


@pytest.mark.asyncio
async def test_klines_are_normalized():
    service = MarketDataService(client=FakeBinanceClient())
    result = await service.klines("btc-usdt", "1h", 1)
    assert result["symbol"] == "BTCUSDT"
    assert result["candles"][0]["close"] == "11"


@pytest.mark.asyncio
async def test_order_book_is_normalized():
    service = MarketDataService(client=FakeBinanceClient())
    result = await service.order_book("BTCUSDT", 5)
    assert result["last_update_id"] == 42
    assert result["bids"][0] == {"price": "10", "quantity": "2"}
