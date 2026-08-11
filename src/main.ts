import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';

import { AppModule } from './app.module';
import type { AppConfig } from './common/config/app.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Pino logger replaces the default NestJS logger
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig>('app')!;

  // ── Security headers ───────────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: false, // API-only, no HTML
      crossOriginEmbedderPolicy: false,
      hsts: {
        maxAge: 31_536_000,
        includeSubDomains: true,
      },
    }),
  );

  // ── CORS ───────────────────────────────────────────────────────────────────
  const allowedOrigins = appConfig.corsOrigins;
  app.enableCors({
    origin:
      allowedOrigins.length > 0
        ? allowedOrigins
        : appConfig.nodeEnv === 'production'
          ? false           // block all cross-origin in prod if not configured
          : true,           // allow all in local dev
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    credentials: true,
  });

  // ── Global validation pipe ─────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // strip undeclared properties
      forbidNonWhitelisted: true,   // throw 400 for unknown properties
      transform: true,              // coerce query param types
      transformOptions: {
        enableImplicitConversion: false,
      },
    }),
  );

  // ── API versioning (URL-based: /v1, /v2 …) ────────────────────────────────
  app.enableVersioning({
    type: VersioningType.URI,
  });

  // ── OpenAPI / Swagger ──────────────────────────────────────────────────────
  if (appConfig.swaggerEnabled || appConfig.nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Hypertron Payments API')
      .setDescription(
        'Production-grade stablecoin payment gateway API. ' +
          'Internal codename: HyperTone API.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'sk_test_... / sk_live_...' },
        'ApiKey',
      )
      .addApiKey(
        {
          type: 'apiKey',
          in: 'cookie',
          name: 'ht_dashboard',
          description:
            'Freighter session cookie from hypertron-core-backend (HMAC AUTH_SECRET)',
        },
        'SessionCookie',
      )
      .addTag('Payments', 'Create, read, list, and cancel payments')
      .addTag('Customers', 'Merchant-scoped customer records')
      .addTag('Developer', 'Dashboard control-plane: API keys and webhooks')
      .addTag('Health', 'Health and readiness checks')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  app.enableShutdownHooks();

  // ── Start server ──────────────────────────────────────────────────────────
  const port = appConfig.port;
  await app.listen(port);

  logger.log(
    `🚀 HyperTone Payments API listening on port ${port} [${appConfig.nodeEnv}]`,
    'Bootstrap',
  );

  if (appConfig.swaggerEnabled || appConfig.nodeEnv !== 'production') {
    logger.log(
      `📖 OpenAPI docs available at http://localhost:${port}/docs`,
      'Bootstrap',
    );
  }
}

void bootstrap();
