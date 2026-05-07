"""
Core training logic for a single TrainingSession.

Called by main.py (FastAPI) with a session_id.
Reads config + date range from the TrainingSession table in Postgres,
assembles [btc_price, dvol, hv] from the Candle + MarketSnapshot tables,
trains a PPO model, evaluates on a holdout slice, saves the .zip, and
returns a metrics dict matching the NestJS TrainingProcessor contract.
"""

import os
import sys
import logging
import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
from pathlib import Path
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import DummyVecEnv
from stable_baselines3.common.callbacks import CheckpointCallback
from stable_baselines3.common.evaluation import evaluate_policy

from env.options_env import OptionsEnv

# Force unbuffered output so progress prints in Docker logs immediately
sys.stdout.reconfigure(line_buffering=True)

logger = logging.getLogger(__name__)

MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/app/models"))
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Defaults — overridden by session.hyperparams JSON
# ---------------------------------------------------------------------------

DEFAULT_ENV = {
    "initial_margin_btc": 1.0,
    "position_size_pct":  0.5,
    "max_position_btc":   5.0,
    "expiry_days":        7,
    "max_margin_ratio":   0.8,
    "risk_free_rate":     0.05,
    "episode_length":     365,
    "fast_margin":        True,
    "capital_eff_bonus":  0.0001,
    "delta_threshold":    0.30,
    "delta_penalty_coef": 0.002,
    "loss_multiplier":    1.20,
    "loss_threshold":     0.02,
}

DEFAULT_TRAIN = {
    "total_timesteps": 100_000,
    "learning_rate":   0.005,
    "n_steps":         512,
    "batch_size":      64,
    "n_epochs":        10,
    "gamma":           0.99,
    "ent_coef":        0.02,
}

# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _connect() -> psycopg2.extensions.connection:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL env var not set")
    return psycopg2.connect(url)


def _load_session(conn, session_id: str) -> dict:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT * FROM "TrainingSession" WHERE id = %s', (session_id,))
        row = cur.fetchone()
    if not row:
        raise ValueError(f"TrainingSession {session_id!r} not found")
    return dict(row)


def _load_candles(conn, currency: str, data_from, data_to) -> pd.DataFrame:
    """
    Load 1D close prices from the Candle table.
    Returns a DataFrame indexed by date with column 'close'.
    """
    instrument = f"{currency}-PERPETUAL"
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT DATE("timestamp") AS date, close::float AS close
            FROM   "Candle"
            WHERE  instrument = %s
              AND  resolution  = '1D'
              AND  "timestamp" >= %s
              AND  "timestamp" <= %s
            ORDER  BY "timestamp"
            """,
            (instrument, data_from, data_to),
        )
        rows = cur.fetchall()

    if not rows:
        raise ValueError(
            f"No 1D candles found for {instrument} between {data_from} and {data_to}. "
            "Run POST /data/candles/backfill first."
        )

    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date")


def _load_dvol(conn, data_from, data_to) -> pd.DataFrame:
    """
    Load daily DVOL averages from MarketSnapshot.
    Returns a DataFrame indexed by date with column 'dvol', or empty if none.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT DATE(timestamp)          AS date,
                   AVG("dvolIndex"::float)  AS dvol
            FROM   "MarketSnapshot"
            WHERE  currency     = 'BTC'
              AND  "dvolIndex"  IS NOT NULL
              AND  timestamp   >= %s
              AND  timestamp   <= %s
            GROUP  BY DATE(timestamp)
            ORDER  BY date
            """,
            (data_from, data_to),
        )
        rows = cur.fetchall()

    if not rows:
        return pd.DataFrame(columns=["dvol"])

    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date")


# ---------------------------------------------------------------------------
# Data assembly
# ---------------------------------------------------------------------------

def _build_data(candles: pd.DataFrame, dvol_df: pd.DataFrame) -> np.ndarray:
    """
    Build the [btc_price, dvol, hv] float32 array that OptionsEnv expects.

    btc_price : daily close from Candle table
    hv        : 30-day annualised realised vol × 100 (same scale as DVOL %)
    dvol      : MarketSnapshot.dvolIndex where available; proxy = hv × 1.1 otherwise
    """
    df = candles.rename(columns={"close": "btc_price"}).copy()

    # 30-day HV (annualised, expressed as %)
    log_ret  = np.log(df["btc_price"] / df["btc_price"].shift(1))
    df["hv"] = log_ret.rolling(30).std() * np.sqrt(365) * 100

    # DVOL: merge then fill gaps
    if not dvol_df.empty:
        df = df.join(dvol_df[["dvol"]], how="left")
        df["dvol"] = df["dvol"].ffill().fillna(df["hv"] * 1.1)
    else:
        df["dvol"] = df["hv"] * 1.1   # vol-premium proxy when no snapshot data

    df = df.dropna(subset=["btc_price", "dvol", "hv"])

    if len(df) < 60:
        raise ValueError(
            f"Only {len(df)} usable rows after HV warmup — need at least 60. "
            "Widen the date range or run a longer backfill."
        )

    logger.info(
        "Training data: %d days  %s → %s",
        len(df),
        df.index[0].date(),
        df.index[-1].date(),
    )
    return df[["btc_price", "dvol", "hv"]].values.astype(np.float32)


# ---------------------------------------------------------------------------
# Training entry point
# ---------------------------------------------------------------------------

def train_session(session_id: str) -> dict:
    """
    Orchestrate a full training run for session_id.
    Returns a metrics dict that the NestJS TrainingProcessor records in DB.
    """
    logger.info("Session %s — connecting to DB", session_id)
    conn = _connect()
    try:
        session   = _load_session(conn, session_id)
        candles   = _load_candles(conn, session["currency"], session["dataFrom"], session["dataTo"])
        dvol_df   = _load_dvol(conn, session["dataFrom"], session["dataTo"])
    finally:
        conn.close()

    logger.info(
        "Session %s — %s  %s → %s  algorithm=%s",
        session_id, session["currency"],
        session["dataFrom"], session["dataTo"], session["algorithm"],
    )

    # --- Merge defaults with session hyperparams ---
    hp = session.get("hyperparams") or {}
    env_cfg   = {**DEFAULT_ENV,   **(hp.get("env", {}))}
    train_cfg = {**DEFAULT_TRAIN, **(hp.get("training", {}))}
    # Allow flat overrides at top level too (e.g. {"total_timesteps": 500000})
    for k in DEFAULT_TRAIN:
        if k in hp:
            train_cfg[k] = hp[k]

    total_timesteps = int(train_cfg["total_timesteps"])

    # --- Build data and split 80 / 20 ---
    data = _build_data(candles, dvol_df)
    split      = int(len(data) * 0.8)
    train_data = data[:split]
    eval_data  = data[split:]

    if len(train_data) < 60:
        raise ValueError(f"Training split too small: {len(train_data)} rows")

    logger.info("Split: %d train / %d eval rows", len(train_data), len(eval_data))

    # --- Paths ---
    model_name     = f"{session_id}_ppo"
    model_path     = MODELS_DIR / model_name
    checkpoint_dir = MODELS_DIR / "checkpoints" / session_id
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    # --- PPO ---
    vec_env = DummyVecEnv([lambda: OptionsEnv(train_data, env_cfg)])

    model = PPO(
        "MlpPolicy",
        vec_env,
        learning_rate = float(train_cfg["learning_rate"]),
        n_steps       = int(train_cfg["n_steps"]),
        batch_size    = int(train_cfg["batch_size"]),
        n_epochs      = int(train_cfg["n_epochs"]),
        gamma         = float(train_cfg["gamma"]),
        ent_coef      = float(train_cfg.get("ent_coef", 0.02)),
        verbose       = 1,
    )

    checkpoint_cb = CheckpointCallback(
        save_freq   = max(50_000, 1),
        save_path   = str(checkpoint_dir),
        name_prefix = "ppo",
        verbose     = 1,
    )

    logger.info("Training PPO for %d timesteps …", total_timesteps)
    model.learn(total_timesteps=total_timesteps, callback=checkpoint_cb)

    # --- Save ---
    model.save(str(model_path))
    saved_zip  = f"{model_path}.zip"
    size_bytes = Path(saved_zip).stat().st_size if Path(saved_zip).exists() else 0
    logger.info("Saved model → %s  (%d bytes)", saved_zip, size_bytes)

    # --- Evaluate on holdout ---
    mean_reward, std_reward = 0.0, 0.0
    if len(eval_data) >= 60:
        eval_env = DummyVecEnv([lambda: OptionsEnv(eval_data, env_cfg)])
        mean_reward, std_reward = evaluate_policy(
            model, eval_env, n_eval_episodes=5, deterministic=True
        )
        logger.info("Eval: mean=%.4f  std=%.4f", mean_reward, std_reward)

    return {
        "total_timesteps": total_timesteps,
        "final_reward":    float(mean_reward),
        "model_path":      saved_zip,
        "model_name":      model_name,
        "size_bytes":      size_bytes,
        "mean_reward":     float(mean_reward),
        "std_reward":      float(std_reward),
    }
