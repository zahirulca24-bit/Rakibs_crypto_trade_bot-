from fastapi import APIRouter, HTTPException

from app.services.hybrid_market_data import hybrid_market_data
from app.services.scanner_worker import scanner_worker
from app.strategies.scanner_engine import get_scanner_logs

router = APIRouter(prefix="/api/scanner", tags=["scanner"])


@router.post("/run")
async def run_scanner():
    """Run the same live multi-timeframe USD-M scanner used by the background worker."""
    try:
        return await scanner_worker.run_once()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/logs")
def scanner_logs():
    return {"engine": "Scanner Engine", "logs": get_scanner_logs()}


@router.get("/worker/status")
def scanner_worker_status():
    return scanner_worker.status()


@router.get("/market-data/status")
def market_data_status():
    return hybrid_market_data.status()
