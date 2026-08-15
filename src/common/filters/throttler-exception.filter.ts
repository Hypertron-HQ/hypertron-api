/**
 * ThrottlerExceptionFilter — maps Nest ThrottlerException to the Hypertron
 * rate_limit_error contract and attaches Retry-After / X-RateLimit-* headers.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import {
  REQUEST_ID_HEADER,
  REQUEST_ID_KEY,
} from '@/common/decorators/request-id.decorator';
import { MetricsService } from '@/observability/metrics.service';

export const RATE_LIMIT_META_KEY = 'hypertronRateLimit';

export interface RateLimitMeta {
  limit: number;
  remaining: number;
  resetUnix: number;
  retryAfterSeconds: number;
  group: string;
}

@Catch(ThrottlerException)
export class ThrottlerExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ThrottlerExceptionFilter.name);

  constructor(
    @Optional()
    @Inject(MetricsService)
    private readonly metrics?: MetricsService,
  ) {}

  catch(exception: ThrottlerException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<
      Request & {
        [REQUEST_ID_KEY]?: string;
        id?: string;
        [RATE_LIMIT_META_KEY]?: RateLimitMeta;
      }
    >();

    const requestId =
      request[REQUEST_ID_KEY] ??
      (typeof request.id === 'string' ? request.id : undefined) ??
      (typeof request.headers[REQUEST_ID_HEADER] === 'string'
        ? request.headers[REQUEST_ID_HEADER]
        : 'req_unknown');

    const meta = request[RATE_LIMIT_META_KEY];
    const retryAfter = meta?.retryAfterSeconds ?? 30;
    const limit = meta?.limit ?? 0;
    const remaining = meta?.remaining ?? 0;
    const reset = meta?.resetUnix ?? Math.floor(Date.now() / 1000) + retryAfter;

    response.setHeader('Retry-After', String(retryAfter));
    response.setHeader('X-RateLimit-Limit', String(limit));
    response.setHeader('X-RateLimit-Remaining', String(remaining));
    response.setHeader('X-RateLimit-Reset', String(reset));
    response.setHeader('X-Request-Id', requestId);

    this.metrics?.recordRateLimitHit(meta?.group ?? 'unknown');

    this.logger.warn(
      {
        requestId,
        group: meta?.group ?? 'unknown',
        path: request.url,
      },
      'Rate limit exceeded',
    );

    response.status(HttpStatus.TOO_MANY_REQUESTS).json({
      error: {
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        message:
          exception.message ||
          'Too many requests. Please retry after a short delay.',
        request_id: requestId,
      },
    });
  }
}
