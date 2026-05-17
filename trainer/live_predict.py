"""
Stateless prediction for a LIVE AgentRun.

Called by NestJS once per day (after mark-to-market). Reconstructs the env
observation from liveState (real open positions + equity history stored in DB),
runs settle() + model.predict() + act() on a throw-away env, then returns the
model's decision as structured trade parameters.

NestJS translates these into real Deribit orders — Python never touches the API.

Returns:
  action_id:   int (0 = hold)
  action_type: "hold" | "open" | "close" | "close_call" | "close_put"
  legs:        list of {side, option_type, strike, dte, size, target_delta}  (for open)
  close_legs:  list of "call" | "put"                                        (for close)
  terminated:  bool (model wants to stop — max drawdown hit)
"""

import logging
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

import db_writer
from config.defaults import DEFAULT_ENV
from data.loader import build_data, connect, load_candles, load_dvol
from env.options_env import OptionsEnv
from model.registry import ModelRegistry

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# DB helpers (reuse patterns from paper_tick.py)
# ---------------------------------------------------------------------------

def _load_agent_run(conn, run_id: str) -> dict:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT * FROM "AgentRun" WHERE id = %s', (run_id,))
        row = cur.fetchone()
    if not row:
        raise ValueError(f"AgentRun {run_id!r} not found")
    return dict(row)


def _load_training_session(conn, session_id: str) -> dict:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT * FROM "TrainingSession" WHERE id = %s', (session_id,))
        row = cur.fetchone()
    if not row:
        raise ValueError(f"TrainingSession {session_id!r} not found")
    return dict(row)


def _load_latest_model(conn, session_id: str) -> dict:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT * FROM "TrainedModel" WHERE "sessionId" = %s ORDER BY "createdAt" DESC LIMIT 1',
            (session_id,),
        )
        row = cur.fetchone()
    if not row:
        raise ValueError(f"No trained model for session {session_id!r}")
    return dict(row)


# ---------------------------------------------------------------------------
# Env state reconstruction from liveState
# ---------------------------------------------------------------------------

def _restore_from_live_state(env: OptionsEnv, live_state: dict, margin_balance: float, today: date) -> None:
    env.margin_balance = margin_balance
    env.step_count     = int(live_state.get("stepCount", 1))
    env._initial_price = float(live_state.get("initialBtcPrice", env.data[env.idx][0]))
    env._prev_equity   = float(live_state.get("prevEquity", margin_balance))

    env._equity_history.clear()
    for eq in live_state.get("equityHistory", [margin_balance]):
        env._equity_history.append(float(eq))

    # Restore positions — DTE is computed from expiryDate (not stored DTE which would go stale)
    for pos in live_state.get("openPositions", []):
        expiry_date = date.fromisoformat(pos["expiryDate"])
        dte = max(0, (expiry_date - today).days)
        pos_dict = {
            "strike":        float(pos["strike"]),
            "prem_btc_unit": float(pos["entryPremBtc"]),
            "fee_btc_unit":  float(pos["entryPremBtc"]) * 0.002,
            "size":          float(pos["size"]),
            "dte":           dte,
            "type":          pos["optionType"],
        }
        if pos["optionType"] == "call":
            env.call_pos = pos_dict
        else:
            env.put_pos  = pos_dict


# ---------------------------------------------------------------------------
# Action decoder — interprets env events into NestJS-ready trade params
# ---------------------------------------------------------------------------

def _decode_events(action_id: int, events: list[dict]) -> dict:
    """
    Translate env events from act() into structured trade parameters.

    The env already ran the margin check: if margin was too tight to open,
    no open events are emitted and we return hold.
    """
    trade_events = [e for e in events if e.get("type") in ("open", "close")]

    if not trade_events:
        return {
            "action_id":   action_id,
            "action_type": "hold",
            "legs":        [],
            "close_legs":  [],
        }

    legs:       list[dict] = []
    close_legs: list[str]  = []

    for evt in trade_events:
        if evt["type"] == "open":
            legs.append({
                "side":         "sell",
                "option_type":  evt["option_type"],
                "strike":       int(round(evt["strike"])),
                "dte":          int(evt["dte"]),
                "size":         float(evt["size"]),
            })
        elif evt["type"] == "close":
            close_legs.append(evt["option_type"])

    if legs:
        action_type = "open"
    elif len(close_legs) > 1:
        action_type = "close"
    elif len(close_legs) == 1:
        action_type = f"close_{close_legs[0]}"
    else:
        action_type = "hold"

    return {
        "action_id":   action_id,
        "action_type": action_type,
        "legs":        legs,
        "close_legs":  close_legs,
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def live_predict(run_id: str) -> dict:
    conn = connect()
    try:
        run       = _load_agent_run(conn, run_id)
        session   = _load_training_session(conn, run["sessionId"])
        model_row = _load_latest_model(conn, run["sessionId"])

        today_utc = datetime.now(timezone.utc).date()
        data_to   = datetime(today_utc.year, today_utc.month, today_utc.day, tzinfo=timezone.utc)
        data_from = data_to - timedelta(days=100)

        candles     = load_candles(conn, run["currency"], data_from, data_to)
        dvol_df     = load_dvol(conn, data_from, data_to)
        data, dates = build_data(candles, dvol_df)
    finally:
        conn.close()

    initial_capital = float(run["initialCapitalBtc"] or 0)
    if initial_capital <= 0:
        raise ValueError(
            f"AgentRun {run_id!r} has initialCapitalBtc={initial_capital} — "
            "live run was likely created before the Deribit balance was fetched. "
            "Delete and recreate the agent with an active Deribit account connected."
        )

    hp      = session.get("hyperparams") or {}
    env_cfg = {
        **DEFAULT_ENV,
        **(hp.get("env", {})),
        "initial_margin_btc":     initial_capital,
        "fast_margin":            False,
        "episode_length":         len(data),
        "randomize_conditioning": False,
    }

    registry  = ModelRegistry(Path(os.environ.get("MODELS_DIR", "/app/models")))
    model, _  = registry.load(model_row["storagePath"])

    today_idx      = len(dates) - 1
    live_state     = run.get("liveState") or {}
    margin_balance = float(run["currentCapitalBtc"] or run["initialCapitalBtc"])

    env = OptionsEnv(data, env_cfg)
    env.reset()
    env.idx = today_idx

    if live_state:
        _restore_from_live_state(env, live_state, margin_balance, today_utc)
    else:
        env.margin_balance = margin_balance
        env._initial_price = float(data[today_idx][0])
        env._prev_equity   = margin_balance
        env._equity_history.clear()
        env._equity_history.append(margin_balance)
        env.step_count = 0

    # Run settle → predict → act on this throw-away env.
    # Results inform NestJS what to execute; NestJS owns the real accounting.
    _, settle_obs = env.settle()
    action_id, _  = model.predict(settle_obs, deterministic=True)
    action_id     = int(action_id)

    _, _, terminated, _, info = env.act(action_id)
    all_events = info.get("events", [])

    result = _decode_events(action_id, all_events)
    result["terminated"] = terminated

    logger.info(
        "Live predict %s: action_id=%d type=%s legs=%d terminated=%s",
        run_id, action_id, result["action_type"], len(result["legs"]), terminated,
    )

    db_writer.set_pending_action(run_id, result)
    return result
