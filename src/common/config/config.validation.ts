import * as Joi from 'joi';

/**
 * Joi schema for environment variable validation.
 * The application will refuse to start if required variables are missing or malformed.
 */
export const configValidationSchema = Joi.object({
  // ── Application ──────────────────────────────────────────────────────────
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  CHECKOUT_BASE_URL: Joi.string().uri().default('http://localhost:3001'),
  SWAGGER_ENABLED: Joi.boolean().default(false),
  CORS_ORIGINS: Joi.string().default(''),

  // ── Database ─────────────────────────────────────────────────────────────
  DATABASE_URL: Joi.string().required(),

  // ── Redis ─────────────────────────────────────────────────────────────────
  REDIS_URL: Joi.string().default('redis://localhost:6379'),

  // ── Stellar ───────────────────────────────────────────────────────────────
  STELLAR_TESTNET_HORIZON_URL: Joi.string()
    .uri()
    .default('https://horizon-testnet.stellar.org'),
  STELLAR_MAINNET_HORIZON_URL: Joi.string()
    .uri()
    .default('https://horizon.stellar.org'),
  PAYMENT_POOL_ADDRESS: Joi.string().default(''),
  STELLAR_TESTNET_DESTINATION_ADDRESS: Joi.string().default(''),
  STELLAR_MAINNET_DESTINATION_ADDRESS: Joi.string().default(''),
  STELLAR_USDC_ISSUER_TESTNET: Joi.string().default(''),
  STELLAR_USDC_ISSUER_MAINNET: Joi.string().default(''),
  STELLAR_EURC_ISSUER_TESTNET: Joi.string().default(''),
  STELLAR_EURC_ISSUER_MAINNET: Joi.string().default(''),
  STELLAR_FINALITY_DELAY_MS: Joi.number().integer().min(0).default(5000),
  STELLAR_RECONCILER_LOOKBACK: Joi.number()
    .integer()
    .min(1)
    .max(200)
    .default(50),
  DISABLE_WORKERS: Joi.boolean().truthy('true').falsy('false').default(false),

  // ── Security ──────────────────────────────────────────────────────────────
  AUTH_SECRET: Joi.string()
    .min(16)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().default('dev-auth-secret-change-me-32b'),
    }),
  INTERNAL_SERVICE_TOKEN: Joi.string()
    .min(16)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().default('dev-internal-service-token-change-me'),
    }),
  API_KEY_SALT_ROUNDS: Joi.number().integer().min(10).max(14).default(12),
  WEBHOOK_SECRET_ENCRYPTION_KEY: Joi.string()
    .pattern(/^[0-9a-f]{64}$/)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().default(
        '0'.repeat(64), // placeholder for local dev
      ),
    }),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  RATE_LIMIT_PAYMENT_CREATE_PER_MIN: Joi.number().integer().min(1).default(60),
  RATE_LIMIT_READ_PER_MIN: Joi.number().integer().min(1).default(300),
  RATE_LIMIT_DASHBOARD_PER_MIN: Joi.number().integer().min(1).default(120),
  THROTTLE_STORAGE: Joi.string().valid('redis', 'memory').default('redis'),

  // ── OpenTelemetry (optional) ──────────────────────────────────────────────
  OTEL_SDK_DISABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  OTEL_SERVICE_NAME: Joi.string().default('hypertron-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri().allow('').optional(),
});
