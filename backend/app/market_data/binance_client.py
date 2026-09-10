from typing import Any

import httpx


class BinanceMarketDataError(Exception):
    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class BinanceClient:
    def __init__(self, base_url: str = "https://data-api.binance.vision", timeout: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def _get(self, path: str, params: dict[str, Any]) -> Any:
        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout) as client:
                response = await client.get(path, params=params)
        except httpx.RequestError as exc:
            raise BinanceMarketDataError("Binance market data service is unavailable") from exc

        if response.is_error:
            try:
                payload = response.json()
                message = payload.get("msg", "Binance request failed")
            except ValueError:
                message = "Binance request failed"
            status_code = 400 if response.status_code < 500 else 502
            raise BinanceMarketDataError(message, status_code=status_code)

        return response.json()

    async def get_price(self, symbol: str) -> dict[str, Any]:
        return await self._get("/api/v3/ticker/price", {"symbol": symbol})

    async def get_ticker(self, symbol: str) -> dict[str, Any]:
        return await self._get("/api/v3/ticker/24hr", {"symbol": symbol})

    async def get_klines(self, symbol: str, interval: str, limit: int) -> list[list[Any]]:
        return await self._get(
            "/api/v3/klines",
            {"symbol": symbol, "interval": interval, "limit": limit},
        )

    async def get_order_book(self, symbol: str, limit: int) -> dict[str, Any]:
        return await self._get("/api/v3/depth", {"symbol": symbol, "limit": limit})
