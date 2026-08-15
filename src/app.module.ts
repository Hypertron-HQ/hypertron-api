import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { configValidationSchema } from './common/config/config.validation';
import appConfig from './common/config/app.config';
import databaseConfig from './common/config/database.config';
import queueConfig from './common/config/queue.config';
import stellarConfig from './common/config/stellar.config';
import securityConfig from './common/config/security.config';

import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { StellarModule } from './infrastructure/stellar/stellar.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { DeveloperModule } from './modules/developer/developer.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ReconcilerModule } from './modules/reconciler/reconciler.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { MetricsModule } from './observability/metrics.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { HttpMetricsInterceptor } from './observability/http-metrics.interceptor';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { HypertronExceptionFilter } from './common/filters/hypertron-exception.filter';
import { ThrottlerExceptionFilter } from './common/filters/throttler-exception.filter';
import { generateRequestId } from './common/utils/crypto.util';
import type { QueueConfig } from './common/config/queue.config';

function buildThrottlers() {
  return [
    {
      name: 'payment-create',
      ttl: 60_000,
      limit: parseInt(
        process.env.RATE_LIMIT_PAYMENT_CREATE_PER_MIN ?? '60',
        10,
      ),
    },
    {
      name: 'read',
      ttl: 60_000,
      limit: parseInt(process.env.RATE_LIMIT_READ_PER_MIN ?? '300', 10),
    },
    {
      name: 'dashboard',
      ttl: 60_000,
      limit: parseInt(process.env.RATE_LIMIT_DASHBOARD_PER_MIN ?? '120', 10),
    },
  ];
}

@Module({
  imports: [
    // ── Config (global) ────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        databaseConfig,
        queueConfig,
        stellarConfig,
        securityConfig,
      ],
      validationSchema: configValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),

    // ── Structured logging (global) ────────────────────────────────────────
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        genReqId: (req) => {
          const incoming = req.headers['x-request-id'];
          const raw = Array.isArray(incoming) ? incoming[0] : incoming;
          if (typeof raw === 'string' && raw.length >= 8 && raw.length <= 128) {
            return raw;
          }
          return generateRequestId();
        },
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        // Never log secrets or auth material
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'req.body.signing_secret',
            'req.body.secret_key',
            'res.body.signing_secret',
            'res.body.secret_key',
          ],
          remove: true,
        },
        customProps: (req) => ({
          context: 'HTTP',
          requestId: (req as { id?: string }).id,
        }),
      },
    }),

    // ── Rate limiting ──────────────────────────────────────────────────────
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const throttlers = buildThrottlers();
        const queue = config.get<QueueConfig>('queue');
        const useRedis =
          process.env.NODE_ENV !== 'test' &&
          process.env.THROTTLE_STORAGE !== 'memory' &&
          Boolean(queue?.redisUrl);

        if (useRedis) {
          return {
            throttlers,
            storage: new ThrottlerStorageRedisService(queue!.redisUrl),
            setHeaders: true,
          };
        }

        return { throttlers, setHeaders: true };
      },
    }),

    // ── Infrastructure ─────────────────────────────────────────────────────
    PrismaModule,
    QueueModule,
    StellarModule,
    MetricsModule,
    RateLimitModule,

    // ── Feature modules ────────────────────────────────────────────────────
    HealthModule,
    AuthModule,
    CustomersModule,
    // Global — provides WEBHOOK_DISPATCHER to EventsService without a cycle.
    WebhooksModule,
    DeveloperModule,
    PaymentsModule,
    ReconcilerModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    { provide: APP_FILTER, useClass: ThrottlerExceptionFilter },
    { provide: APP_FILTER, useClass: HypertronExceptionFilter },
  ],
})
export class AppModule {}
