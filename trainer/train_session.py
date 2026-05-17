"""
Orchestrate a full training run for a single TrainingSession.

Called by main.py (FastAPI) with a session_id. Reads config from DB, builds
data, trains a PPO model, evaluates on a holdout slice, saves the model with
a manifest, and returns a metrics dict for the NestJS callback.
"""

import logging
import os
import sys
from pathlib import Path

from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback
from stable_baselines3.common.evaluation import evaluate_policy
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv

from config.defaults import DEFAULT_ENV, DEFAULT_TRAIN
from data.loader import build_data, connect, load_candles, load_dvol, load_session
from env.options_env import OptionsEnv
from model.registry import ModelRegistry

sys.stdout.reconfigure(line_buffering=True)
logger = logging.getLogger(__name__)

MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/app/models"))
N_ENVS     = int(os.environ.get("N_ENVS", "16"))


def train_session(session_id: str) -> dict:
    """Full training run. Returns metrics dict consumed by NestJS TrainingProcessor."""
    logger.info("Session %s — connecting to DB", session_id)
    conn = connect()
    try:
        session = load_session(conn, session_id)
        candles = load_candles(conn, session["currency"], session["dataFrom"], session["dataTo"])
        dvol_df = load_dvol(conn, session["dataFrom"], session["dataTo"])
    finally:
        conn.close()

    logger.info(
        "Session %s — %s  %s → %s  algorithm=%s",
        session_id, session["currency"],
        session["dataFrom"], session["dataTo"], session["algorithm"],
    )

    hp        = session.get("hyperparams") or {}
    env_cfg   = {**DEFAULT_ENV,   **(hp.get("env", {}))}
    train_cfg = {**DEFAULT_TRAIN, **(hp.get("training", {}))}
    for k in DEFAULT_TRAIN:
        if k in hp:
            train_cfg[k] = hp[k]

    algorithm = session.get("algorithm", "PPO")
    policy    = str(train_cfg.pop("policy", "MlpPolicy"))

    total_timesteps = int(train_cfg["total_timesteps"])

    data, _ = build_data(candles, dvol_df)
    split      = int(len(data) * 0.8)
    train_data = data[:split]
    eval_data  = data[split:]

    if len(train_data) < 60:
        raise ValueError(f"Training split too small: {len(train_data)} rows")

    logger.info("Split: %d train / %d eval rows", len(train_data), len(eval_data))

    checkpoint_dir = MODELS_DIR / "checkpoints" / session_id
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    vec_env = SubprocVecEnv(
        [lambda d=train_data, c=env_cfg: OptionsEnv(d, c) for _ in range(N_ENVS)]
    )

    resume_model_path = hp.get("resume_model_path")
    if resume_model_path:
        logger.info("Session %s — resuming from %s", session_id, resume_model_path)
        resume_registry = ModelRegistry(MODELS_DIR)
        model, _ = resume_registry.load(resume_model_path)  # validates obs_version
        model.set_env(vec_env)
        model.learning_rate = float(train_cfg["learning_rate"])
        model.n_steps       = int(train_cfg["n_steps"])
        model.batch_size    = int(train_cfg["batch_size"])
        model.n_epochs      = int(train_cfg["n_epochs"])
        model.gamma         = float(train_cfg["gamma"])
        model.ent_coef      = float(train_cfg.get("ent_coef", 0.02))
        policy = type(model.policy).__name__
    else:
        model = PPO(
            policy,
            vec_env,
            learning_rate = float(train_cfg["learning_rate"]),
            n_steps       = int(train_cfg["n_steps"]),
            batch_size    = int(train_cfg["batch_size"]),
            n_epochs      = int(train_cfg["n_epochs"]),
            gamma         = float(train_cfg["gamma"]),
            ent_coef      = float(train_cfg.get("ent_coef", 0.02)),
            verbose       = 1,
        )

    logger.info(
        "Policy input dim: %d  obs_space: %s  action_space: %s",
        model.policy.mlp_extractor.policy_net[0].in_features,
        vec_env.observation_space.shape,
        vec_env.action_space,
    )

    checkpoint_cb = CheckpointCallback(
        save_freq   = max(50_000, 1),
        save_path   = str(checkpoint_dir),
        name_prefix = "ppo",
        verbose     = 1,
    )

    logger.info("Training %s/%s for %d timesteps …", algorithm, policy, total_timesteps)
    model.learn(total_timesteps=total_timesteps, callback=checkpoint_cb)

    registry = ModelRegistry(MODELS_DIR)
    zip_path, manifest = registry.save(model, session_id, algorithm=algorithm, policy=policy)
    size_bytes = zip_path.stat().st_size if zip_path.exists() else 0

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
        "model_path":      str(zip_path),
        "model_name":      f"{session_id}_ppo",
        "size_bytes":      size_bytes,
        "mean_reward":     float(mean_reward),
        "std_reward":      float(std_reward),
        # Manifest fields — stored in TrainedModel.metadata by NestJS
        "obs_version":     manifest.obs_version,
        "obs_dims":        manifest.obs_dims,
        "obs_features":    manifest.obs_features,
        "action_dims":     manifest.action_dims,
        "data_columns":    manifest.data_columns,
        "env_version":     manifest.env_version,
        "policy":          manifest.policy,
    }
