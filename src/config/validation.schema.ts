import * as Joi from 'joi';

export const validationSchema = Joi.object({
	// Application
	NODE_ENV: Joi.string()
		.valid('development', 'production', 'test')
		.default('development'),
	PORT: Joi.number().default(3031),
	WRYTES_API_URL: Joi.string().uri().default('http://localhost:3000'),

	// Database
	DATABASE_URL: Joi.string().required(),

	// Redis
	REDIS_HOST: Joi.string().default('localhost'),
	REDIS_PORT: Joi.number().default(6379),
	REDIS_PASSWORD: Joi.string().allow('').optional(),

	// Deribit
	DERIBIT_CLIENT_ID: Joi.string().allow('').optional(),
	DERIBIT_CLIENT_SECRET: Joi.string().allow('').optional(),
	DERIBIT_BASE_URL: Joi.string().default('wss://www.deribit.com/ws/api/v2'),

	// Telegram (optional — agent runs without it)
	TELEGRAM_BOT_TOKEN: Joi.string().allow('').optional(),
	TELEGRAM_WEBHOOK_DOMAIN: Joi.string().allow('').optional(),
	TELEGRAM_WEBHOOK_PATH: Joi.string().allow('').default('').optional(),

	// Training runner (Python FastAPI sidecar)
	TRAINER_URL: Joi.string().default('http://localhost:8000'),

	// Logging
	LOG_LEVEL: Joi.string()
		.valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
		.default('info'),
	LOG_PRETTY: Joi.boolean().default(false),

	// Rate Limiting
	THROTTLE_TTL: Joi.number().default(60),
	THROTTLE_LIMIT: Joi.number().default(100),
});
