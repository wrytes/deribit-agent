# deribit-agent

ML-powered trading agent backend for Deribit options.
Handles historical data ingestion, model training orchestration, and live/paper agent execution.

---

## Stack

| Layer | Tech |
|---|---|
| API | NestJS 11, TypeScript |
| Database | PostgreSQL + Prisma ORM |
| Queue | BullMQ (Redis) |
| Scheduler | `@nestjs/schedule` (cron) |
| Notifications | Telegram bot (optional) |
| ML runtime | Python FastAPI sidecar (separate process) |
| Deribit client | `@wrytes/deribit-api-client` (local linked) |

---

## Setup

```bash
# 1. Install deps
yarn install

# 2. Start Postgres + Redis
docker compose -f stack.testing.yml up -d

# 3. Copy env
cp .env.example .env
# Set DATABASE_URL, API_KEY_SECRET, REDIS_*, and optionally TELEGRAM_BOT_TOKEN

# 4. Run migrations + generate Prisma client
yarn prisma:migrate
yarn prisma:generate

# 5. Start dev server
yarn start:dev
```

Swagger UI available at `http://localhost:3031/api`.

---

## Architecture

```
deribit-agent (NestJS)
├── data-ingestion     OHLCV candles + options IV surface snapshots
├── training           BullMQ job queue → Python sidecar via HTTP
├── agent              Run/pause/stop agent instances, log actions
├── market-data        Live IV rank, DVOL, RV (used by scheduler)
├── scheduler          Hourly market + greeks snapshots (cron)
├── auth               API keys, magic links, Telegram user bootstrap
├── trading            Raw Deribit order placement (buy/sell/cancel)
└── telegram           Lightweight bot: /market, /balance, /connect, /api_*
```

---

## REST API overview

All endpoints require an API key header: `x-api-key: rw_prod_<keyId>.<secret>`.
Generate one via Telegram `/api_create` or `POST /auth/verify?token=<magic-link>`.

### Data ingestion

```
GET  /data/candles/stats              coverage per instrument/resolution
GET  /data/candles?instrument=&resolution=&from=&to=&limit=
POST /data/candles/backfill           { instrument, resolution, from, to? }
POST /data/candles/ingest-latest      { instrument, resolution }

GET  /data/options/stats              coverage per currency
GET  /data/options?currency=&expiry=&from=&to=&limit=
POST /data/options/snapshot           { currency: "BTC" | "ETH" }
```

### Training

```
POST   /training/sessions             create + queue a training job
GET    /training/sessions             list all sessions (filter by ?status=)
GET    /training/sessions/:id
DELETE /training/sessions/:id         cancel a queued/running job

GET    /training/queue                BullMQ queue stats

GET    /training/models               list trained models
GET    /training/models/:id
POST   /training/models               manually register an external model
```

### Agent runs

```
POST   /agent/runs                    create a run (paper or live)
GET    /agent/runs
GET    /agent/runs/:id
GET    /agent/runs/:id/summary        aggregated action breakdown + PnL
POST   /agent/runs/:id/stop
POST   /agent/runs/:id/pause
POST   /agent/runs/:id/resume

POST   /agent/runs/:id/actions        log a model decision
GET    /agent/runs/:id/actions
```

---

## API key scopes

| Scope | Used for |
|---|---|
| `ACCOUNT_READ` | user info |
| `MARKET_READ` | market data endpoints |
| `DATA_READ/WRITE` | candle + options ingestion |
| `TRAINING_READ/WRITE` | training sessions and models |
| `AGENT_READ/WRITE` | agent runs and actions |
| `ADMIN` | admin operations |

---

## Training sidecar

The training processor posts `{ session_id }` to `TRAINER_URL/train` (default `http://localhost:8000`).
The sidecar should respond with:

```json
{
  "total_timesteps": 500000,
  "final_reward": 1.23,
  "model_path": "/models/ppo-btc-abc123.zip",
  "mean_reward": 1.1,
  "std_reward": 0.3,
  "sharpe_ratio": 1.8,
  "max_drawdown": 0.12,
  "win_rate": 0.62
}
```

See `ml-intro/` for the reference Python implementation (PPO via Stable-Baselines3).

---

## Related repos

| Repo | Purpose |
|---|---|
| `deribit-api-client` | TypeScript WebSocket client for Deribit |
| `ml-intro` | Python RL training environment (PPO, Gymnasium) |
| `wrytes-app` | Next.js frontend (planned) |
