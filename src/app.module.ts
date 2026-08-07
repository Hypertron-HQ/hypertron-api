import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configValidationSchema } from './common/config/config.validation';
import appConfig from './common/config/app.config';
import databaseConfig from './common/config/database.config';
import queueConfig from './common/config/queue.config';
import stellarConfig from './common/config/stellar.config';
import securityConfig from './common/config/security.config';

import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    // ── Config (global) ────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, queueConfig, stellarConfig, securityConfig],
      validationSchema: configValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),

    // ── Structured logging (global) ────────────────────────────────────────
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        // Never log the Authorization header
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        customProps: () => ({
          context: 'HTTP',
        }),
      },
    }),

    // ── Infrastructure ─────────────────────────────────────────────────────
    PrismaModule,

    // ── Feature modules ────────────────────────────────────────────────────
    HealthModule,
  ],
})
export class AppModule {}
