import numpy as np
import gymnasium as gym
from gymnasium import spaces
from collections import deque
from env.black_scholes import price as bs_price, price_vec as bs_price_vec, delta as bs_delta, strike_from_delta

# action_id -> None | "close" | {"close_pct": float}
#            | {"call_delta": float}
#            | {"put_delta":  float}
#            | {"call_delta": float, "put_delta": float}
#
# Strikes are computed dynamically from target delta each day:
#   K = strike_from_delta(S, T, r, sigma, target_delta, option_type)
#   Rounded to nearest $1,000.
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
    7:  {"call_delta": 0.80},                              # ITM  Δ80 (deep ITM / covered call)
    # --- short puts by delta ---
    8:  {"put_delta": -0.50},                              # ATM
    9:  {"put_delta": -0.40},                              # OTM  Δ40
    10: {"put_delta": -0.30},                              # OTM  Δ30
    11: {"put_delta": -0.20},                              # OTM  Δ20
    12: {"put_delta": -0.10},                              # OTM  Δ10 (far OTM / lottery put)
    # --- short strangles ---
    13: {"call_delta": 0.40, "put_delta": -0.40},          # Δ40 strangle
    14: {"call_delta": 0.30, "put_delta": -0.30},          # Δ30 strangle
    15: {"call_delta": 0.20, "put_delta": -0.20},          # Δ20 strangle
    # --- close actions ---
    16: "close",
    17: {"close_pct": 0.50},
    18: {"close_pct": 0.60},
    19: {"close_pct": 0.80},
    20: {"close_pct": 0.90},
}

TRADE_FEE = 0.002  # 0.2% of premium on open/close; 0% on expiry settlement

# Strategy → sell action ID mapping (hold=0, close=16–20 always valid)
_STRATEGY_ORDER = ["strangle", "straddle", "covered_call", "cash_secured_put", "delta_neutral", "iron_condor"]

_STRATEGY_ACTION_MAP: dict[str, frozenset[int]] = {
    "strangle":         frozenset({13, 14, 15}),
    "straddle":         frozenset({1, 8}),              # ATM call + ATM put
    "covered_call":     frozenset({1, 2, 3, 4, 5, 6, 7}),
    "cash_secured_put": frozenset({8, 9, 10, 11, 12}),
    "delta_neutral":    frozenset({13, 14, 15}),        # strangles are delta-balanced
    "iron_condor":      frozenset({13, 14, 15}),        # wing-buy not in action space; strangle proxy
}

_ALL_SELL_ACTIONS = frozenset(range(1, 16))  # action IDs 1–15

# Deribit portfolio margin stress scenarios
_PM_PRICE_SHOCKS   = np.array([-0.16, -0.12, -0.08, -0.04, 0.0, 0.04, 0.08, 0.12, 0.16])
_PM_PRICE_EXTENDED = np.array([-0.66, -0.33, 0.50, 1.00, 2.00, 3.00, 4.00, 5.00])
_PM_ALL_SHOCKS     = np.concatenate([_PM_PRICE_SHOCKS, _PM_PRICE_EXTENDED])
_PM_IV_SHOCKS      = np.array([-0.25, 0.0, 0.25])


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

    Observation (27 floats):
      btc_price_norm, ret_1d, dvol_norm, hv_norm, vol_premium, dvol_change,
      episode_progress, has_call, has_put, dte_norm,
      call_moneyness, put_moneyness, call_delta, put_delta,
      unrealized_btc_norm, margin_balance_norm, margin_ratio,
      equity_drawdown, btc_price_norm_7d, ret_7d, equity_drawdown_7d,
      mask_strangle, mask_straddle, mask_covered_call,
      mask_cash_secured_put, mask_delta_neutral, mask_iron_condor

    Reward: Δequity_btc / initial_margin_btc per step.
    Termination: equity_btc drops below 50% of initial_margin_btc.
    """

    metadata = {"render_modes": []}

    def __init__(self, data: np.ndarray, config: dict):
        super().__init__()
        self.data               = data
        self.initial_margin_btc = float(config.get("initial_margin_btc", 1.0))
        self.position_size_pct  = float(config.get("position_size_pct", 0.10))
        self.max_position_btc   = float(config.get("max_position_btc", 5.0))
        self.expiry_days        = int(config["expiry_days"])
        self.r                  = float(config["risk_free_rate"])
        self.max_margin_ratio   = float(config["max_margin_ratio"])
        self.episode_length     = int(config.get("episode_length", 365))
        self.capital_eff_bonus  = float(config.get("capital_eff_bonus", 0.0001))
        self.delta_threshold    = float(config.get("delta_threshold", 0.30))
        self.delta_penalty_coef = float(config.get("delta_penalty_coef", 0.002))
        self.loss_multiplier    = float(config.get("loss_multiplier", 1.0))
        self.loss_threshold     = float(config.get("loss_threshold", 0.01))
        self._equity_history    = deque(maxlen=self.expiry_days)  # rolling weekly window

        self.action_space      = spaces.Discrete(len(ACTION_DEFS))
        self.observation_space = spaces.Box(
            low=-np.inf, high=np.inf, shape=(27,), dtype=np.float32
        )

        # fast_margin=True skips IV shocks (17 scenarios vs 51) — use for training
        self._pm_iv_shocks   = np.array([0.0]) if config.get("fast_margin", True) else _PM_IV_SHOCKS

        # Action masking from allowed_actions config; empty list = all sell actions valid
        _allowed = config.get("allowed_actions", [])
        if _allowed:
            self._valid_sell_actions = frozenset().union(*(_STRATEGY_ACTION_MAP.get(s, frozenset()) for s in _allowed))
        else:
            self._valid_sell_actions = _ALL_SELL_ACTIONS

        # 6-float strategy mask baked into every observation (static per session)
        self._allowed_mask = np.array(
            [1.0 if (not _allowed or s in _allowed) else 0.0 for s in _STRATEGY_ORDER],
            dtype=np.float32,
        )

        self.margin_balance  = self.initial_margin_btc
        self.call_pos        = None
        self.put_pos         = None
        self.idx             = 0
        self.step_count      = 0
        self._initial_price  = 1.0
        self._prev_equity    = self.initial_margin_btc
        self._peak_equity    = self.initial_margin_btc   # high-water mark for drawdown obs
        self._cached_margin  = 0.0   # updated once per step, reused in _obs()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _row(self, idx=None):
        return self.data[idx if idx is not None else self.idx]

    def _sigma(self, dvol):
        return max(dvol / 100.0, 1e-6)

    def _position_size(self):
        """Fractional Kelly sizing in BTC: margin_balance × pct, capped."""
        return min(self.margin_balance * self.position_size_pct, self.max_position_btc)

    def _is_covered_call(self):
        """True when margin_balance ≥ call position size — can't blow up."""
        if self.call_pos is None:
            return False
        return self.margin_balance >= self.call_pos["size"]

    def _recursive_size(self, S, sigma, K, option_type):
        """USD-neutral sizing: margin_balance / (1 − prem_btc). See docs/covered-call-math.md."""
        T        = self.expiry_days / 365.0
        prem_btc = bs_price(S, K, T, self.r, sigma, option_type) / S
        denom    = max(1.0 - prem_btc, 0.01)
        return min(self.margin_balance / denom, self.max_position_btc)

    def _unrealized_btc(self, S, dvol):
        """
        Current option liability in BTC (always <= 0 for short positions).
        equity_btc = margin_balance + unrealized_btc
        """
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
        extra_positions: list of (pos_dict, opt_type) to include prospectively.
        Extended scenarios (+100% to +500%) are skipped for short-dated options
        (expiry_days <= 30) since such moves are impossible in days/weeks.
        Vectorised: all (N_price × N_iv) shock combinations evaluated in one
        NumPy pass per position instead of a triple Python loop.
        """
        positions = [(p, p["type"]) for p in (self.call_pos, self.put_pos) if p is not None]
        if extra_positions:
            positions.extend(extra_positions)
        if not positions:
            return 0.0
        shocks = _PM_PRICE_SHOCKS if self.expiry_days <= 30 else _PM_ALL_SHOCKS

        # Shocked grids — broadcast to (N_price, N_iv) without allocating full mesh
        S_grid = (S * (1.0 + shocks))[:, None]                                   # (N_price, 1)
        v_grid = np.maximum(sigma * (1.0 + self._pm_iv_shocks), 0.01)[None, :]   # (1, N_iv)

        pnl = np.zeros((len(shocks), len(self._pm_iv_shocks)))
        for pos, opt_type in positions:
            K, T, size = pos["strike"], pos["dte"] / 365.0, pos["size"]
            baseline  = bs_price(S, K, T, self.r, sigma, opt_type)            # scalar
            stressed  = bs_price_vec(S_grid, K, T, self.r, v_grid, opt_type)  # (N_price, N_iv)
            pnl      -= (stressed - baseline) * size

        return float(max(0.0, -pnl.min()))

    def _sell_leg(self, S, sigma, strike, option_type):
        """Sell one leg. Returns (position_dict, btc_received)."""
        size     = self._position_size()
        T        = self.expiry_days / 365.0
        prem_usd = bs_price(S, strike, T, self.r, sigma, option_type)
        prem_btc = prem_usd / S          # convert to BTC at current price
        fee_btc  = prem_btc * size * TRADE_FEE
        return {
            "strike":         strike,
            "prem_btc_unit":  prem_btc,  # premium per BTC of face value, at open time
            "size":           size,
            "dte":            self.expiry_days,
            "type":           option_type,
        }, prem_btc * size - fee_btc

    def _close_leg(self, attr, S, sigma):
        """Buy back one leg. Returns btc_delta (negative = cost paid)."""
        pos = getattr(self, attr)
        if pos is None:
            return 0.0
        T        = pos["dte"] / 365.0
        cost_usd = bs_price(S, pos["strike"], T, self.r, sigma, pos["type"])
        cost_btc = cost_usd / S
        fee_btc  = cost_btc * pos["size"] * TRADE_FEE
        setattr(self, attr, None)
        return -(cost_btc * pos["size"] + fee_btc)

    def _close_all(self, S, sigma):
        return (self._close_leg("call_pos", S, sigma)
                + self._close_leg("put_pos",  S, sigma))

    def _close_at_profit(self, S, sigma, target_pct):
        """Close legs where (prem_btc − current_btc) / prem_btc >= target_pct."""
        btc_delta = 0.0
        for attr in ("call_pos", "put_pos"):
            pos = getattr(self, attr)
            if pos is None:
                continue
            T           = pos["dte"] / 365.0
            current_btc = bs_price(S, pos["strike"], T, self.r, sigma, pos["type"]) / S
            profit_pct  = (pos["prem_btc_unit"] - current_btc) / max(pos["prem_btc_unit"], 1e-8)
            if profit_pct >= target_pct:
                btc_delta += self._close_leg(attr, S, sigma)
        return btc_delta

    def _settle_expired(self, S):
        """
        Deribit BTC settlement: intrinsic paid in BTC = max(S_T−K, 0) / S_T × size.
        No fee on expiry.
        """
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
        S, dvol, hv = self._row()
        sigma  = self._sigma(dvol)
        prev_S    = float(self._row(max(0, self.idx - 1))[0])
        prev_dvol = float(self._row(max(0, self.idx - 1))[1])
        ret_1d    = (S - prev_S) / prev_S if prev_S > 0 else 0.0

        unreal_btc  = self._unrealized_btc(S, dvol)
        margin_usd  = self._cached_margin          # computed once per step in step()
        margin_val  = self.margin_balance * S
        equity_btc  = self.margin_balance + unreal_btc

        has_call = float(self.call_pos is not None)
        has_put  = float(self.put_pos  is not None)
        min_dte  = min(
            self.call_pos["dte"] if self.call_pos else self.expiry_days,
            self.put_pos["dte"]  if self.put_pos  else self.expiry_days,
        )

        call_mono  = (self.call_pos["strike"] / S - 1.0) if self.call_pos else 0.0
        put_mono   = (self.put_pos["strike"]  / S - 1.0) if self.put_pos  else 0.0
        call_T     = (self.call_pos["dte"] / 365.0) if self.call_pos else 0.0
        put_T      = (self.put_pos["dte"]  / 365.0) if self.put_pos  else 0.0
        call_delta = bs_delta(S, self.call_pos["strike"], call_T, self.r, sigma, "call") if self.call_pos else 0.0
        put_delta  = bs_delta(S, self.put_pos["strike"],  put_T,  self.r, sigma, "put")  if self.put_pos  else 0.0

        # Rolling signals
        dvol_change     = (dvol - prev_dvol) / 100.0
        equity_drawdown = (equity_btc - self._peak_equity) / self.initial_margin_btc

        S_7d         = float(self._row(max(0, self.idx - 7))[0])
        btc_norm_7d  = S / S_7d if S_7d > 0 else 1.0
        ret_7d       = (S - S_7d) / S_7d if S_7d > 0 else 0.0
        eq_7d_ago    = (self._equity_history[0]
                        if len(self._equity_history) == self._equity_history.maxlen
                        else self.initial_margin_btc)
        equity_dd_7d = (equity_btc - eq_7d_ago) / self.initial_margin_btc

        return np.array([
            S / self._initial_price,                               # 0  btc_price_norm
            ret_1d,                                                # 1  ret_1d
            dvol / 100.0,                                          # 2  dvol_norm
            hv   / 100.0,                                          # 3  hv_norm
            (dvol - hv) / 100.0,                                   # 4  vol_premium
            dvol_change,                                           # 5  dvol_change
            self.step_count / self.episode_length,                 # 6  episode_progress
            has_call,                                              # 7  has_call
            has_put,                                               # 8  has_put
            min_dte / self.expiry_days,                            # 9  dte_norm
            call_mono,                                             # 10 call_moneyness
            put_mono,                                              # 11 put_moneyness
            call_delta,                                            # 12 call_delta
            put_delta,                                             # 13 put_delta
            unreal_btc / self.initial_margin_btc,                  # 14 unrealized_btc_norm
            self.margin_balance / self.initial_margin_btc,         # 15 margin_balance_norm
            margin_usd / max(margin_val, 1.0),                     # 16 margin_ratio
            equity_drawdown,                                       # 17 equity_drawdown
            btc_norm_7d,                                           # 18 btc_price_norm_7d
            ret_7d,                                                # 19 ret_7d
            equity_dd_7d,                                          # 20 equity_drawdown_7d
            *self._allowed_mask,                                   # 21–26 strategy mask ×6
        ], dtype=np.float32)

    # ------------------------------------------------------------------
    # Gymnasium API
    # ------------------------------------------------------------------

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        max_start = len(self.data) - self.episode_length - self.expiry_days - 2
        self.idx            = int(self.np_random.integers(0, max(1, max_start)))
        self._initial_price = float(self._row()[0])
        self.margin_balance = self.initial_margin_btc
        self.call_pos       = None
        self.put_pos        = None
        self.step_count     = 0
        self._prev_equity   = self.initial_margin_btc
        self._peak_equity   = self.initial_margin_btc
        self._equity_history.clear()
        self._equity_history.append(self.initial_margin_btc)
        return self._obs(), {}

    def step(self, action: int):
        S, dvol, _ = self._row()
        sigma       = self._sigma(dvol)

        # ── 1. Tick DTE and settle any expirations at today's price ──────────
        # Done BEFORE the action so the agent trades on a clean slate:
        # if a position expires today, margin is freed before the new order.
        if self.call_pos: self.call_pos["dte"] -= 1
        if self.put_pos:  self.put_pos["dte"]  -= 1
        self.margin_balance += self._settle_expired(S)

        # ── 2. Compute margin (expired options already removed) ───────────────
        self._cached_margin = self._portfolio_margin_usd(S, sigma)

        # ── 3. Execute action ─────────────────────────────────────────────────
        # Mask disallowed sell actions → hold (model learns not to try them)
        if action in _ALL_SELL_ACTIONS and action not in self._valid_sell_actions:
            action = 0

        btc_delta = 0.0
        defn = ACTION_DEFS[action]

        if defn == "close":
            btc_delta = self._close_all(S, sigma)

        elif isinstance(defn, dict) and "close_pct" in defn:
            btc_delta = self._close_at_profit(S, sigma, defn["close_pct"])

        elif defn is not None:
            want_call = "call_delta" in defn and self.call_pos is None
            want_put  = "put_delta"  in defn and self.put_pos  is None
            T         = self.expiry_days / 365.0

            will_be_covered = (
                want_call
                and "put_delta" not in defn
                and self.put_pos is None
                and self.margin_balance >= self._position_size()
            )
            margin_cap = 0.95 if will_be_covered else self.max_margin_ratio
            margin_val = self.margin_balance * S

            # Prospective margin: check combined margin AFTER opening new legs.
            # A strangle can have LOWER margin than a naked call (legs offset).
            prospective = []
            size = self._position_size()
            if want_call:
                K_c = strike_from_delta(S, T, self.r, sigma, defn["call_delta"], "call")
                prospective.append(({"strike": K_c, "size": size, "dte": self.expiry_days, "type": "call"}, "call"))
            if want_put:
                K_p = strike_from_delta(S, T, self.r, sigma, defn["put_delta"], "put")
                prospective.append(({"strike": K_p, "size": size, "dte": self.expiry_days, "type": "put"}, "put"))

            prospective_margin = self._portfolio_margin_usd(S, sigma, extra_positions=prospective)
            if prospective_margin < margin_val * margin_cap:
                if want_call:
                    self.call_pos, p = self._sell_leg(S, sigma, K_c, "call")
                    btc_delta += p
                if want_put:
                    self.put_pos, p = self._sell_leg(S, sigma, K_p, "put")
                    btc_delta += p

        self.margin_balance += btc_delta

        # ── 4. Advance to next day ────────────────────────────────────────────
        self.idx        += 1
        self.step_count += 1

        # Reward: change in equity (BTC), normalised by initial margin
        S_new, dvol_new, _ = self._row() if self.idx < len(self.data) else self._row(self.idx - 1)
        equity_now  = self._equity_btc(S_new, dvol_new)
        reward      = (equity_now - self._prev_equity) / self.initial_margin_btc
        self._prev_equity = equity_now
        self._peak_equity = max(self._peak_equity, equity_now)

        # Capital efficiency bonus (BTC-scaled)
        has_pos = self.call_pos is not None or self.put_pos is not None
        reward += self.capital_eff_bonus if has_pos else -self.capital_eff_bonus

        # Net delta guard
        # Assets: margin_balance BTC (delta = +1/BTC)
        # Obligations: short call reduces delta; short put adds delta (put_d < 0 → -put_d > 0)
        # Covered calls are fine (net_delta < margin_balance); penalise only when
        # net delta exceeds collateral, i.e. short puts lever exposure beyond assets.
        sigma_new = self._sigma(dvol_new)
        net_delta = self.margin_balance
        if self.call_pos:
            call_d     = bs_delta(S_new, self.call_pos["strike"], self.call_pos["dte"] / 365, self.r, sigma_new, "call")
            net_delta -= call_d * self.call_pos["size"]
        if self.put_pos:
            put_d      = bs_delta(S_new, self.put_pos["strike"],  self.put_pos["dte"]  / 365, self.r, sigma_new, "put")
            net_delta -= put_d * self.put_pos["size"]   # put_d < 0, so this increases net_delta
        net_delta_norm = net_delta / max(self.initial_margin_btc, 1e-8)
        excess = max(0.0, net_delta_norm - 1.0 - self.delta_threshold)
        reward -= excess * self.delta_penalty_coef

        # Asymmetric loss penalty — amplify bad steps during losing weeks
        self._equity_history.append(equity_now)
        weekly_ref  = self._equity_history[0]   # equity up to expiry_days ago
        weekly_drop = (weekly_ref - equity_now) / max(weekly_ref, 1e-8)
        if weekly_drop > self.loss_threshold and reward < 0:
            reward *= self.loss_multiplier

        terminated = equity_now < self.initial_margin_btc * 0.50
        truncated  = self.step_count >= self.episode_length or self.idx >= len(self.data) - 1

        return self._obs(), float(reward), terminated, truncated, {}
