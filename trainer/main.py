# MKL + libgomp conflict: Intel's threading layer is incompatible with the GCC OpenMP
# library (libgomp.so.1) bundled in the PyTorch base image. Set GNU mode before any
# numpy/torch import so SubprocVecEnv workers inherit a compatible threading context.
import os
os.environ.setdefault("MKL_THREADING_LAYER", "GNU")

"""
DB-coupled trainer polling loop.

Every POLL_INTERVAL seconds, the loop checks PostgreSQL for pending work:
  - TrainingSession WHERE status='RUNNING'   → train_session
  - AgentRun BACKTEST ACTIVE totalActions=0  → run_session
  - AgentRun PAPER ACTIVE not ticked today   → paper_tick
  - AgentRun LIVE ACTIVE not ticked today    → live_predict (writes pendingAction)

NestJS executes Deribit orders once it sees a LIVE run's pendingAction populated.
"""

import logging
import time
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras

import db_writer
from data.loader import connect
from live_predict import live_predict
from paper_tick import paper_tick
from run_session import run_session
from train_session import train_session

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))


def _poll_work() -> dict:
    """Query DB for one unit of work in each category."""
    today = datetime.now(timezone.utc).date().isoformat()
    conn  = connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                'SELECT id FROM "TrainingSession" WHERE status = %s LIMIT 1',
                ("RUNNING",),
            )
            session_row = cur.fetchone()

            cur.execute(
                """SELECT id, "sessionId" FROM "AgentRun"
                   WHERE "runType" = 'BACKTEST' AND status = 'ACTIVE' AND "totalActions" = 0
                   LIMIT 1""",
            )
            backtest_row = cur.fetchone()

            cur.execute(
                """SELECT id FROM "AgentRun"
                   WHERE "runType" = 'PAPER' AND status = 'ACTIVE'
                     AND ("paperState" IS NULL OR "paperState"->>'lastTickDate' != %s)
                   LIMIT 1""",
                (today,),
            )
            paper_row = cur.fetchone()

            cur.execute(
                """SELECT id FROM "AgentRun"
                   WHERE "runType" = 'LIVE' AND status = 'ACTIVE'
                     AND ("liveState" IS NULL
                          OR ("liveState"->>'lastTickDate' != %s
                              AND "liveState"->>'pendingAction' IS NULL))
                   LIMIT 1""",
                (today,),
            )
            live_row = cur.fetchone()
    finally:
        conn.close()

    return {
        "session":  dict(session_row)  if session_row  else None,
        "backtest": dict(backtest_row) if backtest_row else None,
        "paper":    dict(paper_row)    if paper_row    else None,
        "live":     dict(live_row)     if live_row     else None,
    }


def _dispatch(work: dict) -> None:
    if work["session"]:
        session_id = work["session"]["id"]
        logger.info("Training session %s: starting", session_id)
        try:
            result = train_session(session_id)
            db_writer.complete_training(session_id, result, None)
        except Exception as exc:
            logger.error("Training session %s failed: %s", session_id, exc, exc_info=True)
            db_writer.complete_training(session_id, None, str(exc))

    if work["backtest"]:
        run_id     = work["backtest"]["id"]
        session_id = work["backtest"]["sessionId"]
        logger.info("Backtest run %s: starting", run_id)
        try:
            run_session(run_id, session_id)
            db_writer.complete_run(run_id)
        except Exception as exc:
            logger.error("Backtest run %s failed: %s", run_id, exc, exc_info=True)
            db_writer.fail_run(run_id)

    if work["paper"]:
        run_id = work["paper"]["id"]
        logger.info("Paper tick %s: starting", run_id)
        try:
            paper_tick(run_id)
        except Exception as exc:
            logger.error("Paper tick %s failed: %s", run_id, exc, exc_info=True)

    if work["live"]:
        run_id = work["live"]["id"]
        logger.info("Live predict %s: starting", run_id)
        try:
            live_predict(run_id)
        except Exception as exc:
            logger.error("Live predict %s failed: %s", run_id, exc, exc_info=True)


if __name__ == "__main__":
    logger.info("Trainer polling loop starting (interval=%ds)", POLL_INTERVAL)
    while True:
        try:
            work = _poll_work()
            _dispatch(work)
        except Exception as exc:
            logger.error("Poll loop error: %s", exc, exc_info=True)
        time.sleep(POLL_INTERVAL)
