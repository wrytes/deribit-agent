# ---------------------------------------------------------------------------
# Base image
# ---------------------------------------------------------------------------
# Default: official PyTorch image with CUDA 12.1 + cuDNN 8.
# Swap the FROM line if your host has a different CUDA version, or use
# python:3.11-slim for CPU-only training.
#
# CUDA 12.4:  pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime
# CPU-only:   python:3.11-slim
# ---------------------------------------------------------------------------
FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime

# Keeps Python output unbuffered (critical for real-time Docker logs)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    MODELS_DIR=/app/models

WORKDIR /app

# ---------------------------------------------------------------------------
# System deps (minimal)
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq-dev \
        gcc \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Python deps
# ---------------------------------------------------------------------------
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# ---------------------------------------------------------------------------
# App code
# ---------------------------------------------------------------------------
COPY . .

# Model artifacts — mount a volume here in production
RUN mkdir -p /app/models

EXPOSE 8000

# ---------------------------------------------------------------------------
# Entrypoint — FastAPI server
# ---------------------------------------------------------------------------
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
