"""
Single source of truth for observation/action space versioning and training defaults.

When you add or remove observation features:
  1. Update OBS_FEATURES (add/remove names in order)
  2. Bump OBS_VERSION (e.g. "v2" → "v3")
  3. Update OptionsEnv._obs() to match

New models will be stamped with the new version. Old models whose manifest
declares a different OBS_VERSION will be rejected at load time.
"""

# ── Observation space ────────────────────────────────────────────────────────

OBS_VERSION = "v2"

OBS_FEATURES: list[str] = [
    # Market state (5)
    "btc_price_norm", "dvol_norm", "hv_7d_norm", "hv_30d_norm", "vol_premium",
    # Rolling metrics (6)
    "ret_1d", "ret_7d", "ret_30d", "dvol_change_1d", "dvol_change_7d", "dvol_change_30d",
    # Call position (6)
    "has_call", "call_dte_norm", "call_moneyness", "call_delta", "call_size_norm", "call_pnl_pct",
    # Put position (6)
    "has_put", "put_dte_norm", "put_moneyness", "put_delta", "put_size_norm", "put_pnl_pct",
    # Portfolio risk (7)
    "unrealized_btc_norm", "margin_balance_norm", "margin_ratio",
    "equity_dd_1d", "equity_dd_7d", "equity_dd_30d", "equity_dd_peak",
    # Strategy masks (3)
    "mask_short_call", "mask_short_put", "mask_delta_neutral",
    # Conditioning inputs (2)
    "max_drawdown_limit", "aggression_level",
]

# ── Action space ─────────────────────────────────────────────────────────────

ACTION_DIMS = 27  # must equal len(ACTION_DEFS) in env/options_env.py

# ── Data pipeline ────────────────────────────────────────────────────────────

DATA_COLUMNS = ["btc_price", "dvol", "hv_30d", "hv_7d"]

# ── Training defaults — overridden by session.hyperparams ────────────────────

DEFAULT_ENV: dict = {
    "initial_margin_btc":     1.0,
    "position_size_pct":      1.0,
    "max_position_btc":       5.0,
    "min_order_size":         0.1,
    "expiry_days_min":        7,
    "expiry_days_max":        7,
    "roll_dte_threshold":     0,
    "max_margin_ratio":       0.8,
    "risk_free_rate":         0.05,
    "episode_length":         90,
    "fast_margin":            True,
    "capital_eff_bonus":      0.0001,
    "delta_threshold":        0.30,
    "delta_penalty_coef":     0.002,
    "loss_multiplier":        1.20,
    "loss_threshold":         0.02,
    "randomize_conditioning": True,
    "max_drawdown_limit":     0.20,
    "aggression_level":       0.5,
}

DEFAULT_TRAIN: dict = {
    "total_timesteps": 100_000,
    "learning_rate":   0.005,
    "n_steps":         512,
    "batch_size":      64,
    "n_epochs":        10,
    "gamma":           0.99,
    "ent_coef":        0.02,
}
