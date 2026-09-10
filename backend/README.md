# Backend

FastAPI foundation for Rakib's Crypto Trade Bot.

## Current scope

- FastAPI application entrypoint
- Environment-based settings
- API router structure
- Health check endpoint
- Basic health endpoint test

No exchange integration, trading strategy, risk logic, or order execution is included yet.

## Run locally

From the `backend` directory:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

On Windows PowerShell, activate with:

```powershell
.venv\Scripts\Activate.ps1
```

Then open `http://127.0.0.1:8000/health`.
