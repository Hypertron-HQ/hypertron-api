/**
 * HypertronExceptionFilter — shapes every error into the Payments API contract:
 *
 *   { error: { type, code, message, param?, request_id } }
 *
 * Never leaks stack traces, Prisma internals, or secret material.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import {
  HypertronException,
  type HypertronErrorPayload,
} from '@/common/exceptions/hypertron.exception';
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_KEY,
} from '@/common/decorators/request-id.decorator';
import {
  RATE_LIMIT_META_KEY,
  type RateLimitMeta,
} from '@/common/filters/throttler-exception.filter';

@Catch()
export class HypertronExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HypertronExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<
      Request & {
        [REQUEST_ID_KEY]?: string;
        id?: string;
        [RATE_LIMIT_META_KEY]?: RateLimitMeta;
      }
    >();

    const requestId = resolveRequestId(request, response);

    if (exception instanceof ThrottlerException) {
      const meta = request[RATE_LIMIT_META_KEY];
      const retryAfter = meta?.retryAfterSeconds ?? 30;
      response.setHeader('Retry-After', String(retryAfter));
      response.setHeader('X-RateLimit-Limit', String(meta?.limit ?? 0));
      response.setHeader('X-RateLimit-Remaining', String(meta?.remaining ?? 0));
      response.setHeader(
        'X-RateLimit-Reset',
        String(meta?.resetUnix ?? Math.floor(Date.now() / 1000) + retryAfter),
      );
      this.write(
        response,
        HttpStatus.TOO_MANY_REQUESTS,
        {
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
          message: 'Too many requests. Please retry after a short delay.',
          request_id: requestId,
        },
        requestId,
      );
      return;
    }

    if (exception instanceof HypertronException) {
      const payload: HypertronErrorPayload = {
        ...exception.payload,
        request_id: requestId,
      };
      this.write(response, exception.getStatus(), payload, requestId);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const collectBody = collectStyleBody(body);
      if (collectBody) {
        if (!response.getHeader('X-Request-Id')) {
          response.setHeader('X-Request-Id', requestId);
        }
        response.status(status).json(collectBody);
        return;
      }
      const shaped = shapeHttpException(status, body, requestId);
      if (status >= 500) {
        this.logger.error(
          { err: exception.message, requestId, status },
          'Unhandled HttpException',
        );
      }
      this.write(response, status, shaped, requestId);
      return;
    }

    if (isPrismaUniqueViolation(exception)) {
      this.write(
        response,
        HttpStatus.CONFLICT,
        {
          type: 'idempotency_error',
          code: 'conflict',
          message: 'A conflicting resource already exists.',
          request_id: requestId,
        },
        requestId,
      );
      return;
    }

    const message =
      exception instanceof Error ? exception.message : 'Unknown error';
    this.logger.error({ err: message, requestId }, 'Unhandled exception');

    this.write(
      response,
      HttpStatus.INTERNAL_SERVER_ERROR,
      {
        type: 'api_error',
        code: 'api_error',
        message: 'An unexpected error occurred. Please try again later.',
        request_id: requestId,
      },
      requestId,
    );
  }

  private write(
    response: Response,
    status: number,
    payload: HypertronErrorPayload,
    requestId: string,
  ): void {
    if (!response.getHeader('X-Request-Id')) {
      response.setHeader('X-Request-Id', requestId);
    }
    response.status(status).json({ error: payload });
  }
}

function resolveRequestId(
  request: Request & { [REQUEST_ID_KEY]?: string; id?: string },
  response: Response,
): string {
  const fromRequest =
    request[REQUEST_ID_KEY] ??
    (typeof request.id === 'string' ? request.id : undefined);
  if (fromRequest) return fromRequest;

  const header = request.headers[REQUEST_ID_HEADER];
  if (typeof header === 'string' && header.length > 0) return header;

  const existing = response.getHeader('X-Request-Id');
  if (typeof existing === 'string' && existing.length > 0) return existing;

  return 'req_unknown';
}

/** Hosted-checkout / Collect public errors: `{ error: string, expired?: boolean }`. */
function collectStyleBody(
  body: string | object,
): { error: string; expired?: boolean } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.error !== 'string') return null;
  if ('statusCode' in record || 'message' in record) return null;
  return record.expired === true
    ? { error: record.error, expired: true }
    : { error: record.error };
}

function shapeHttpException(
  status: number,
  body: string | object,
  requestId: string,
): HypertronErrorPayload {
  // Nest ValidationPipe / BadRequestException often returns:
  // { statusCode, message: string[] | string, error: string }
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;

    if (record.error && typeof record.error === 'object') {
      const nested = record.error as HypertronErrorPayload;
      return { ...nested, request_id: requestId };
    }

    const messages = record.message;
    if (
      Array.isArray(messages) &&
      messages.every((m) => typeof m === 'string')
    ) {
      const first = messages[0];
      const param = extractValidationParam(first);
      return {
        type: 'invalid_request_error',
        code: 'validation_error',
        message: first,
        ...(param ? { param } : {}),
        request_id: requestId,
      };
    }

    if (typeof messages === 'string') {
      return {
        type: statusType(status),
        code: statusCode(status),
        message: messages,
        request_id: requestId,
      };
    }
  }

  if (typeof body === 'string') {
    return {
      type: statusType(status),
      code: statusCode(status),
      message: body,
      request_id: requestId,
    };
  }

  return {
    type: statusType(status),
    code: statusCode(status),
    message: 'Request failed.',
    request_id: requestId,
  };
}

function extractValidationParam(message: string): string | undefined {
  // class-validator: "amount must be ..." / "url must be ..."
  const match = /^([a-zA-Z0-9_]+) /.exec(message);
  return match?.[1];
}

function statusType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'resource_missing';
  if (status === 409) return 'idempotency_error';
  if (status === 422) return 'unprocessable_entity';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

function statusCode(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'resource_not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'unprocessable_entity';
  if (status === 429) return 'rate_limit_exceeded';
  if (status >= 500) return 'api_error';
  return 'invalid_request';
}

function isPrismaUniqueViolation(exception: unknown): boolean {
  if (!exception || typeof exception !== 'object') return false;
  return (exception as { code?: string }).code === 'P2002';
}
