from typing import Any

from fastapi import APIRouter, Body, Query

from app.strategies.scanner_engine import ScannerEngine, get_scanner_logs

router = APIRouter(prefix="/api/scanner", tags=["scanner"])
engine = ScannerEngine()


@router.post("/run")
def run_scanner(
    markets: list[dict[str, Any]] = Body(...),
    timeframe: str = Query(default="15m"),
    min_quote_volume: float = Query(default=10_000_000, ge=0),
):
    return engine.scan(markets, timeframe=timeframe, min_quote_volume=min_quote_volume)


@router.get("/logs")
def scanner_logs():
    return {"engine": "Scanner Engine", "logs": get_scanner_logs()}
