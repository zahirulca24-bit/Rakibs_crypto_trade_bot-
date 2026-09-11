from fastapi import APIRouter

from app.api.entry import router as entry_router
from app.api.health import router as health_router
from app.api.indicators import router as indicators_router
from app.api.market import router as market_router
from app.api.scanner import router as scanner_router
from app.api.strategy import router as strategy_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(market_router)
api_router.include_router(indicators_router)
api_router.include_router(scanner_router)
api_router.include_router(strategy_router)
api_router.include_router(entry_router)
