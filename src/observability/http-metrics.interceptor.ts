/**
 * HttpMetricsInterceptor — records api_requests_total + duration histogram.
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { MetricsService } from './metrics.service';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const started = process.hrtime.bigint();

    const path = request.originalUrl || request.url || '';
    if (path.startsWith('/metrics') || path.startsWith('/health')) {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: () => this.record(request, response, started),
        error: () => this.record(request, response, started),
      }),
    );
  }

  private record(
    request: Request,
    response: Response,
    started: bigint,
  ): void {
    const elapsedNs = Number(process.hrtime.bigint() - started);
    const durationSeconds = elapsedNs / 1e9;
    this.metrics.recordApiRequest(
      request.method,
      request.route?.path
        ? `${request.baseUrl || ''}${request.route.path}`
        : request.originalUrl || request.url || 'unknown',
      response.statusCode || 500,
      durationSeconds,
    );
  }
}
