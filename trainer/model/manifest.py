"""
ModelManifest — stored alongside each trained model as <session_id>_ppo_manifest.json.

The manifest is the contract between a trained model and the runtime environment.
If OBS_VERSION or obs_dims don't match the current environment, the model is rejected.
"""

import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class ModelManifest:
    session_id:   str
    obs_version:  str
    obs_dims:     int
    obs_features: list[str]
    action_dims:  int
    env_version:  str
    data_columns: list[str]
    algorithm:    str
    policy:       str

    # ── Persistence ──────────────────────────────────────────────────────────

    def save(self, zip_path: "str | Path") -> Path:
        manifest_path = _manifest_path(zip_path)
        manifest_path.write_text(json.dumps(asdict(self), indent=2))
        return manifest_path

    @classmethod
    def load(cls, zip_path: "str | Path") -> "ModelManifest":
        manifest_path = _manifest_path(zip_path)
        if not manifest_path.exists():
            raise FileNotFoundError(
                f"No manifest found for model at {zip_path}.\n"
                "Models trained before the manifest system was introduced are no longer "
                "supported. Retrain the model to generate a manifest."
            )
        data = json.loads(manifest_path.read_text())
        return cls(**data)

    # ── Compatibility ─────────────────────────────────────────────────────────

    def validate(self, expected_obs_version: str, expected_obs_dims: int) -> None:
        """Raise ValueError with a clear message if this manifest is incompatible."""
        errors: list[str] = []
        if self.obs_version != expected_obs_version:
            errors.append(
                f"obs_version: model has {self.obs_version!r}, env expects {expected_obs_version!r}"
            )
        if self.obs_dims != expected_obs_dims:
            errors.append(
                f"obs_dims: model has {self.obs_dims}, env expects {expected_obs_dims}"
            )
        if errors:
            raise ValueError(
                f"Model {self.session_id!r} is incompatible with the current environment:\n"
                + "\n".join(f"  • {e}" for e in errors)
                + "\nRetrain the model against the current environment to get a compatible version."
            )


def _manifest_path(zip_path: "str | Path") -> Path:
    p = str(zip_path)
    base = p[:-4] if p.endswith(".zip") else p
    return Path(f"{base}_manifest.json")
