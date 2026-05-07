"""
FastAPI training sidecar.

NestJS TrainingProcessor calls:
  POST /train   { "session_id": "<cuid>" }
  POST /run     { "run_id": "<cuid>", "session_id": "<cuid>", "data_from"?, "data_to"? }
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from run_session import run_session
from train_session import train_session

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Trainer sidecar starting on port %s", os.environ.get("PORT", 8000))
    yield
    logger.info("Trainer sidecar shutting down")


app = FastAPI(title="deribit-agent trainer", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Train
# ---------------------------------------------------------------------------

class TrainRequest(BaseModel):
    session_id: str


@app.post("/train")
async def train(req: TrainRequest):
    """
    Run a PPO training session.
    Blocks until training completes (NestJS has a 1-hour timeout).
    Long-running — do not set a short HTTP client timeout.
    """
    logger.info("Received train request for session %s", req.session_id)

    try:
        # Run sync training in a thread so the event loop stays responsive
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, train_session, req.session_id)
        logger.info("Training complete for session %s: %s", req.session_id, result)
        return result
    except ValueError as exc:
        # Data / config errors — 422 so NestJS can distinguish from infra failures
        logger.warning("Training config error for session %s: %s", req.session_id, exc)
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.error("Training failed for session %s: %s", req.session_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

class RunRequest(BaseModel):
    run_id:     str
    session_id: str
    data_from:  Optional[str] = None  # ISO-8601; defaults to session.dataFrom
    data_to:    Optional[str] = None  # ISO-8601; defaults to now


@app.post("/run")
async def run(req: RunRequest):
    """
    Run a trained PPO model on historical data.
    Blocks until the episode completes; logs actions to NestJS via NESTJS_URL.
    Requires NESTJS_API_KEY env var for action callbacks.
    """
    logger.info("Received run request: run_id=%s session_id=%s", req.run_id, req.session_id)

    from_dt = datetime.fromisoformat(req.data_from.replace('Z', '+00:00')) if req.data_from else None
    to_dt   = datetime.fromisoformat(req.data_to.replace('Z', '+00:00'))   if req.data_to   else None

    try:
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, run_session, req.run_id, req.session_id, from_dt, to_dt
        )
        logger.info("Run complete: run_id=%s  %s", req.run_id, result)
        return result
    except ValueError as exc:
        logger.warning("Run config error: %s", exc)
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.error("Run failed: run_id=%s  %s", req.run_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))
