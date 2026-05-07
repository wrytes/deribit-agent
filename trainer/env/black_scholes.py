import numpy as np
from scipy.stats import norm


def _d1_d2(S, K, T, r, sigma):
    d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    return d1, d1 - sigma * np.sqrt(T)


def price(S: float, K: float, T: float, r: float, sigma: float, option_type="call") -> float:
    """Black-Scholes option price in USD per unit of underlying. T in years."""
    if T <= 0:
        return float(max(S - K, 0)) if option_type == "call" else float(max(K - S, 0))
    d1, d2 = _d1_d2(S, K, T, r, sigma)
    if option_type == "call":
        return float(S * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d2))
    return float(K * np.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1))


def delta(S: float, K: float, T: float, r: float, sigma: float, option_type="call") -> float:
    if T <= 0:
        if option_type == "call":
            return 1.0 if S > K else 0.0
        return -1.0 if S < K else 0.0
    d1, _ = _d1_d2(S, K, T, r, sigma)
    return float(norm.cdf(d1)) if option_type == "call" else float(norm.cdf(d1) - 1.0)


def theta(S: float, K: float, T: float, r: float, sigma: float, option_type="call") -> float:
    """Daily theta decay in USD per unit of underlying."""
    if T <= 0:
        return 0.0
    d1, d2 = _d1_d2(S, K, T, r, sigma)
    base = -S * norm.pdf(d1) * sigma / (2 * np.sqrt(T))
    if option_type == "call":
        return float((base - r * K * np.exp(-r * T) * norm.cdf(d2)) / 365)
    return float((base + r * K * np.exp(-r * T) * norm.cdf(-d2)) / 365)


def vega(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Vega in USD per 1% change in IV."""
    if T <= 0:
        return 0.0
    d1, _ = _d1_d2(S, K, T, r, sigma)
    return float(S * norm.pdf(d1) * np.sqrt(T) / 100)


def strike_from_delta(S: float, T: float, r: float, sigma: float,
                      target_delta: float, option_type="call",
                      round_to: int = 1000) -> float:
    """
    Find the strike K such that delta(K) == target_delta, then round to
    the nearest round_to USD increment (e.g. 1000 → $43,000, $44,000).

    Call delta range : 0.0 (deep OTM) → 1.0 (deep ITM), ATM ≈ 0.50
    Put  delta range : -1.0 (deep ITM) → 0.0 (deep OTM), ATM ≈ -0.50

    Derivation:
      delta_call = N(d1)  →  d1 = N⁻¹(delta)
      delta_put  = N(d1) - 1  →  d1 = N⁻¹(delta + 1)
      K = S × exp( -d1 × σ√T  +  (r + σ²/2) × T )
    """
    if T <= 0:
        return round(S / round_to) * round_to
    if option_type == "call":
        d1 = float(norm.ppf(np.clip(target_delta, 1e-6, 1 - 1e-6)))
    else:
        d1 = float(norm.ppf(np.clip(target_delta + 1.0, 1e-6, 1 - 1e-6)))
    K_raw = S * np.exp(-d1 * sigma * np.sqrt(T) + (r + 0.5 * sigma ** 2) * T)
    return float(round(K_raw / round_to) * round_to)


def iv_hv_spread(dvol: float, hv: float) -> float:
    """Volatility premium: positive means options are richly priced (good for short premium)."""
    return dvol - hv
