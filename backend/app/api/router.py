from fastapi import APIRouter

from app.api.health import router as health_router
from app.api.market import router as market_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(market_router)
