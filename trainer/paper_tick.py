"""
Paper trading tick — one day of live forward simulation.

Called once per day per active PAPER AgentRun. Reconstructs the env state
from stored paperState, runs a single settle+predict+act cycle using real
Deribit option prices from OptionSnapshot, then flushes events to NestJS.

Flow:
  1. Load AgentRun + TrainingSession + TrainedModel from DB
  2. Load 90 days of history ending today (needed for HV rolling windows)
  3. Reconstruct OptionsEnv from paperState (margin, open positions, equity history)
  4. Fetch today's OptionSnapshot rows → build price_overrides dict
  5. env.settle(price_overrides) → model.predict() → env.act(price_overrides)
  6. Convert events → AgentAction dicts
  7. POST to /agent/runs/:id/actions/batch with currentCapitalBtc + paperState
"""

import logging
from collections import deque
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

import db_writer
from config.defaults import DEFAULT_ENV
from data.loader import build_data, connect, load_candles, load_dvol
from env.black_scholes import delta as bs_delta, theta as bs_theta
from env.options_env import ACTION_DEFS, OptionsEnv
from model.registry import ModelRegistry
from run_session import _action_reason, _events_to_log_entries, _instrument_label

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# DB helpers
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


def _load_option_snapshots(conn, currency: str, capture_date: date) -> list[dict]:
    """Most recent OptionSnapshot per instrument captured on the given date."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT DISTINCT ON (instrument)
                   expiry,
                   strike::float       AS strike,
                   "optionType",
                   "markPrice"::float  AS mark_price,
                   "bidPrice"::float   AS bid_price,
                   "askPrice"::float   AS ask_price
            FROM   "OptionSnapshot"
            WHERE  currency    = %s
              AND  DATE("capturedAt") = %s
              AND  "markPrice" IS NOT NULL
            ORDER  BY instrument, "capturedAt" DESC
            """,
            (currency, capture_date),
        )
        return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Price overrides
# ---------------------------------------------------------------------------

def _parse_expiry_date(expiry_str: str) -> date:
    return datetime.strptime(expiry_str, "%d%b%y").date()


def _build_price_overrides(snapshots: list[dict], today: date) -> dict:
    """
    Build {(strike_int, dte, option_type): price_btc} for env._get_price_btc().
    Mid of bid/ask preferred; mark price as fallback.
    """
    overrides: dict = {}
    for s in snapshots:
        try:
            expiry   = _parse_expiry_date(s["expiry"])
            dte      = (expiry - today).days
            if dte < 0:
                continue
            strike   = int(round(s["strike"]))
            opt_type = s["optionType"]   # "call" | "put"
            bid      = s.get("bid_price") or 0.0
            ask      = s.get("ask_price") or 0.0
            price    = (bid + ask) / 2.0 if (bid > 0 and ask > 0) else (s.get("mark_price") or 0.0)
            if price > 0:
                overrides[(strike, dte, opt_type)] = price
        except Exception:
            pass
    return overrides




# ---------------------------------------------------------------------------
# Env state reconstruction
# ---------------------------------------------------------------------------

def _restore_env_state(env: OptionsEnv, paper_state: dict, margin_balance: float) -> None:
    """Inject stored paper state back into a freshly-created OptionsEnv."""
    env.margin_balance = margin_balance
    env.step_count     = int(paper_state.get("stepCount", 1))

    env._initial_price = float(paper_state.get("initialBtcPrice", env.data[env.idx][0]))
    env._prev_equity   = float(paper_state.get("prevEquity", margin_balance))

    env._equity_history.clear()
    for eq in paper_state.get("equityHistory", [margin_balance]):
        env._equity_history.append(float(eq))

    call_data = paper_state.get("callPos")
    put_data  = paper_state.get("putPos")
    env.call_pos = call_data if call_data else None
    env.put_pos  = put_data  if put_data  else None


def _open_pos_from_env(env: OptionsEnv, today_idx: int, dates: list) -> dict:
    """Rebuild the open_pos dict (for equity accounting in log entries) from env positions."""
    open_pos: dict = {}
    today = dates[today_idx].date() if today_idx < len(dates) else datetime.now(timezone.utc).date()
    for pos in (env.call_pos, env.put_pos):
        if pos is None:
            continue
        expiry_str = (today + timedelta(days=pos["dte"])).strftime("%d%b%y").upper()
        suffix     = "C" if pos["type"] == "call" else "P"
        label      = f"BTC-{expiry_str}-{int(pos['strike'])}-{suffix}"
        open_pos[label] = {
            "size":     pos["size"],
            "mkt_prem": pos.get("prem_btc_unit", 0.0),
        }
    return open_pos


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def paper_tick(run_id: str) -> dict:

    conn = connect()
    try:
        run       = _load_agent_run(conn, run_id)
        session   = _load_training_session(conn, run["sessionId"])
        model_row = _load_latest_model(conn, run["sessionId"])

        today_utc = datetime.now(timezone.utc).date()

        # HV30d rolling window drops the first 30 rows; need ≥60 usable rows after that.
        # Today's candle may not be closed yet, so budget 100 calendar days to always
        # land above the 60-row floor even on the first tick.
        data_to   = datetime(today_utc.year, today_utc.month, today_utc.day, tzinfo=timezone.utc)
        data_from = data_to - timedelta(days=100)

        candles       = load_candles(conn, run["currency"], data_from, data_to)
        dvol_df       = load_dvol(conn, data_from, data_to)
        data, dates   = build_data(candles, dvol_df)

        snapshots = _load_option_snapshots(conn, run["currency"], today_utc)
    finally:
        conn.close()

    logger.info("Paper tick %s: %d option snapshots for %s", run_id, len(snapshots), today_utc)

    hp      = session.get("hyperparams") or {}
    env_cfg = {
        **DEFAULT_ENV,
        **(hp.get("env", {})),
        "initial_margin_btc":     float(run["initialCapitalBtc"]),
        "fast_margin":            False,
        "episode_length":         len(data),
        "randomize_conditioning": False,
    }

    registry    = ModelRegistry(Path(os.environ.get("MODELS_DIR", "/app/models")))
    model, _    = registry.load(model_row["storagePath"])

    today_idx   = len(dates) - 1
    paper_state = run.get("paperState") or {}
    is_first    = not paper_state

    margin_balance = float(run["currentCapitalBtc"] or run["initialCapitalBtc"])

    env = OptionsEnv(data, env_cfg)
    env.reset()
    env.idx = today_idx

    if is_first:
        env.margin_balance = margin_balance
        env._initial_price = float(data[today_idx][0])
        env._prev_equity   = margin_balance
        env._equity_history.clear()
        env._equity_history.append(margin_balance)
        env.step_count     = 0
    else:
        _restore_env_state(env, paper_state, margin_balance)

    price_overrides = _build_price_overrides(snapshots, today_utc)
    open_pos        = _open_pos_from_env(env, today_idx, dates)

    settle_events, settle_obs = env.settle(price_overrides)
    action_id, _              = model.predict(settle_obs, deterministic=True)
    action_id                 = int(action_id)
    _, reward, terminated, truncated, info = env.act(action_id, price_overrides)

    S, dvol, _, _ = data[today_idx]
    S, dvol       = float(S), float(dvol)
    sigma         = env._sigma(dvol)
    current_date  = datetime.combine(today_utc, datetime.min.time(), tzinfo=timezone.utc)

    all_events = info.get("events", [])
    entries    = _events_to_log_entries(all_events, current_date, open_pos, env, S, dvol, sigma, action_id)

    # Append a hold row whenever the model didn't trade, regardless of whether
    # settlement entries (init, marks) already exist.  This ensures every tick
    # always records the model's decision — critical on day 1 where settlement_init
    # is the only event so the fallback `if not entries` would never fire.
    has_trade = any(e.get("actionType") in ("open", "close") for e in entries)
    if not has_trade:
        liability = sum(p["size"] * p["mkt_prem"] for p in open_pos.values())
        equity    = env.margin_balance - liability
        hold_ts   = (current_date + timedelta(milliseconds=len(entries))).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        entries.append({
            "actionType":        "hold",
            "timestamp":         hold_ts,
            "btcPrice":          round(S, 2),
            "marginBalanceBtc":  round(env.margin_balance, 6),
            "equityBtc":         round(equity, 6),
        })

    new_paper_state = {
        "lastTickDate":   today_utc.isoformat(),
        "stepCount":      env.step_count,
        "initialBtcPrice": env._initial_price,
        "prevEquity":     env._prev_equity,
        "equityHistory":  list(env._equity_history),
        "callPos":        env.call_pos,
        "putPos":         env.put_pos,
    }

    db_writer.insert_actions(
        run_id, entries,
        current_capital_btc=env.margin_balance,
        paper_state=new_paper_state,
    )

    logger.info(
        "Paper tick %s done: %d entries, action=%d, equity=%.4f BTC, terminated=%s",
        run_id, len(entries), action_id, env.margin_balance, terminated,
    )

    return {
        "ticked_date":    today_utc.isoformat(),
        "actions_logged": len(entries),
        "action_id":      action_id,
        "equity_btc":     round(env.margin_balance, 6),
        "terminated":     terminated,
    }
