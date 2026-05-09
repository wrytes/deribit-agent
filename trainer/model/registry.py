"""
ModelRegistry — handles saving and loading PPO models with manifest validation.

Usage:
    registry = ModelRegistry(MODELS_DIR)

    # After training:
    zip_path, manifest = registry.save(model, session_id)

    # Before inference:
    model, manifest = registry.load(model_path)  # raises if obs_version mismatch
"""

import logging
from pathlib import Path

from stable_baselines3 import PPO

from config.defaults import ACTION_DIMS, DATA_COLUMNS, OBS_FEATURES, OBS_VERSION
from model.manifest import ModelManifest

logger = logging.getLogger(__name__)


class ModelRegistry:
    def __init__(self, models_dir: "str | Path"):
        self.models_dir = Path(models_dir)
        self.models_dir.mkdir(parents=True, exist_ok=True)

    # ── Save ─────────────────────────────────────────────────────────────────

    def save(
        self,
        model: PPO,
        session_id: str,
        *,
        algorithm: str = "PPO",
        policy: str = "MlpPolicy",
        env_version: str = "v2",
    ) -> tuple[Path, ModelManifest]:
        """Save model weights and write a companion manifest file."""
        model_name = f"{session_id}_ppo"
        model_path = self.models_dir / model_name
        model.save(str(model_path))
        zip_path = Path(f"{model_path}.zip")

        manifest = ModelManifest(
            session_id=session_id,
            obs_version=OBS_VERSION,
            obs_dims=len(OBS_FEATURES),
            obs_features=list(OBS_FEATURES),
            action_dims=ACTION_DIMS,
            env_version=env_version,
            data_columns=list(DATA_COLUMNS),
            algorithm=algorithm,
            policy=policy,
        )
        manifest_path = manifest.save(zip_path)
        logger.info(
            "Saved model → %s  manifest → %s  (obs_version=%s, obs_dims=%d)",
            zip_path, manifest_path, OBS_VERSION, len(OBS_FEATURES),
        )
        return zip_path, manifest

    # ── Load ─────────────────────────────────────────────────────────────────

    def load(self, model_path: "str | Path") -> tuple[PPO, ModelManifest]:
        """
        Load a PPO model and validate its manifest against the current environment.

        Raises FileNotFoundError  if the .zip or manifest is missing.
        Raises ValueError         if the manifest declares an incompatible obs_version or obs_dims.
        """
        model_path = self._resolve_path(model_path)

        manifest = ModelManifest.load(model_path)
        manifest.validate(OBS_VERSION, len(OBS_FEATURES))

        model = PPO.load(str(model_path))
        logger.info(
            "Loaded model from %s  (obs_version=%s, obs_dims=%d)",
            model_path, manifest.obs_version, manifest.obs_dims,
        )
        return model, manifest

    # ── Internals ────────────────────────────────────────────────────────────

    def _resolve_path(self, model_path: "str | Path") -> Path:
        """Return an existing .zip path, falling back to models_dir/<filename>."""
        p = Path(model_path)
        if p.exists():
            return p
        alt = self.models_dir / p.name
        if alt.exists():
            return alt
        raise FileNotFoundError(
            f"Model file not found: {model_path}\n"
            f"Also checked: {alt}"
        )
