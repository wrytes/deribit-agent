"""
Inference loop for a trained PPO model.

run_session(run_id, session_id, data_from, data_to, env_overrides)
  1. Loads TrainingSession config and TrainedModel path from DB
  2. Fetches candle + DVOL data for the date range
  3. Runs one PPO episode (deterministic) from step 0
  4. POSTs structured accounting events to NestJS via NESTJS_URL + NESTJS_API_KEY
     Each day emits: settlement_init (day 1), settlement_expired, settlement_unrealized,
     then open/close trade events per leg (one entry per instrument).
  5. Returns summary metrics
"""

import json
import logging
import os
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

from config.defaults import DEFAULT_ENV
from data.loader import build_data, connect, load_candles, load_dvol, load_session
from env.black_scholes import delta as bs_delta, theta as bs_theta
from env.options_env import ACTION_DEFS, OptionsEnv
from model.registry import ModelRegistry

logger = logging.getLogger(__name__)


def _action_reason(action_id: int) -> str:
    defn = ACTION_DEFS[action_id]
    if defn is None:
        return "hold"
    if defn == "close":
        return "close all"
    if isinstance(defn, dict) and "close_pct" in defn:
        return f"close ≥{int(defn['close_pct'] * 100)}% profit"
    parts = []
    if "call_delta" in defn:
        parts.append(f"Δ{int(defn['call_delta'] * 100)} call")
    if "put_delta" in defn:
        parts.append(f"Δ{int(abs(defn['put_delta']) * 100)} put")
    return "sell " + " + ".join(parts)


def _instrument_label(current_date: datetime, dte: int, strike: float, opt_type: str) -> str:
    expiry = (current_date + timedelta(days=dte)).strftime("%d%b%y").upper()
    suffix = "C" if opt_type == "call" else "P"
    return f"BTC-{expiry}-{int(strike)}-{suffix}"


def _events_to_log_entries(
    events: list[dict],
    current_date: datetime,
    ts: str,
    env,
    S: float,
    dvol: float,
    sigma: float,
    action_id: int,
) -> list[dict]:
    """Convert env step events to AgentAction payload dicts."""
    entries = []
    reason = _action_reason(action_id)

    for evt in events:
        etype = evt["type"]

        if etype == "settlement_init":
            entries.append({
                "actionType":        "settlement_init",
                "timestamp":         ts,
                "btcPrice":          round(evt["btc_price"], 2),
                "marginBalanceBtc":  round(evt["margin_balance_btc"], 6),
                "reason":            "initial balance",
            })

        elif etype == "settlement_expired":
            label = _instrument_label(current_date, 0, evt["strike"], evt["option_type"])
            itm   = evt["intrinsic_btc_unit"] > 0
            entries.append({
                "actionType":        "settlement_expired",
                "timestamp":         ts,
                "instrument":        label,
                "btcPrice":          round(evt["btc_price"], 2),
                "quantity":          round(evt["size"], 4),
                "price":             round(evt["intrinsic_btc_unit"], 6),
                "executedPrice":     round(evt["premium_btc_unit"], 6),
                "pnlBtc":            round(evt["pnl_btc"], 6),
                "feeBtc":            0.0,
                "marginBalanceBtc":  round(evt["margin_balance_btc"], 6),
                "reason":            "expired ITM" if itm else "expired OTM",
            })

        elif etype == "settlement_unrealized":
            label     = _instrument_label(current_date, evt["dte"], evt["strike"], evt["option_type"])
            T         = evt["dte"] / 365.0
            leg_delta = bs_delta(S, evt["strike"], T, env.r, sigma, evt["option_type"])
            leg_theta = bs_theta(S, evt["strike"], T, env.r, sigma, evt["option_type"]) / S
            entries.append({
                "actionType":        "settlement_unrealized",
                "timestamp":         ts,
                "instrument":        label,
                "btcPrice":          round(evt["btc_price"], 2),
                "quantity":          round(evt["size"], 4),
                "price":             round(evt["current_btc_unit"], 6),
                "executedPrice":     round(evt["premium_btc_unit"], 6),
                "delta":             round(leg_delta, 4),
                "thetaBtc":          round(leg_theta, 8),
                "ivRank":            round(dvol, 2),
                "marginBalanceBtc":  round(evt["margin_balance_btc"], 6),
                "reason":            "daily mark",
            })

        elif etype == "open":
            label     = _instrument_label(current_date, evt["dte"], evt["strike"], evt["option_type"])
            T         = evt["dte"] / 365.0
            leg_delta = bs_delta(S, evt["strike"], T, env.r, sigma, evt["option_type"])
            leg_theta = bs_theta(S, evt["strike"], T, env.r, sigma, evt["option_type"]) / S
            entries.append({
                "actionType":        "open",
                "timestamp":         ts,
                "instrument":        label,
                "btcPrice":          round(evt["btc_price"], 2),
                "quantity":          round(evt["size"], 4),
                "price":             round(evt["premium_btc_unit"], 6),
                "delta":             round(leg_delta, 4),
                "thetaBtc":          round(leg_theta, 8),
                "ivRank":            round(dvol, 2),
                # pnlBtc omitted — no P&L at open (premium offsets obligation)
                "feeBtc":            round(evt["fee_btc"], 8),
                "marginBalanceBtc":  round(evt["margin_balance_btc"], 6),
                "reason":            reason,
            })

        elif etype == "close":
            label = _instrument_label(current_date, evt["dte"], evt["strike"], evt["option_type"])
            entries.append({
                "actionType":        "close",
                "timestamp":         ts,
                "instrument":        label,
                "btcPrice":          round(evt["btc_price"], 2),
                "quantity":          round(evt["size"], 4),
                "price":             round(evt["cost_btc_unit"], 6),
                "executedPrice":     round(evt["premium_btc_unit"], 6),
                "pnlBtc":            round(evt["pnl_btc"], 6),
                "feeBtc":            round(evt["fee_btc"], 8),
                "marginBalanceBtc":  round(evt["margin_balance_btc"], 6),
                "reason":            reason,
            })

    return entries


def _flush_actions(nestjs_url: str, api_key: str, run_id: str, actions: list[dict], chunk_size: int = 200) -> None:
    """POST actions in chunks to stay within the server body-size limit. Raises on any failure."""
    if not actions:
        return
    import urllib.error
    for start in range(0, len(actions), chunk_size):
        chunk = actions[start : start + chunk_size]
        data = json.dumps({"actions": chunk}).encode()
        req = urllib.request.Request(
            f"{nestjs_url}/agent/runs/{run_id}/actions/batch",
            data=data,
            headers={"Content-Type": "application/json", "x-api-key": api_key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                logger.info("Flushed actions %d–%d → HTTP %s", start, start + len(chunk), resp.status)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors="replace")
            raise RuntimeError(
                f"Batch flush failed at chunk {start}–{start + len(chunk)}: HTTP {exc.code} — {body}"
            ) from exc


def run_session(
    run_id: str,
    session_id: str,
    data_from=None,
    data_to=None,
    env_overrides: dict | None = None,
) -> dict:
    nestjs_url = os.environ.get("NESTJS_URL", "http://localhost:3030")
    api_key    = os.environ.get("NESTJS_API_KEY", "")

    # ── DB: session config + model path ───────────────────────────────────────
    conn = connect()
    try:
        session = load_session(conn, session_id)

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                'SELECT * FROM "TrainedModel" WHERE "sessionId" = %s'
                ' ORDER BY "createdAt" DESC LIMIT 1',
                (session_id,),
            )
            model_row = cur.fetchone()

        if not model_row:
            raise ValueError(f"No trained model found for session {session_id!r}")

        from_dt = data_from or session["dataFrom"]
        to_dt   = data_to   or datetime.now(timezone.utc)

        # Load 45 extra calendar days (~30 trading days) before from_dt so that
        # 30-day rolling lookbacks in the observation have real prior data from step 1.
        _WARMUP_DAYS = 45
        warmup_from = from_dt - timedelta(days=_WARMUP_DAYS)

        candles = load_candles(conn, session["currency"], warmup_from, to_dt)
        dvol_df = load_dvol(conn, warmup_from, to_dt)
    finally:
        conn.close()

    data, dates = build_data(candles, dvol_df)

    # Find the first row index whose date falls on or after the requested from_dt.
    # Rows before it are warmup — the 45-day load window above provides ~32 trading
    # days of prior data for rolling lookbacks without shifting the user's start date.
    from_date = from_dt.date() if isinstance(from_dt, datetime) else from_dt
    start_idx = next(
        (i for i, d in enumerate(dates) if d.date() >= from_date),
        0,
    )
    logger.info("Warmup: %d rows before start_idx=%d (%s)", start_idx, start_idx, dates[start_idx].date())

    # ── Env config: defaults → session hyperparams → run-time overrides ───────
    hp      = session.get("hyperparams") or {}
    env_cfg = {**DEFAULT_ENV, **(hp.get("env", {})), **(env_overrides or {})}
    env_cfg["fast_margin"]            = False
    env_cfg["episode_length"]         = len(data) - start_idx  # steps from start_idx to end
    env_cfg["randomize_conditioning"] = False  # fixed conditioning at inference

    # ── Load model with manifest validation ───────────────────────────────────
    registry = ModelRegistry(Path(os.environ.get("MODELS_DIR", "/app/models")))
    model, manifest = registry.load(model_row["storagePath"])

    # ── Episode: start from start_idx (after warmup) ──────────────────────────
    env = OptionsEnv(data, env_cfg)
    env.reset()
    env.idx            = start_idx
    env._initial_price = float(env.data[start_idx][0])
    env._prev_equity   = env.initial_margin_btc
    obs = env._obs()

    total_reward   = 0.0
    steps          = 0
    pending        : list[dict] = []

    while True:
        row     = env.data[min(env.idx, len(env.data) - 1)]
        S, dvol = float(row[0]), float(row[1])
        sigma   = env._sigma(dvol)

        action, _ = model.predict(obs, deterministic=True)
        action_id = int(action)

        obs, reward, terminated, truncated, info = env.step(action_id)
        total_reward += float(reward)
        steps        += 1

        step_idx     = max(0, env.idx - 1)
        current_date = datetime.combine(dates[step_idx].date(), datetime.min.time(), tzinfo=timezone.utc)
        ts           = current_date.strftime("%Y-%m-%dT%H:%M:%SZ")

        entries = _events_to_log_entries(
            info.get("events", []), current_date, ts, env, S, dvol, sigma, action_id
        )
        pending.extend(entries)

        if truncated:
            break

    _flush_actions(nestjs_url, api_key, run_id, pending)
    actions_logged = len(pending)

    equity_btc = float(env.margin_balance)
    pnl_btc    = equity_btc - env_cfg["initial_margin_btc"]

    logger.info(
        "Run complete: %d steps, %d actions logged, equity=%.4f BTC, pnl=%.6f BTC",
        steps, actions_logged, equity_btc, pnl_btc,
    )

    return {
        "steps":               steps,
        "actions_logged":      actions_logged,
        "total_reward":        round(total_reward, 6),
        "equity_btc":          round(equity_btc, 6),
        "pnl_btc":             round(pnl_btc, 6),
        "mean_reward_per_step": round(total_reward / max(steps, 1), 6),
    }
