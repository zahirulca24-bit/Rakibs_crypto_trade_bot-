from fastapi import APIRouter, HTTPException

from app.services.strategy_worker import strategy_worker
from app.strategies.strategy_engine import get_strategy_logs

router = APIRouter(prefix="/api/strategy", tags=["strategy"])


@router.post("/run")
async def run_strategy():
    """Run the 15m Strategy Engine against the current locked Scanner Top30."""
    try:
        return await strategy_worker.run_once()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/logs")
def strategy_logs():
    return {"engine": "Strategy Engine", "logs": get_strategy_logs()}


@router.get("/worker/status")
def strategy_worker_status():
    return strategy_worker.status()
