from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query

from app.market_data.binance_client import BinanceMarketDataError
from app.strategies.indicator_engine import IndicatorEngine, get_indicator_logs

router = APIRouter(prefix="/api/indicators", tags=["indicators"])
engine = IndicatorEngine()


@router.post("/run/{symbol}")
async def run_indicator_engine(
    symbol: str,
    timeframe: str = Query(default="15m"),
    limit: int = Query(default=500, ge=200, le=1000),
):
    try:
        return await engine.run(symbol, timeframe=timeframe, limit=limit)
    except BinanceMarketDataError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/logs")
def indicator_logs(
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    today: bool = Query(default=False),
):
    if today:
        now = datetime.now(timezone.utc)
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        end = start + timedelta(days=1)
    return {"engine": "Indicator Engine", "logs": get_indicator_logs(start=start, end=end)}
