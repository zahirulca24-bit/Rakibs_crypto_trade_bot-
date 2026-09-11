from fastapi import APIRouter, HTTPException

from app.services.futures_market_data import BinanceRateLimitError
from app.services.scanner_worker import ScannerBusyError, scanner_worker
from app.strategies.scanner_engine import get_scanner_logs

router = APIRouter(prefix="/api/scanner", tags=["scanner"])


@router.post("/run")
async def run_scanner():
    """Run the 1H USD-M Scanner manually using the shared market-data hub."""
    try:
        return await scanner_worker.run_once()
    except BinanceRateLimitError as exc:
        raise HTTPException(
            status_code=429,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_seconds)},
        ) from exc
    except ScannerBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/logs")
def scanner_logs():
    return {"engine": "Scanner Engine", "logs": get_scanner_logs()}


@router.get("/worker/status")
def scanner_worker_status():
    return scanner_worker.status()
