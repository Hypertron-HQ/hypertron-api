import { registerAs } from '@nestjs/config';

export interface CoreBackendConfig {
  url: string;
  serviceAccountApiKey: string;
  requestTimeoutMs: number;
}

const DEFAULT_CORE_BACKEND_URL =
  'https://hypertron-core-backend.onrender.com';

export default registerAs(
  'coreBackend',
  (): CoreBackendConfig => ({
    url: (process.env.CORE_BACKEND_URL ?? DEFAULT_CORE_BACKEND_URL)
      .trim()
      .replace(/\/$/, ''),
    serviceAccountApiKey: (
      process.env.CORE_BACKEND_SERVICE_ACCOUNT_API_KEY ?? ''
    ).trim(),
    requestTimeoutMs: parseInt(
      process.env.CORE_BACKEND_TIMEOUT_MS ?? '8000',
      10,
    ),
  }),
);
