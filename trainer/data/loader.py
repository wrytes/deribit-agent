"""
Database access and data assembly for the trainer.

All functions that touch Postgres or build the numpy array fed to OptionsEnv
live here so train_session.py and run_session.py stay thin.
"""

import logging
import os

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)


def connect() -> psycopg2.extensions.connection:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL env var not set")
    return psycopg2.connect(url)


def load_session(conn, session_id: str) -> dict:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT * FROM "TrainingSession" WHERE id = %s', (session_id,))
        row = cur.fetchone()
    if not row:
        raise ValueError(f"TrainingSession {session_id!r} not found")
    return dict(row)


def load_candles(conn, currency: str, data_from, data_to) -> pd.DataFrame:
    """1D close prices indexed by date."""
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


def load_dvol(conn, data_from, data_to) -> pd.DataFrame:
    """Daily DVOL averages indexed by date, or empty DataFrame if none."""
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


def build_data(candles: pd.DataFrame, dvol_df: pd.DataFrame) -> tuple[np.ndarray, list]:
    """
    Assemble the [btc_price, dvol, hv_30d, hv_7d] float32 array for OptionsEnv.

    Returns (data_array, date_index) where data_array has shape (N, 4) and
    date_index is a list of pandas Timestamps aligned to the rows.
    """
    df = candles.rename(columns={"close": "btc_price"}).copy()

    log_ret      = np.log(df["btc_price"] / df["btc_price"].shift(1))
    df["hv_30d"] = log_ret.rolling(30).std() * np.sqrt(365) * 100
    df["hv_7d"]  = log_ret.rolling(7).std()  * np.sqrt(365) * 100

    if not dvol_df.empty:
        df = df.join(dvol_df[["dvol"]], how="left")
        df["dvol"] = df["dvol"].ffill().fillna(df["hv_30d"] * 1.1)
    else:
        df["dvol"] = df["hv_30d"] * 1.1

    df = df.dropna(subset=["btc_price", "dvol", "hv_30d", "hv_7d"])

    if len(df) < 60:
        raise ValueError(
            f"Only {len(df)} usable rows after HV warmup — need at least 60. "
            "Widen the date range or run a longer backfill."
        )

    logger.info(
        "Data assembled: %d days  %s → %s",
        len(df),
        df.index[0].date(),
        df.index[-1].date(),
    )
    return df[["btc_price", "dvol", "hv_30d", "hv_7d"]].values.astype(np.float32), df.index.tolist()
