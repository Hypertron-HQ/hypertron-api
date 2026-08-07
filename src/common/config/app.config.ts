import { registerAs } from '@nestjs/config';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  appUrl: string;
  checkoutBaseUrl: string;
  swaggerEnabled: boolean;
  corsOrigins: string[];
}

export default registerAs(
  'app',
  (): AppConfig => ({
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3000', 10),
    appUrl: process.env.APP_URL ?? 'http://localhost:3000',
    checkoutBaseUrl:
      process.env.CHECKOUT_BASE_URL ?? 'http://localhost:3001',
    swaggerEnabled: process.env.SWAGGER_ENABLED === 'true',
    corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
  }),
);
