"""
Inference loop for a trained PPO model.

run_session(run_id, session_id, data_from, data_to)
  1. Loads TrainingSession config and TrainedModel path from DB
  2. Fetches candle + DVOL data for the date range
  3. Runs one PPO episode (deterministic) from step 0
  4. POSTs each non-hold action to NestJS via NESTJS_URL + NESTJS_API_KEY
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
from stable_baselines3 import PPO

from env.black_scholes import delta as bs_delta
from env.options_env import ACTION_DEFS, OptionsEnv
from train_session import (
    DEFAULT_ENV,
    _build_data,
    _connect,
    _load_candles,
    _load_dvol,
    _load_session,
)

logger = logging.getLogger(__name__)

# Map action id → NestJS actionType string
_ACTION_TYPE: dict[int, str] = {
    0:  "hold",
    1:  "sell_call", 2:  "sell_call", 3:  "sell_call",
    4:  "sell_call", 5:  "sell_call", 6:  "sell_call", 7: "sell_call",
    8:  "sell_put",  9:  "sell_put",  10: "sell_put",
    11: "sell_put",  12: "sell_put",
    13: "sell_strangle", 14: "sell_strangle", 15: "sell_strangle",
    16: "close", 17: "close", 18: "close", 19: "close", 20: "close",
}


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


def _flush_actions(nestjs_url: str, api_key: str, run_id: str, actions: list[dict]) -> None:
    """POST all collected actions in one batch request."""
    if not actions:
        return
    try:
        data = json.dumps({"actions": actions}).encode()
        req = urllib.request.Request(
            f"{nestjs_url}/agent/runs/{run_id}/actions/batch",
            data=data,
            headers={"Content-Type": "application/json", "x-api-key": api_key},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60):
            pass
    except Exception as exc:
        logger.error("Failed to flush actions to NestJS: %s", exc)


def run_session(
    run_id: str,
    session_id: str,
    data_from=None,
    data_to=None,
) -> dict:
    nestjs_url = os.environ.get("NESTJS_URL", "http://localhost:3030")
    api_key    = os.environ.get("NESTJS_API_KEY", "")

    # ── DB: session config + model path ───────────────────────────────────────
    conn = _connect()
    try:
        session = _load_session(conn, session_id)

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

        candles = _load_candles(conn, session["currency"], from_dt, to_dt)
        dvol_df = _load_dvol(conn, from_dt, to_dt)
    finally:
        conn.close()

    data, dates = _build_data(candles, dvol_df)

    # ── Env (full margin precision for inference) ──────────────────────────────
    hp      = session.get("hyperparams") or {}
    env_cfg = {**DEFAULT_ENV, **(hp.get("env", {}))}
    env_cfg["fast_margin"]    = False
    env_cfg["episode_length"] = len(data)  # run through all available data

    # ── Load model ────────────────────────────────────────────────────────────
    model_path = str(model_row["storagePath"])
    if not Path(model_path).exists():
        models_dir = Path(os.environ.get("MODELS_DIR", "/app/models"))
        alt = models_dir / Path(model_path).name
        if alt.exists():
            model_path = str(alt)
        else:
            raise ValueError(f"Model file not found: {model_path}")

    logger.info("Loading model from %s", model_path)
    model = PPO.load(model_path)

    # ── Episode: start from step 0 for deterministic backtest ─────────────────
    env = OptionsEnv(data, env_cfg)
    env.reset()
    env.idx           = 0
    env._initial_price = float(env.data[0][0])
    env._prev_equity  = env.initial_margin_btc
    obs = env._obs()

    total_reward   = 0.0
    steps          = 0
    pending        : list[dict] = []

    while True:
        row       = env.data[min(env.idx, len(env.data) - 1)]
        S, dvol   = float(row[0]), float(row[1])
        sigma     = env._sigma(dvol)

        action, _ = model.predict(obs, deterministic=True)
        action_id = int(action)

        obs, reward, terminated, truncated, _ = env.step(action_id)
        total_reward += float(reward)
        steps        += 1

        if action_id != 0:
            instrument      = None
            portfolio_delta = 0.0
            step_idx        = max(0, env.idx - 1)
            current_date    = datetime.combine(dates[step_idx].date(), datetime.min.time(), tzinfo=timezone.utc)

            if env.call_pos:
                T             = env.call_pos["dte"] / 365.0
                portfolio_delta += bs_delta(S, env.call_pos["strike"], T, env.r, sigma, "call")
                instrument    = _instrument_label(current_date, env.call_pos["dte"], env.call_pos["strike"], "call")

            if env.put_pos:
                T             = env.put_pos["dte"] / 365.0
                portfolio_delta += bs_delta(S, env.put_pos["strike"], T, env.r, sigma, "put")
                if instrument is None:
                    instrument = _instrument_label(current_date, env.put_pos["dte"], env.put_pos["strike"], "put")

            pending.append({
                "actionType": _ACTION_TYPE.get(action_id, "hold"),
                "timestamp":  current_date.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "instrument": instrument,
                "btcPrice":   round(S, 2),
                "delta":      round(portfolio_delta, 4),
                "ivRank":     round(dvol, 2),
                "pnlBtc":     round(float(reward) * env_cfg["initial_margin_btc"], 6),
                "reason":     _action_reason(action_id),
            })

        if terminated or truncated:
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
