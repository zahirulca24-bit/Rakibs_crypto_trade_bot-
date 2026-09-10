from fastapi import APIRouter, HTTPException, Query

from app.market_data.binance_client import BinanceMarketDataError
from app.market_data.service import MarketDataService

router = APIRouter(prefix="/api/market", tags=["market"])
service = MarketDataService()


@router.get("/price/{symbol}")
async def get_price(symbol: str):
    try:
        return await service.price(symbol)
    except BinanceMarketDataError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


@router.get("/ticker/{symbol}")
async def get_ticker(symbol: str):
    try:
        return await service.ticker(symbol)
    except BinanceMarketDataError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


@router.get("/klines/{symbol}")
async def get_klines(
    symbol: str,
    interval: str = Query(default="1h"),
    limit: int = Query(default=100, ge=1, le=1000),
):
    try:
        return await service.klines(symbol, interval, limit)
    except BinanceMarketDataError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


@router.get("/orderbook/{symbol}")
async def get_order_book(
    symbol: str,
    limit: int = Query(default=100, ge=5, le=5000),
):
    try:
        return await service.order_book(symbol, limit)
    except BinanceMarketDataError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
