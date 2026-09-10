from typing import Any

from app.market_data.binance_client import BinanceClient


class MarketDataService:
    def __init__(self, client: BinanceClient | None = None) -> None:
        self.client = client or BinanceClient()

    @staticmethod
    def normalize_symbol(symbol: str) -> str:
        return symbol.replace("/", "").replace("-", "").upper()

    async def price(self, symbol: str) -> dict[str, Any]:
        normalized = self.normalize_symbol(symbol)
        data = await self.client.get_price(normalized)
        return {"symbol": data["symbol"], "price": data["price"]}

    async def ticker(self, symbol: str) -> dict[str, Any]:
        normalized = self.normalize_symbol(symbol)
        data = await self.client.get_ticker(normalized)
        return {
            "symbol": data["symbol"],
            "last_price": data["lastPrice"],
            "price_change": data["priceChange"],
            "price_change_percent": data["priceChangePercent"],
            "high_price": data["highPrice"],
            "low_price": data["lowPrice"],
            "volume": data["volume"],
            "quote_volume": data["quoteVolume"],
        }

    async def klines(self, symbol: str, interval: str, limit: int) -> dict[str, Any]:
        normalized = self.normalize_symbol(symbol)
        rows = await self.client.get_klines(normalized, interval, limit)
        candles = [
            {
                "open_time": row[0],
                "open": row[1],
                "high": row[2],
                "low": row[3],
                "close": row[4],
                "volume": row[5],
                "close_time": row[6],
            }
            for row in rows
        ]
        return {"symbol": normalized, "interval": interval, "candles": candles}

    async def order_book(self, symbol: str, limit: int) -> dict[str, Any]:
        normalized = self.normalize_symbol(symbol)
        data = await self.client.get_order_book(normalized, limit)
        return {
            "symbol": normalized,
            "last_update_id": data["lastUpdateId"],
            "bids": [{"price": price, "quantity": qty} for price, qty in data["bids"]],
            "asks": [{"price": price, "quantity": qty} for price, qty in data["asks"]],
        }
