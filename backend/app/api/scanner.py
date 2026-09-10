from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query

from app.services.scanner_worker import scanner_worker
from app.strategies.scanner_engine import (
    DEFAULT_MIN_VOLUME_RATIO,
    ScannerEngine,
    SUPPORTED_TIMEFRAMES,
    get_scanner_logs,
)

router = APIRouter(prefix="/api/scanner", tags=["scanner"])
engine = ScannerEngine()


@router.post("/run")
def run_scanner(
    markets: list[dict[str, Any]] = Body(...),
    timeframe: str = Query(default="15m"),
    min_quote_volume: float = Query(default=10_000_000, ge=0),
    min_volume_ratio: float = Query(default=DEFAULT_MIN_VOLUME_RATIO, gt=0),
):
    if timeframe not in SUPPORTED_TIMEFRAMES:
        raise HTTPException(status_code=422, detail=f"Unsupported timeframe: {timeframe}")
    if not markets:
        raise HTTPException(status_code=422, detail="Scanner requires at least one market")

    try:
        return engine.scan(
            markets,
            timeframe=timeframe,
            min_quote_volume=min_quote_volume,
            min_volume_ratio=min_volume_ratio,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/logs")
def scanner_logs():
    return {"engine": "Scanner Engine", "logs": get_scanner_logs()}


@router.get("/worker/status")
def scanner_worker_status():
    return scanner_worker.status()
