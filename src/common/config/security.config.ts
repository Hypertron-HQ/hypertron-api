import { registerAs } from '@nestjs/config';

export interface SecurityConfig {
  apiKeySaltRounds: number;
  webhookSecretEncryptionKey: string;
  /** Shared with hypertron-core-backend — signs Freighter ht_dashboard cookies */
  authSecret: string;
}

export default registerAs(
  'security',
  (): SecurityConfig => ({
    apiKeySaltRounds: parseInt(process.env.API_KEY_SALT_ROUNDS ?? '12', 10),
    webhookSecretEncryptionKey:
      process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ?? '',
    authSecret: process.env.AUTH_SECRET?.trim() ?? '',
  }),
);
