import './tracing';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';

import { AppModule } from './app.module';
import type { AppConfig } from './common/config/app.config';
import { buildOpenApiConfig } from './common/openapi/openapi.config';

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
          ? false // block all cross-origin in prod if not configured
          : true, // allow all in local dev
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Internal-Token',
      'X-Service-Key',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    credentials: true,
  });

  // ── Global validation pipe ─────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip undeclared properties
      forbidNonWhitelisted: true, // throw 400 for unknown properties
      transform: true, // coerce query param types
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
  // Always enable Swagger for comprehensive API documentation
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list', // Show all endpoints collapsed by default
      filter: true, // Enable search/filter
      showRequestHeaders: true, // Show request headers in responses
      tryItOutEnabled: true, // Enable "Try it out" by default
    },
    customSiteTitle: 'Hypertron API Documentation',
    customfavIcon: 'https://hypertron.xyz/favicon.ico',
    customCss: '.swagger-ui .topbar { display: none }', // Hide Swagger UI banner
  });

  // Also log when Swagger is available
  if (appConfig.swaggerEnabled || appConfig.nodeEnv !== 'production' || true) {
    logger.log(
      `📚 OpenAPI docs available at http://localhost:${appConfig.port}/docs`,
      'Bootstrap',
    );
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  app.enableShutdownHooks();

  // ── Start server ──────────────────────────────────────────────────────────
  const port = appConfig.port;
  await app.listen(port, '0.0.0.0');

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
