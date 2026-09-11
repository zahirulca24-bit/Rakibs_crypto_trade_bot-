from fastapi import APIRouter

from app.services.entry_worker import entry_worker
from app.strategies.entry_engine import get_entry_logs

router = APIRouter(prefix="/api/entry", tags=["entry"])


@router.get("/logs")
def entry_logs():
    return {"engine": "Entry Engine", "logs": get_entry_logs()}


@router.get("/worker/status")
def entry_worker_status():
    return entry_worker.status()
