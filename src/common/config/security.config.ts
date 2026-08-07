import { registerAs } from '@nestjs/config';

export interface SecurityConfig {
  apiKeySaltRounds: number;
  webhookSecretEncryptionKey: string;
}

export default registerAs(
  'security',
  (): SecurityConfig => ({
    apiKeySaltRounds: parseInt(process.env.API_KEY_SALT_ROUNDS ?? '12', 10),
    webhookSecretEncryptionKey:
      process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ?? '',
  }),
);
