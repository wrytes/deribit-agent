# MKL + libgomp conflict: Intel's threading layer is incompatible with the GCC OpenMP
# library (libgomp.so.1) bundled in the PyTorch base image. Set GNU mode before any
# numpy/torch import so SubprocVecEnv workers inherit a compatible threading context.
import os
os.environ.setdefault("MKL_THREADING_LAYER", "GNU")

"""
FastAPI training sidecar.

NestJS TrainingProcessor calls:
  POST /train   { "session_id": "<cuid>" }   → returns immediately; training runs in background
  POST /run     { "run_id": "<cuid>", "session_id": "<cuid>", "data_from"?, "data_to"?, "env_overrides"? }

When training finishes the sidecar POSTs results to:
  POST {NESTJS_URL}/training/sessions/{session_id}/callback
"""

import asyncio
import json
import logging
import os
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException
from pydantic import BaseModel

from run_session import run_session
from train_session import train_session
from paper_tick import paper_tick

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


def _post_callback(session_id: str, result: dict | None, error: str | None) -> None:
    nestjs_url = os.environ.get("NESTJS_URL", "http://localhost:3030")
    api_key    = os.environ.get("NESTJS_API_KEY", "")
    payload    = json.dumps({"result": result, "error": error}).encode()
    try:
        req = urllib.request.Request(
            f"{nestjs_url}/training/sessions/{session_id}/callback",
            data=payload,
            headers={"Content-Type": "application/json", "x-api-key": api_key},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30):
            pass
        logger.info("Callback sent for session %s (error=%s)", session_id, error)
    except Exception as exc:
        logger.error("Callback to NestJS failed for session %s: %s", session_id, exc)


def _run_and_callback(session_id: str) -> None:
    try:
        result = train_session(session_id)
        _post_callback(session_id, result, None)
    except Exception as exc:
        logger.error("Training failed for session %s: %s", session_id, exc, exc_info=True)
        _post_callback(session_id, None, str(exc))


@app.post("/train")
async def train(req: TrainRequest, background_tasks: BackgroundTasks):
    """
    Accept a training job and return immediately.
    Training runs in the background; results are POSTed back to NestJS via callback.
    """
    logger.info("Accepted train request for session %s", req.session_id)
    background_tasks.add_task(_run_and_callback, req.session_id)
    return {"status": "started", "session_id": req.session_id}


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

class RunRequest(BaseModel):
    run_id:       str
    session_id:   str
    data_from:    Optional[str]  = None  # ISO-8601; defaults to session.dataFrom
    data_to:      Optional[str]  = None  # ISO-8601; defaults to now
    env_overrides: Optional[dict] = None  # merged on top of session env config


# ---------------------------------------------------------------------------
# Paper tick
# ---------------------------------------------------------------------------

class PaperTickRequest(BaseModel):
    run_id: str


@app.post("/paper/tick")
async def paper_tick_endpoint(req: PaperTickRequest):
    """
    Advance a PAPER agent run by one trading day using today's live option prices.
    Blocks until the tick completes and actions are flushed to NestJS.
    """
    logger.info("Paper tick request: run_id=%s", req.run_id)
    try:
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, paper_tick, req.run_id)
        logger.info("Paper tick done: run_id=%s  %s", req.run_id, result)
        return result
    except ValueError as exc:
        logger.warning("Paper tick config error: %s", exc)
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.error("Paper tick failed: run_id=%s  %s", req.run_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


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
            None, run_session, req.run_id, req.session_id, from_dt, to_dt, req.env_overrides
        )
        logger.info("Run complete: run_id=%s  %s", req.run_id, result)
        return result
    except ValueError as exc:
        logger.warning("Run config error: %s", exc)
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.error("Run failed: run_id=%s  %s", req.run_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))
