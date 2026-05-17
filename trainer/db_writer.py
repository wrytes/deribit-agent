"""
Direct-DB write helpers — replaces HTTP callbacks and action batch POSTs.
All functions open their own connection, write, and close.
"""
import json
import logging
import uuid
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras

from data.loader import connect

logger = logging.getLogger(__name__)


def _new_id() -> str:
    return str(uuid.uuid4())


def complete_training(session_id: str, result: dict | None, error: str | None) -> None:
    """
    On success: marks TrainingSession COMPLETED + inserts TrainedModel.
    On failure: marks TrainingSession FAILED with errorMessage.
    """
    conn = connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if error:
                cur.execute(
                    """UPDATE "TrainingSession"
                       SET status = 'FAILED', "completedAt" = NOW(), "updatedAt" = NOW(),
                           "errorMessage" = %s
                       WHERE id = %s""",
                    (error, session_id),
                )
                logger.info("Training session %s marked FAILED", session_id)
            else:
                # Carry over base_timesteps from resume runs
                cur.execute('SELECT hyperparams FROM "TrainingSession" WHERE id = %s', (session_id,))
                session_row = cur.fetchone()
                hp = (session_row or {}).get("hyperparams") or {}
                if isinstance(hp, str):
                    hp = json.loads(hp)
                base_ts    = int(hp.get("base_timesteps", 0))
                total_ts   = int(result.get("total_timesteps", 0)) + base_ts

                metadata = {
                    k: result[k]
                    for k in ("obs_version", "obs_dims", "obs_features", "action_dims",
                              "data_columns", "env_version", "policy")
                    if k in result
                }

                model_id = _new_id()
                cur.execute(
                    """INSERT INTO "TrainedModel"
                       (id, "sessionId", name, "storagePath", "storageType",
                        "sizeBytes", "meanReward", "stdReward", metadata, "createdAt")
                       VALUES (%s, %s, %s, %s, 'local', %s, %s, %s, %s, NOW())""",
                    (
                        model_id,
                        session_id,
                        result.get("model_name", session_id),
                        result.get("model_path", ""),
                        int(result.get("size_bytes") or 0),
                        result.get("mean_reward", 0.0),
                        result.get("std_reward", 0.0),
                        json.dumps(metadata),
                    ),
                )
                cur.execute(
                    """UPDATE "TrainingSession"
                       SET status = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW(),
                           "totalTimesteps" = %s, "finalReward" = %s
                       WHERE id = %s""",
                    (total_ts or None, result.get("final_reward"), session_id),
                )
                logger.info(
                    "Training session %s marked COMPLETED — model %s  total_ts=%d",
                    session_id, model_id, total_ts,
                )
        conn.commit()
    finally:
        conn.close()


def insert_actions(
    run_id: str,
    actions: list[dict],
    current_capital_btc: float | None = None,
    paper_state: dict | None = None,
    chunk_size: int = 500,
) -> None:
    """
    Bulk-insert AgentAction rows and update AgentRun counters.
    Pass current_capital_btc + paper_state to also update paperState on the run.
    """
    if not actions and current_capital_btc is None and paper_state is None:
        return

    total_pnl = sum(float(a.get("pnlBtc") or 0) for a in actions)

    conn = connect()
    try:
        with conn.cursor() as cur:
            for start in range(0, max(len(actions), 1), chunk_size):
                chunk = actions[start : start + chunk_size]
                if not chunk:
                    break

                values: list = []
                placeholders: list[str] = []
                for a in chunk:
                    ts_val = a.get("timestamp")
                    if isinstance(ts_val, str):
                        try:
                            ts_val = datetime.fromisoformat(ts_val.replace("Z", "+00:00"))
                        except Exception:
                            ts_val = None

                    values.extend([
                        _new_id(),
                        run_id,
                        ts_val,
                        a.get("actionType"),
                        a.get("instrument"),
                        a.get("quantity"),
                        a.get("price"),
                        a.get("orderId"),
                        a.get("btcPrice"),
                        a.get("delta"),
                        a.get("ivRank"),
                        a.get("executedPrice"),
                        a.get("pnlBtc"),
                        a.get("feeBtc"),
                        a.get("thetaBtc"),
                        a.get("cashflowBtc"),
                        a.get("equityBtc"),
                        a.get("marginBalanceBtc"),
                        a.get("reason"),
                    ])
                    placeholders.append(
                        "(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
                    )

                cur.execute(
                    f"""INSERT INTO "AgentAction"
                        (id,"runId","timestamp","actionType","instrument","quantity","price",
                         "orderId","btcPrice","delta","ivRank","executedPrice","pnlBtc",
                         "feeBtc","thetaBtc","cashflowBtc","equityBtc","marginBalanceBtc","reason")
                        VALUES {",".join(placeholders)}""",
                    values,
                )

            # Update AgentRun counters
            set_parts: list[str] = ['"updatedAt" = NOW()']
            params: list = []
            if actions:
                set_parts.append('"totalActions" = "totalActions" + %s')
                params.append(len(actions))
            if total_pnl:
                set_parts.append('"realizedPnlBtc" = "realizedPnlBtc" + %s')
                params.append(total_pnl)
            if current_capital_btc is not None:
                set_parts.append('"currentCapitalBtc" = %s')
                params.append(current_capital_btc)
            if paper_state is not None:
                set_parts.append('"paperState" = %s')
                params.append(json.dumps(paper_state))

            params.append(run_id)
            cur.execute(
                f'UPDATE "AgentRun" SET {", ".join(set_parts)} WHERE id = %s',
                params,
            )
        conn.commit()
        logger.info("Inserted %d actions for run %s", len(actions), run_id)
    finally:
        conn.close()


def set_pending_action(run_id: str, pending_action: dict) -> None:
    """Merge pendingAction into AgentRun.liveState without touching lastTickDate."""
    conn = connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute('SELECT "liveState" FROM "AgentRun" WHERE id = %s', (run_id,))
            row = cur.fetchone()
            if not row:
                logger.warning("set_pending_action: AgentRun %s not found", run_id)
                return
            live_state = dict(row["liveState"]) if row["liveState"] else {}
            live_state["pendingAction"] = pending_action
            cur.execute(
                'UPDATE "AgentRun" SET "liveState" = %s, "updatedAt" = NOW() WHERE id = %s',
                (json.dumps(live_state), run_id),
            )
        conn.commit()
        logger.info(
            "Wrote pendingAction for live run %s: %s",
            run_id, pending_action.get("action_type"),
        )
    finally:
        conn.close()


def complete_run(run_id: str) -> None:
    """Mark an AgentRun COMPLETED."""
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE "AgentRun"
                   SET status = 'COMPLETED', "stoppedAt" = NOW(), "updatedAt" = NOW()
                   WHERE id = %s""",
                (run_id,),
            )
        conn.commit()
        logger.info("AgentRun %s marked COMPLETED", run_id)
    finally:
        conn.close()


def fail_run(run_id: str) -> None:
    """Mark an AgentRun ERROR."""
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE "AgentRun"
                   SET status = 'ERROR', "stoppedAt" = NOW(), "updatedAt" = NOW()
                   WHERE id = %s""",
                (run_id,),
            )
        conn.commit()
        logger.info("AgentRun %s marked ERROR", run_id)
    finally:
        conn.close()
