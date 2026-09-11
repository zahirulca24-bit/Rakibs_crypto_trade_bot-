from fastapi import FastAPI

from app.api.router import api_router
from app.core.config import get_settings
from app.services.entry_worker import entry_worker
from app.services.scanner_worker import scanner_worker
from app.services.strategy_worker import strategy_worker

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
)

app.include_router(api_router)


@app.on_event("startup")
async def start_workers() -> None:
    await scanner_worker.restore_persisted_state()
    await scanner_worker.start()
    await strategy_worker.start()
    await entry_worker.start()


@app.on_event("shutdown")
async def stop_workers() -> None:
    await entry_worker.stop()
    await strategy_worker.stop()
    await scanner_worker.stop()


@app.get("/")
def root() -> dict[str, str]:
    return {
        "name": settings.app_name,
        "environment": settings.app_env,
        "status": "running",
    }
