"""
FastAPI training sidecar.

NestJS TrainingProcessor calls:
  POST /train   { "session_id": "<cuid>" }

Returns the metrics dict from train_session.py, which NestJS stores in
TrainedModel and completes the TrainingSession record.
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

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
