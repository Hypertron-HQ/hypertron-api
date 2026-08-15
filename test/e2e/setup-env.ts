/**
 * Load e2e runtime env before each worker starts Nest / Prisma.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STATE_PATH = join(__dirname, '.e2e-runtime.json');

if (!existsSync(STATE_PATH)) {
  // globalSetup writes this; if missing, fail clearly in suites.
  process.env.E2E_RUNTIME_MISSING = '1';
} else {
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as {
    skipped?: boolean;
    databaseUrl?: string;
    redisUrl?: string;
    authSecret?: string;
    encryptionKey?: string;
  };

  if (state.skipped) {
    process.env.E2E_SKIP_DOCKER = '1';
  } else {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = state.databaseUrl!;
    process.env.REDIS_URL = state.redisUrl!;
    process.env.AUTH_SECRET = state.authSecret!;
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = state.encryptionKey!;
    process.env.THROTTLE_STORAGE = 'memory';
    process.env.DISABLE_WORKERS = 'true';
    process.env.OTEL_SDK_DISABLED = 'true';
    process.env.SWAGGER_ENABLED = 'false';
    process.env.API_KEY_SALT_ROUNDS = '10';
    process.env.RATE_LIMIT_PAYMENT_CREATE_PER_MIN = '5';
    process.env.RATE_LIMIT_READ_PER_MIN = '300';
    process.env.RATE_LIMIT_DASHBOARD_PER_MIN = '120';
    process.env.CHECKOUT_BASE_URL = 'http://localhost:3001';
    process.env.APP_URL = 'http://localhost:3000';
  }
}
