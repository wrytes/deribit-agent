import numpy as np
import gymnasium as gym
from gymnasium import spaces
from collections import deque
from env.black_scholes import price as bs_price, price_vec as bs_price_vec, delta as bs_delta, strike_from_delta
from config.defaults import OBS_FEATURES, OBS_VERSION  # noqa: F401 — re-exported for registry

# action_id → None | "close" | {"close_call_pct": float} | {"close_put_pct": float}
#            | {"call_delta": float}
#            | {"put_delta":  float}
#            | {"call_delta": float, "put_delta": float}
#
# Strikes computed dynamically from target delta each day:
#   K = strike_from_delta(S, T, r, sigma, target_delta, option_type)
#
# Call delta: 0.50 = ATM, <0.50 = OTM, >0.50 = ITM
# Put  delta: -0.50 = ATM, >-0.50 = OTM (less negative), <-0.50 = ITM
ACTION_DEFS = {
    # --- hold ---
    0:  None,
    # --- short calls by delta ---
    1:  {"call_delta": 0.50},                              # ATM
    2:  {"call_delta": 0.40},                              # OTM  Δ40
    3:  {"call_delta": 0.30},                              # OTM  Δ30
    4:  {"call_delta": 0.20},                              # OTM  Δ20
    5:  {"call_delta": 0.60},                              # ITM  Δ60
    6:  {"call_delta": 0.70},                              # ITM  Δ70
    7:  {"call_delta": 0.80},                              # ITM  Δ80
    # --- short puts by delta ---
    8:  {"put_delta": -0.50},                              # ATM
    9:  {"put_delta": -0.40},                              # OTM  Δ40
    10: {"put_delta": -0.30},                              # OTM  Δ30
    11: {"put_delta": -0.20},                              # OTM  Δ20
    12: {"put_delta": -0.10},                              # OTM  Δ10 (far OTM)
    # --- short strangles (both legs in one action) ---
    13: {"call_delta": 0.40, "put_delta": -0.40},
    14: {"call_delta": 0.30, "put_delta": -0.30},
    15: {"call_delta": 0.20, "put_delta": -0.20},
    # --- close all ---
    16: "close",
    # --- close CALL leg at profit target ---
    17: {"close_call_pct": 0.25},
    18: {"close_call_pct": 0.50},
    19: {"close_call_pct": 0.60},
    20: {"close_call_pct": 0.70},
    21: {"close_call_pct": 0.80},
    # --- close PUT leg at profit target ---
    22: {"close_put_pct": 0.25},
    23: {"close_put_pct": 0.50},
    24: {"close_put_pct": 0.60},
    25: {"close_put_pct": 0.70},
    26: {"close_put_pct": 0.80},
}

TRADE_FEE = 0.002  # 0.2% of premium on open/close; 0% on expiry settlement

# Strategy → sell action ID mapping (hold=0, close=16–26 always valid)
_STRATEGY_ORDER = ["short_call", "short_put", "delta_neutral"]

_STRATEGY_ACTION_MAP: dict[str, frozenset[int]] = {
    "short_call":    frozenset({1, 2, 3, 4, 5, 6, 7}),
    "short_put":     frozenset({8, 9, 10, 11, 12}),
    "delta_neutral": frozenset({1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}),
}

_ALL_SELL_ACTIONS = frozenset(range(1, 16))  # action IDs 1–15

# Deribit portfolio margin stress scenarios
_PM_PRICE_SHOCKS   = np.array([-0.16, -0.12, -0.08, -0.04, 0.0, 0.04, 0.08, 0.12, 0.16])
_PM_PRICE_EXTENDED = np.array([-0.66, -0.33, 0.50, 1.00, 2.00, 3.00, 4.00, 5.00])
_PM_ALL_SHOCKS     = np.concatenate([_PM_PRICE_SHOCKS, _PM_PRICE_EXTENDED])
_PM_IV_SHOCKS      = np.array([-0.25, 0.0, 0.25])

# Equity history depth — covers all observation lookbacks (30d) + reward lookback (expiry_days_max ≤ 30)
_EQUITY_HISTORY_LEN = 31


class OptionsEnv(gym.Env):
    """
    Short-premium BTC options environment — BTC-denominated margin accounting.

    Accounting:
      margin_balance  BTC held as collateral (changes only on trades/settlement)
      margin_value    margin_balance × S  (USD, floats with BTC price)
      equity_btc      margin_balance − current_option_liability_btc
      equity_usd      equity_btc × S

    Cash flows (all in BTC):
      sell option     margin_balance += prem_usd/S − fee
      close early     margin_balance -= buyback_usd/S + fee
      expire OTM      nothing (premium already in margin_balance)
      expire ITM      margin_balance -= max(S_T−K, 0)/S_T × size

    Data columns: [btc_price, dvol, hv_30d, hv_7d]

    Observation (35 floats):
      --- Market state (5) ---
      btc_price_norm, dvol_norm, hv_7d_norm, hv_30d_norm, vol_premium
      --- Rolling metrics (6) ---
      ret_1d, ret_7d, ret_30d, dvol_change_1d, dvol_change_7d, dvol_change_30d
      --- Call position (6) ---
      has_call, call_dte_norm, call_moneyness, call_delta, call_size_norm, call_pnl_pct
      --- Put position (6) ---
      has_put, put_dte_norm, put_moneyness, put_delta, put_size_norm, put_pnl_pct
      --- Portfolio risk (7) ---
      unrealized_btc_norm, margin_balance_norm, margin_ratio,
      equity_dd_1d, equity_dd_7d, equity_dd_30d, equity_dd_7d_high
      --- Strategy masks (3) ---
      mask_short_call, mask_short_put, mask_delta_neutral
      --- Conditioning inputs (2) ---
      max_drawdown_limit, aggression_level

    Reward: Δequity_btc / initial_margin_btc per step.
    Termination: equity drawdown from peak exceeds max_drawdown_limit.
    """

    metadata = {"render_modes": []}

    def __init__(self, data: np.ndarray, config: dict):
        super().__init__()
        self.data               = data
        self.initial_margin_btc = float(config.get("initial_margin_btc", 1.0))
        self.position_size_pct  = float(config.get("position_size_pct", 0.10))
        self.max_position_btc   = float(config.get("max_position_btc", 5.0))
        # DTE range — accept single expiry_days for backward compat
        self.expiry_days_min    = int(config.get("expiry_days_min", config.get("expiry_days", 7)))
        self.expiry_days_max    = int(config.get("expiry_days_max", config.get("expiry_days", 7)))
        self.roll_dte_threshold = int(config.get("roll_dte_threshold", 0))
        self.r                  = float(config["risk_free_rate"])
        self.max_margin_ratio   = float(config["max_margin_ratio"])
        self.episode_length     = int(config.get("episode_length", 365))
        self.capital_eff_bonus  = float(config.get("capital_eff_bonus", 0.0001))
        self.delta_threshold    = float(config.get("delta_threshold", 0.30))
        self.delta_penalty_coef = float(config.get("delta_penalty_coef", 0.002))
        self.loss_multiplier    = float(config.get("loss_multiplier", 1.0))
        self.loss_threshold     = float(config.get("loss_threshold", 0.01))
        self.min_order_size     = float(config.get("min_order_size", 0.1))

        # Conditioning — randomized per episode during training, fixed at inference
        self._randomize_conditioning = bool(config.get("randomize_conditioning", False))
        self.max_drawdown_limit      = float(config.get("max_drawdown_limit", 0.20))
        self.aggression_level        = float(config.get("aggression_level", 0.5))

        self.action_space      = spaces.Discrete(len(ACTION_DEFS))
        self.observation_space = spaces.Box(
            low=-np.inf, high=np.inf, shape=(len(OBS_FEATURES),), dtype=np.float32
        )

        self._pm_iv_shocks = np.array([0.0]) if config.get("fast_margin", True) else _PM_IV_SHOCKS

        # Action masking: allowed_actions accepts strategy name strings (legacy) or action ID ints (new)
        _allowed = config.get("allowed_actions", [])
        if _allowed:
            valid: set[int] = set()
            for item in _allowed:
                if isinstance(item, str):
                    valid |= _STRATEGY_ACTION_MAP.get(item, frozenset())
                elif isinstance(item, (int, float)):
                    aid = int(item)
                    if 1 <= aid <= 15:
                        valid.add(aid)
            self._valid_sell_actions = frozenset(valid) if valid else _ALL_SELL_ACTIONS
        else:
            self._valid_sell_actions = _ALL_SELL_ACTIONS

        self._allowed_mask = np.array(
            [
                1.0 if (not _allowed or bool(self._valid_sell_actions & _STRATEGY_ACTION_MAP[s]))
                else 0.0
                for s in _STRATEGY_ORDER
            ],
            dtype=np.float32,
        )

        self._equity_history = deque(maxlen=_EQUITY_HISTORY_LEN)

        self.margin_balance = self.initial_margin_btc
        self.call_pos       = None
        self.put_pos        = None
        self.idx            = 0
        self.step_count     = 0
        self._initial_price = 1.0
        self._prev_equity   = self.initial_margin_btc
        self._cached_margin = 0.0

        # Intermediate state shared between settle() and act()
        self._settle_S      = 0.0
        self._settle_sigma  = 0.0
        self._settle_events : list[dict] = []

        # Real-price overrides for paper trading: {(strike_int, dte, option_type): price_btc}
        # Set by settle()/act() callers; empty dict = pure Black-Scholes (backtest mode).
        self._price_overrides: dict = {}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_price_btc(self, strike: float, dte: int, option_type: str, S: float, sigma: float) -> float:
        """Return option price in BTC: real override if available, else Black-Scholes."""
        key = (int(round(strike)), int(dte), option_type)
        if self._price_overrides and key in self._price_overrides:
            return self._price_overrides[key]
        T = dte / 365.0
        return bs_price(S, strike, T, self.r, sigma, option_type) / S

    def _row(self, idx=None):
        i = idx if idx is not None else self.idx
        return self.data[min(i, len(self.data) - 1)]

    def _sigma(self, dvol):
        return max(dvol / 100.0, 1e-6)

    def _position_size(self):
        """Kelly sizing scaled by aggression_level (0.3×–1.0× of configured pct)."""
        scale = 0.3 + 0.7 * self.aggression_level
        raw = min(self.margin_balance * self.position_size_pct * scale, self.max_position_btc)
        increments = int(raw / self.min_order_size)
        return increments * self.min_order_size

    def _equity_n_days_ago(self, n: int) -> float:
        """Return equity n days ago from history. hist[-1] = today (just appended)."""
        idx = n + 1
        return float(self._equity_history[-idx]) if len(self._equity_history) >= idx else self.initial_margin_btc

    def _is_covered_call(self):
        if self.call_pos is None:
            return False
        return self.margin_balance >= self.call_pos["size"]

    def _recursive_size(self, S, sigma, K, option_type):
        T        = self.expiry_days_max / 365.0
        prem_btc = bs_price(S, K, T, self.r, sigma, option_type) / S
        denom    = max(1.0 - prem_btc, 0.01)
        return min(self.margin_balance / denom, self.max_position_btc)

    def _unrealized_btc(self, S, dvol):
        sigma = self._sigma(dvol)
        lib   = 0.0
        for pos in (self.call_pos, self.put_pos):
            if pos is None:
                continue
            T = pos["dte"] / 365.0
            current_usd = bs_price(S, pos["strike"], T, self.r, sigma, pos["type"])
            lib -= (current_usd / S) * pos["size"]
        return lib

    def _equity_btc(self, S, dvol):
        return self.margin_balance + self._unrealized_btc(S, dvol)

    def _portfolio_margin_usd(self, S, sigma, extra_positions=None):
        """
        Deribit-style portfolio margin in USD: worst-case scenario P&L.
        Vectorised: all (N_price × N_iv) shock combinations in one NumPy pass per position.
        """
        positions = [(p, p["type"]) for p in (self.call_pos, self.put_pos) if p is not None]
        if extra_positions:
            positions.extend(extra_positions)
        if not positions:
            return 0.0
        shocks = _PM_PRICE_SHOCKS if self.expiry_days_max <= 30 else _PM_ALL_SHOCKS

        S_grid = (S * (1.0 + shocks))[:, None]
        v_grid = np.maximum(sigma * (1.0 + self._pm_iv_shocks), 0.01)[None, :]

        pnl = np.zeros((len(shocks), len(self._pm_iv_shocks)))
        for pos, opt_type in positions:
            K, T, size = pos["strike"], pos["dte"] / 365.0, pos["size"]
            baseline  = bs_price(S, K, T, self.r, sigma, opt_type)
            stressed  = bs_price_vec(S_grid, K, T, self.r, v_grid, opt_type)
            pnl      -= (stressed - baseline) * size

        return float(max(0.0, -pnl.min()))

    def _sell_leg(self, S, sigma, strike, option_type, dte: int):
        size     = self._position_size()
        prem_btc = self._get_price_btc(strike, dte, option_type, S, sigma)
        fee_btc  = prem_btc * size * TRADE_FEE
        return {
            "strike":          strike,
            "prem_btc_unit":   prem_btc,
            "fee_btc_unit":    prem_btc * TRADE_FEE,
            "size":            size,
            "dte":             dte,
            "type":            option_type,
        }, prem_btc * size - fee_btc

    def _close_leg(self, attr, S, sigma):
        pos = getattr(self, attr)
        if pos is None:
            return 0.0
        cost_btc = self._get_price_btc(pos["strike"], pos["dte"], pos["type"], S, sigma)
        fee_btc  = cost_btc * pos["size"] * TRADE_FEE
        setattr(self, attr, None)
        return -(cost_btc * pos["size"] + fee_btc)

    def _close_all(self, S, sigma):
        return (self._close_leg("call_pos", S, sigma)
                + self._close_leg("put_pos",  S, sigma))

    def _close_leg_at_profit(self, attr: str, S: float, sigma: float, target_pct: float) -> float:
        """Close a single leg if profit capture >= target_pct."""
        pos = getattr(self, attr)
        if pos is None:
            return 0.0
        current_btc = self._get_price_btc(pos["strike"], pos["dte"], pos["type"], S, sigma)
        profit_pct  = (pos["prem_btc_unit"] - current_btc) / max(pos["prem_btc_unit"], 1e-8)
        if profit_pct >= target_pct:
            return self._close_leg(attr, S, sigma)
        return 0.0

    def _close_at_profit(self, S, sigma, target_pct):
        """Close each leg independently where profit capture >= target_pct."""
        return (
            self._close_leg_at_profit("call_pos", S, sigma, target_pct)
            + self._close_leg_at_profit("put_pos",  S, sigma, target_pct)
        )

    def _settle_expired(self, S):
        """Deribit BTC settlement: intrinsic paid in BTC = max(S_T−K, 0) / S_T × size."""
        btc_delta = 0.0
        for attr in ("call_pos", "put_pos"):
            pos = getattr(self, attr)
            if pos is None or pos["dte"] > 0:
                continue
            if pos["type"] == "call":
                intrinsic_btc = max(S - pos["strike"], 0.0) / S
            else:
                intrinsic_btc = max(pos["strike"] - S, 0.0) / S
            btc_delta -= intrinsic_btc * pos["size"]
            setattr(self, attr, None)
        return btc_delta

    def _obs(self):
        S, dvol, hv_30d, hv_7d = self._row()
        sigma = self._sigma(dvol)

        # Lookback rows
        prev_row = self._row(max(0, self.idx - 1))
        row_7d   = self._row(max(0, self.idx - 7))
        row_30d  = self._row(max(0, self.idx - 30))

        prev_S    = float(prev_row[0]);  prev_dvol = float(prev_row[1])
        S_7d      = float(row_7d[0]);   dvol_7d   = float(row_7d[1])
        S_30d     = float(row_30d[0]);  dvol_30d  = float(row_30d[1])

        ret_1d  = (S - prev_S) / prev_S   if prev_S  > 0 else 0.0
        ret_7d  = (S - S_7d)   / S_7d     if S_7d    > 0 else 0.0
        ret_30d = (S - S_30d)  / S_30d    if S_30d   > 0 else 0.0

        dvol_change_1d  = (dvol - prev_dvol) / 100.0
        dvol_change_7d  = (dvol - dvol_7d)   / 100.0
        dvol_change_30d = (dvol - dvol_30d)  / 100.0

        unreal_btc = self._unrealized_btc(S, dvol)
        margin_usd = self._cached_margin
        margin_val = self.margin_balance * S
        equity_btc = self.margin_balance + unreal_btc

        # Call position features — DTE normalised by expiry_days_max for consistent range [0,1]
        if self.call_pos:
            call_T         = self.call_pos["dte"] / 365.0
            current_call   = bs_price(S, self.call_pos["strike"], call_T, self.r, sigma, "call") / S
            has_call       = 1.0
            call_dte_norm  = self.call_pos["dte"] / self.expiry_days_max
            call_mono      = self.call_pos["strike"] / S - 1.0
            call_d         = bs_delta(S, self.call_pos["strike"], call_T, self.r, sigma, "call")
            call_size_norm = self.call_pos["size"] / self.initial_margin_btc
            call_pnl_pct   = (self.call_pos["prem_btc_unit"] - current_call) / max(self.call_pos["prem_btc_unit"], 1e-8)
        else:
            has_call = call_dte_norm = call_mono = call_d = call_size_norm = call_pnl_pct = 0.0

        # Put position features
        if self.put_pos:
            put_T         = self.put_pos["dte"] / 365.0
            current_put   = bs_price(S, self.put_pos["strike"], put_T, self.r, sigma, "put") / S
            has_put       = 1.0
            put_dte_norm  = self.put_pos["dte"] / self.expiry_days_max
            put_mono      = self.put_pos["strike"] / S - 1.0
            put_d         = bs_delta(S, self.put_pos["strike"], put_T, self.r, sigma, "put")
            put_size_norm = self.put_pos["size"] / self.initial_margin_btc
            put_pnl_pct   = (self.put_pos["prem_btc_unit"] - current_put) / max(self.put_pos["prem_btc_unit"], 1e-8)
        else:
            has_put = put_dte_norm = put_mono = put_d = put_size_norm = put_pnl_pct = 0.0

        # Portfolio risk — equity drawdowns
        # Rolling 7-day high: max equity seen in the last 7 steps.
        # Gives the model a responsive risk signal tied to recent performance.
        history       = list(self._equity_history)
        high_7d       = max(history[-7:]) if history else self.initial_margin_btc
        equity_dd_7d_high = (equity_btc - high_7d) / self.initial_margin_btc

        eq_1d_ago     = self._equity_n_days_ago(1)
        eq_7d_ago     = self._equity_n_days_ago(7)
        eq_30d_ago    = self._equity_n_days_ago(30)
        equity_dd_1d  = (equity_btc - eq_1d_ago)  / self.initial_margin_btc
        equity_dd_7d  = (equity_btc - eq_7d_ago)  / self.initial_margin_btc
        equity_dd_30d = (equity_btc - eq_30d_ago) / self.initial_margin_btc

        return np.array([
            # Market state (5)
            S / self._initial_price,           # 0  btc_price_norm
            dvol   / 100.0,                    # 1  dvol_norm
            hv_7d  / 100.0,                    # 2  hv_7d_norm
            hv_30d / 100.0,                    # 3  hv_30d_norm
            (dvol - hv_30d) / 100.0,           # 4  vol_premium
            # Rolling metrics (6)
            ret_1d,                            # 5  ret_1d
            ret_7d,                            # 6  ret_7d
            ret_30d,                           # 7  ret_30d
            dvol_change_1d,                    # 8  dvol_change_1d
            dvol_change_7d,                    # 9  dvol_change_7d
            dvol_change_30d,                   # 10 dvol_change_30d
            # Call position (6)
            has_call,                          # 11 has_call
            call_dte_norm,                     # 12 call_dte_norm
            call_mono,                         # 13 call_moneyness
            call_d,                            # 14 call_delta
            call_size_norm,                    # 15 call_size_norm
            call_pnl_pct,                      # 16 call_pnl_pct
            # Put position (6)
            has_put,                           # 17 has_put
            put_dte_norm,                      # 18 put_dte_norm
            put_mono,                          # 19 put_moneyness
            put_d,                             # 20 put_delta
            put_size_norm,                     # 21 put_size_norm
            put_pnl_pct,                       # 22 put_pnl_pct
            # Portfolio risk (7)
            unreal_btc / self.initial_margin_btc,          # 23 unrealized_btc_norm
            self.margin_balance / self.initial_margin_btc, # 24 margin_balance_norm
            margin_usd / max(margin_val, 1.0),             # 25 margin_ratio
            equity_dd_1d,                                  # 26 equity_dd_1d
            equity_dd_7d,                                  # 27 equity_dd_7d
            equity_dd_30d,                                 # 28 equity_dd_30d
            equity_dd_7d_high,                             # 29 equity_dd_7d_high
            # Strategy masks (3)
            *self._allowed_mask,                           # 30–32
            # Conditioning inputs (2)
            self.max_drawdown_limit,                       # 33
            self.aggression_level,                         # 34
        ], dtype=np.float32)

    # ------------------------------------------------------------------
    # Gymnasium API
    # ------------------------------------------------------------------

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        # Minimum start of 30 so all rolling lookbacks (ret_30d, dvol_change_30d, etc.)
        # have real prior data rather than clamping to row 0.
        _WARMUP = 30
        max_start = len(self.data) - self.episode_length - self.expiry_days_max - 2
        self.idx            = int(self.np_random.integers(_WARMUP, max(_WARMUP + 1, max_start)))
        self._initial_price = float(self._row()[0])
        self.margin_balance = self.initial_margin_btc
        self.call_pos       = None
        self.put_pos        = None
        self.step_count     = 0
        self._prev_equity   = self.initial_margin_btc
        self._cached_margin = 0.0
        self._equity_history.clear()
        self._equity_history.append(self.initial_margin_btc)

        if self._randomize_conditioning:
            # Randomise strategy mask — at least one strategy must be enabled
            while True:
                flags = [self.np_random.random() > 0.3 for _ in _STRATEGY_ORDER]
                if any(flags):
                    break
            enabled = [s for s, f in zip(_STRATEGY_ORDER, flags) if f]
            self._valid_sell_actions = frozenset().union(*(_STRATEGY_ACTION_MAP[s] for s in enabled))
            self._allowed_mask       = np.array(flags, dtype=np.float32)
            self.max_drawdown_limit  = float(self.np_random.uniform(0.05, 0.50))
            self.aggression_level    = float(self.np_random.uniform(0.0,  1.0))

        return self._obs(), {}

    def settle(self, price_overrides: dict | None = None) -> tuple[list[dict], np.ndarray]:
        """
        Phase 1 of the daily cycle: tick DTE, roll/expire positions, mark-to-market.

        Runs all settlement accounting for the current day WITHOUT advancing the
        day index or executing any trade action. Returns the post-settlement
        observation so the model can predict on the settled state.

        Must be followed immediately by act() to complete the day.
        Stashes intermediate state in self._settle_* for act() to consume.
        """
        self._price_overrides = price_overrides or {}
        events: list[dict] = []
        S, dvol, _, _ = self._row()
        sigma          = self._sigma(dvol)

        if self.step_count == 0:
            events.append({
                "type":               "settlement_init",
                "btc_price":          float(S),
                "margin_balance_btc": self.margin_balance,
            })

        if self.call_pos: self.call_pos["dte"] -= 1
        if self.put_pos:  self.put_pos["dte"]  -= 1

        # Roll positions that hit the DTE threshold (roll_dte_threshold > 0, dte > 0 so not yet expired)
        if self.roll_dte_threshold > 0:
            for attr in ("call_pos", "put_pos"):
                pos = getattr(self, attr)
                if pos is None or pos["dte"] <= 0 or pos["dte"] > self.roll_dte_threshold:
                    continue
                buyback_unit = self._get_price_btc(pos["strike"], pos["dte"], pos["type"], S, sigma)
                close_fee_u  = buyback_unit * TRADE_FEE
                open_fee_u   = pos.get("fee_btc_unit", pos["prem_btc_unit"] * TRADE_FEE)
                lifetime_pnl = (pos["prem_btc_unit"] - buyback_unit - open_fee_u - close_fee_u) * pos["size"]
                btc_out      = -(buyback_unit + close_fee_u) * pos["size"]
                self.margin_balance += btc_out
                events.append({
                    "type":               "close",
                    "option_type":        pos["type"],
                    "strike":             float(pos["strike"]),
                    "size":               float(pos["size"]),
                    "dte":                pos["dte"],
                    "premium_btc_unit":   float(pos["prem_btc_unit"]),
                    "cost_btc_unit":      float(buyback_unit),
                    "pnl_btc":            float(lifetime_pnl),
                    "fee_btc":            float(close_fee_u * pos["size"]),
                    "btc_price":          float(S),
                    "action_id":          16,  # logged as close-all action
                    "reason":             "roll",
                    "margin_balance_btc": self.margin_balance,
                })
                setattr(self, attr, None)

        expired_events: list[dict] = []
        for attr in ("call_pos", "put_pos"):
            pos = getattr(self, attr)
            if pos is None or pos["dte"] > 0:
                continue
            if pos["type"] == "call":
                intrinsic = max(S - pos["strike"], 0.0) / S
            else:
                intrinsic = max(pos["strike"] - S, 0.0) / S
            open_fee_unit = pos.get("fee_btc_unit", pos["prem_btc_unit"] * TRADE_FEE)
            lifetime_pnl  = (pos["prem_btc_unit"] - intrinsic - open_fee_unit) * pos["size"]
            expired_events.append({
                "type":               "settlement_expired",
                "option_type":        pos["type"],
                "strike":             float(pos["strike"]),
                "size":               float(pos["size"]),
                "dte":                0,
                "premium_btc_unit":   float(pos["prem_btc_unit"]),
                "intrinsic_btc_unit": float(intrinsic),
                "pnl_btc":            float(lifetime_pnl),
                "fee_btc":            0.0,
                "btc_price":          float(S),
            })

        self.margin_balance += self._settle_expired(S)

        for evt in expired_events:
            evt["margin_balance_btc"] = self.margin_balance
        events.extend(expired_events)

        for attr in ("call_pos", "put_pos"):
            pos = getattr(self, attr)
            if pos is None:
                continue
            current_btc = self._get_price_btc(pos["strike"], pos["dte"], pos["type"], S, sigma)
            events.append({
                "type":               "settlement_unrealized",
                "option_type":        pos["type"],
                "strike":             float(pos["strike"]),
                "size":               float(pos["size"]),
                "dte":                pos["dte"],
                "premium_btc_unit":   float(pos["prem_btc_unit"]),
                "current_btc_unit":   float(current_btc),
                "btc_price":          float(S),
                "margin_balance_btc": self.margin_balance,
            })

        self._cached_margin = self._portfolio_margin_usd(S, sigma)

        # Stash for act()
        self._settle_S      = S
        self._settle_sigma  = sigma
        self._settle_events = events

        return events, self._obs()

    def act(self, action: int, price_overrides: dict | None = None) -> tuple[np.ndarray, float, bool, bool, dict]:
        """
        Phase 2 of the daily cycle: execute model action and advance to next day.

        Must be called after settle() on the same day. Returns the standard
        gym (obs, reward, terminated, truncated, info) tuple where info["events"]
        contains both settlement events and any trade events from the action.
        """
        if price_overrides is not None:
            self._price_overrides = price_overrides
        S     = self._settle_S
        sigma = self._settle_sigma

        # Mask disallowed sell actions → hold
        if action in _ALL_SELL_ACTIONS and action not in self._valid_sell_actions:
            action = 0

        call_before = dict(self.call_pos) if self.call_pos else None
        put_before  = dict(self.put_pos)  if self.put_pos  else None

        btc_delta = 0.0
        defn = ACTION_DEFS[action]

        if defn == "close":
            btc_delta = self._close_all(S, sigma)

        elif isinstance(defn, dict) and "close_call_pct" in defn:
            btc_delta = self._close_leg_at_profit("call_pos", S, sigma, defn["close_call_pct"])

        elif isinstance(defn, dict) and "close_put_pct" in defn:
            btc_delta = self._close_leg_at_profit("put_pos", S, sigma, defn["close_put_pct"])

        elif isinstance(defn, dict) and "close_pct" in defn:
            # Legacy combined close — kept for any external callers
            btc_delta = self._close_at_profit(S, sigma, defn["close_pct"])

        elif defn is not None:
            want_call = "call_delta" in defn and self.call_pos is None
            want_put  = "put_delta"  in defn and self.put_pos  is None

            # Pick expiry DTE randomly in [min, max]
            dte = (
                int(self.np_random.integers(self.expiry_days_min, self.expiry_days_max + 1))
                if self.expiry_days_min < self.expiry_days_max
                else self.expiry_days_min
            )
            T = dte / 365.0

            will_be_covered = (
                want_call
                and "put_delta" not in defn
                and self.put_pos is None
                and self.margin_balance >= self._position_size()
            )
            margin_cap = 0.95 if will_be_covered else self.max_margin_ratio
            margin_val = self.margin_balance * S

            prospective = []
            size = self._position_size()
            if want_call:
                K_c = strike_from_delta(S, T, self.r, sigma, defn["call_delta"], "call")
                prospective.append(({"strike": K_c, "size": size, "dte": dte, "type": "call"}, "call"))
            if want_put:
                K_p = strike_from_delta(S, T, self.r, sigma, defn["put_delta"], "put")
                prospective.append(({"strike": K_p, "size": size, "dte": dte, "type": "put"}, "put"))

            prospective_margin = self._portfolio_margin_usd(S, sigma, extra_positions=prospective)
            if prospective_margin < margin_val * margin_cap and size >= self.min_order_size:
                if want_call:
                    self.call_pos, p = self._sell_leg(S, sigma, K_c, "call", dte)
                    btc_delta += p
                if want_put:
                    self.put_pos, p = self._sell_leg(S, sigma, K_p, "put", dte)
                    btc_delta += p

        self.margin_balance += btc_delta

        trade_events: list[dict] = []
        for attr, pos_b in (("call_pos", call_before), ("put_pos", put_before)):
            pos_a = getattr(self, attr)
            if pos_b is not None and pos_a is None:
                buyback_unit = self._get_price_btc(pos_b["strike"], pos_b["dte"], pos_b["type"], S, sigma)
                close_fee_u  = buyback_unit * TRADE_FEE
                open_fee_u   = pos_b.get("fee_btc_unit", pos_b["prem_btc_unit"] * TRADE_FEE)
                lifetime_pnl = (pos_b["prem_btc_unit"] - buyback_unit - open_fee_u - close_fee_u) * pos_b["size"]
                trade_events.append({
                    "type":             "close",
                    "option_type":      pos_b["type"],
                    "strike":           float(pos_b["strike"]),
                    "size":             float(pos_b["size"]),
                    "dte":              pos_b["dte"],
                    "premium_btc_unit": float(pos_b["prem_btc_unit"]),
                    "cost_btc_unit":    float(buyback_unit),
                    "pnl_btc":          float(lifetime_pnl),
                    "fee_btc":          float(close_fee_u * pos_b["size"]),
                    "btc_price":        float(S),
                    "action_id":        action,
                })
            elif pos_b is None and pos_a is not None:
                open_fee = pos_a["prem_btc_unit"] * pos_a["size"] * TRADE_FEE
                trade_events.append({
                    "type":             "open",
                    "option_type":      pos_a["type"],
                    "strike":           float(pos_a["strike"]),
                    "size":             float(pos_a["size"]),
                    "dte":              pos_a["dte"],
                    "premium_btc_unit": float(pos_a["prem_btc_unit"]),
                    "pnl_btc":          None,
                    "fee_btc":          float(open_fee),
                    "btc_price":        float(S),
                    "action_id":        action,
                })

        for evt in trade_events:
            evt["margin_balance_btc"] = self.margin_balance

        # ── Advance to next day ───────────────────────────────────────────────
        self.idx        += 1
        self.step_count += 1

        S_new, dvol_new, _, _ = self._row() if self.idx < len(self.data) else self._row(self.idx - 1)
        equity_now    = self._equity_btc(S_new, dvol_new)
        reward        = (equity_now - self._prev_equity) / self.initial_margin_btc
        self._prev_equity = equity_now

        has_pos = self.call_pos is not None or self.put_pos is not None
        reward += self.capital_eff_bonus if has_pos else -self.capital_eff_bonus

        sigma_new = self._sigma(dvol_new)
        net_delta = self.margin_balance
        if self.call_pos:
            call_d     = bs_delta(S_new, self.call_pos["strike"], self.call_pos["dte"] / 365, self.r, sigma_new, "call")
            net_delta -= call_d * self.call_pos["size"]
        if self.put_pos:
            put_d      = bs_delta(S_new, self.put_pos["strike"], self.put_pos["dte"] / 365, self.r, sigma_new, "put")
            net_delta -= put_d * self.put_pos["size"]
        net_delta_norm = net_delta / max(self.initial_margin_btc, 1e-8)
        excess = max(0.0, net_delta_norm - 1.0 - self.delta_threshold)
        reward -= excess * self.delta_penalty_coef

        self._equity_history.append(equity_now)

        weekly_ref  = self._equity_n_days_ago(self.expiry_days_max)
        weekly_drop = (weekly_ref - equity_now) / max(weekly_ref, 1e-8)
        if weekly_drop > self.loss_threshold and reward < 0:
            reward *= self.loss_multiplier

        # Termination: rolling 7-day max drawdown.
        # Compares current equity to the highest equity seen in the last 7 days
        # (including today, just appended). More responsive than an all-time peak —
        # a sustained losing streak triggers termination even after a distant prior peak.
        history_7d    = list(self._equity_history)[-7:]
        high_7d       = max(history_7d) if history_7d else self.initial_margin_btc
        dd_7d_high    = (equity_now - high_7d) / self.initial_margin_btc
        terminated    = dd_7d_high < -self.max_drawdown_limit
        truncated  = self.step_count >= self.episode_length or self.idx >= len(self.data) - 1

        all_events = self._settle_events + trade_events
        return self._obs(), float(reward), terminated, truncated, {"events": all_events}

    def step(self, action: int):
        """
        Atomic settlement + action for gym/SB3 training compatibility.
        Internally calls settle() then act(). For inference use the two-phase
        approach so the model predicts on the post-settlement observation:
            _, settle_obs = env.settle()
            obs, reward, terminated, truncated, info = env.act(action)
        """
        self.settle()
        return self.act(action)
