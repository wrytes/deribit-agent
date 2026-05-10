"""
Inference loop for a trained PPO model.

run_session(run_id, session_id, data_from, data_to, env_overrides)
  1. Loads TrainingSession config and TrainedModel path from DB
  2. Fetches candle + DVOL data for the date range
  3. Runs one PPO episode (deterministic) from step 0
  4. POSTs structured accounting events to NestJS via NESTJS_URL + NESTJS_API_KEY
     Each day emits events in order: settlement_init, settlement_expired,
     settlement_unrealized, open, close — one row per leg per event.
     All derived fields (equityBtc, cashflowBtc, timestamps) are computed here
     so the app is a thin display layer with no reconstruction logic.
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
    defn = ACTION_DEFS.get(action_id)
    if defn is None:
        return "hold"
    if defn == "close":
        return "close all"
    if isinstance(defn, dict) and "close_call_pct" in defn:
        return f"close call ≥{int(defn['close_call_pct'] * 100)}% profit"
    if isinstance(defn, dict) and "close_put_pct" in defn:
        return f"close put ≥{int(defn['close_put_pct'] * 100)}% profit"
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
    open_pos: dict,          # mutable across steps: label → {size, mkt_prem}
    env,
    S: float,
    dvol: float,
    sigma: float,
    action_id: int,
) -> list[dict]:
    """
    Convert env step events to AgentAction payloads.

    All accounting is resolved here so the app reads directly from the DB:
    - Sequential millisecond timestamps ensure correct ORDER BY in Postgres
    - equityBtc   = margin − Σ(mktPrem × size) for all open positions
    - cashflowBtc = gross BTC in (open) or out (close/expired) before fees
    - executedPrice is always the original premium (set on open events too)
    """
    entries = []
    reason = _action_reason(action_id)

    for i, evt in enumerate(events):
        etype  = evt["type"]
        size   = float(evt.get("size", 0.0))
        margin = float(evt.get("margin_balance_btc", 0.0))
        prem   = float(evt.get("premium_btc_unit", 0.0))
        cost   = float(evt.get("cost_btc_unit", 0.0))
        intr   = float(evt.get("intrinsic_btc_unit", 0.0))

        # Sequential millisecond offsets ensure DB ORDER BY timestamp is correct
        # without any client-side sorting.
        event_ts = current_date + timedelta(milliseconds=i)
        ts = event_ts.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

        # Instrument label (None for settlement_init which has no position)
        label: str | None = None
        if "strike" in evt:
            label = _instrument_label(current_date, evt["dte"], evt["strike"], evt["option_type"])

        # ── Update open position tracking ──────────────────────────────────────
        if etype == "open" and label:
            open_pos[label] = {"size": size, "mkt_prem": prem}
        elif etype == "settlement_unrealized" and label:
            existing = open_pos.get(label)
            open_pos[label] = {
                "size":     existing["size"] if existing else size,
                "mkt_prem": evt["current_btc_unit"],
            }
        elif etype in ("close", "settlement_expired") and label:
            open_pos.pop(label, None)

        # ── Equity = margin − Σ(mktPrem × size) ───────────────────────────────
        liability = sum(p["size"] * p["mkt_prem"] for p in open_pos.values())
        equity = margin - liability

        # ── Cashflow = gross BTC in/out (before fee) ──────────────────────────
        if etype == "open":
            cashflow: float | None = prem * size          # inflow
        elif etype == "close":
            cashflow = -(cost * size)                     # outflow
        elif etype == "settlement_expired":
            cashflow = -(intr * size)                     # settlement (0 if OTM)
        else:
            cashflow = None                               # no cash movement

        # ── Base fields present on every entry ────────────────────────────────
        entry: dict = {
            "actionType":        etype,
            "timestamp":         ts,
            "btcPrice":          round(float(evt.get("btc_price", 0.0)), 2),
            "marginBalanceBtc":  round(margin, 6),
            "equityBtc":         round(equity, 6),
        }
        if cashflow is not None:
            entry["cashflowBtc"] = round(cashflow, 6)

        # ── Instrument fields (all position-bearing events) ───────────────────
        if label:
            T         = evt["dte"] / 365.0
            leg_delta = bs_delta(S, evt["strike"], T, env.r, sigma, evt["option_type"])
            leg_theta = bs_theta(S, evt["strike"], T, env.r, sigma, evt["option_type"]) / S
            entry.update({
                "instrument": label,
                "quantity":   round(size, 4),
                "delta":      round(leg_delta, 4),
                "thetaBtc":   round(leg_theta, 8),
                "ivRank":     round(dvol, 2),
            })

        # ── Type-specific fields ───────────────────────────────────────────────
        if etype == "settlement_init":
            entry["reason"] = "initial balance"

        elif etype == "settlement_unrealized":
            entry["price"]         = round(evt["current_btc_unit"], 6)
            entry["executedPrice"] = round(prem, 6)   # orig premium for reference
            entry["reason"]        = "daily mark"

        elif etype == "settlement_expired":
            entry["price"]         = round(intr, 6)   # settlement price per unit
            entry["executedPrice"] = round(prem, 6)   # original premium per unit
            entry["pnlBtc"]        = round(float(evt["pnl_btc"]), 6)
            entry["feeBtc"]        = 0.0
            entry["reason"]        = "expired ITM" if intr > 0 else "expired OTM"

        elif etype == "open":
            entry["price"]         = round(prem, 6)
            entry["executedPrice"] = round(prem, 6)   # same at open — executedPrice always = orig premium
            entry["feeBtc"]        = round(float(evt.get("fee_btc", 0.0)), 8)
            # pnlBtc omitted: premium offsets obligation, no P&L at open
            entry["reason"]        = reason

        elif etype == "close":
            entry["price"]         = round(cost, 6)   # buyback cost per unit
            entry["executedPrice"] = round(prem, 6)   # original premium per unit
            entry["pnlBtc"]        = round(float(evt["pnl_btc"]), 6)
            entry["feeBtc"]        = round(float(evt.get("fee_btc", 0.0)), 8)
            entry["reason"]        = evt.get("reason") or reason

        entries.append(entry)

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

        _WARMUP_DAYS = 45
        warmup_from = from_dt - timedelta(days=_WARMUP_DAYS)

        candles = load_candles(conn, session["currency"], warmup_from, to_dt)
        dvol_df = load_dvol(conn, warmup_from, to_dt)
    finally:
        conn.close()

    data, dates = build_data(candles, dvol_df)

    from_date = from_dt.date() if isinstance(from_dt, datetime) else from_dt
    start_idx = next(
        (i for i, d in enumerate(dates) if d.date() >= from_date),
        0,
    )
    logger.info("Warmup: %d rows before start_idx=%d (%s)", start_idx, start_idx, dates[start_idx].date())

    hp      = session.get("hyperparams") or {}
    env_cfg = {**DEFAULT_ENV, **(hp.get("env", {})), **(env_overrides or {})}
    env_cfg["fast_margin"]            = False
    env_cfg["episode_length"]         = len(data) - start_idx
    env_cfg["randomize_conditioning"] = False

    registry = ModelRegistry(Path(os.environ.get("MODELS_DIR", "/app/models")))
    model, manifest = registry.load(model_row["storagePath"])

    env = OptionsEnv(data, env_cfg)
    env.reset()
    env.idx            = start_idx
    env._initial_price = float(env.data[start_idx][0])
    env._prev_equity   = env.initial_margin_btc

    total_reward = 0.0
    steps        = 0
    pending      : list[dict] = []

    # Tracks open positions across days for equityBtc computation.
    # instrument label → {"size": float, "mkt_prem": float}
    open_pos: dict[str, dict] = {}

    while True:
        row     = env.data[min(env.idx, len(env.data) - 1)]
        S, dvol = float(row[0]), float(row[1])
        sigma   = env._sigma(dvol)

        # ── Phase 1: Settlement ───────────────────────────────────────────────
        # Run expiry, DTE tick, unrealized marks. Model predicts on the
        # post-settlement obs so it can act on the same day a position expires.
        _, settle_obs = env.settle()

        # ── Phase 2: Prediction on post-settlement state ──────────────────────
        action, _  = model.predict(settle_obs, deterministic=True)
        action_id  = int(action)

        # ── Phase 3: Execute action + advance day ─────────────────────────────
        _, reward, terminated, truncated, info = env.act(action_id)
        total_reward += float(reward)
        steps        += 1

        step_idx     = max(0, env.idx - 1)
        current_date = datetime.combine(dates[step_idx].date(), datetime.min.time(), tzinfo=timezone.utc)

        entries = _events_to_log_entries(
            info.get("events", []), current_date, open_pos, env, S, dvol, sigma, action_id
        )

        # On idle days (hold with no positions) no events are emitted — inject a hold
        # row so the chart has a continuous timeline with BTC price and equity.
        if not entries:
            liability = sum(p["size"] * p["mkt_prem"] for p in open_pos.values())
            equity    = env.margin_balance - liability
            entries.append({
                "actionType":        "hold",
                "timestamp":         current_date.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
                "btcPrice":          round(S, 2),
                "marginBalanceBtc":  round(env.margin_balance, 6),
                "equityBtc":         round(equity, 6),
            })

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
        "steps":                steps,
        "actions_logged":       actions_logged,
        "total_reward":         round(total_reward, 6),
        "equity_btc":           round(equity_btc, 6),
        "pnl_btc":              round(pnl_btc, 6),
        "mean_reward_per_step": round(total_reward / max(steps, 1), 6),
    }
