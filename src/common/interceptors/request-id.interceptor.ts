/**
 * RequestIdInterceptor — ensures every response carries X-Request-Id.
 *
 * Prefer a client-supplied X-Request-Id when present and well-formed;
 * otherwise generate a `req_<ULID>`. The id is also attached to the request
 * for exception filters and structured logs.
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';

import { generateRequestId } from '@/common/utils/crypto.util';
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_KEY,
} from '@/common/decorators/request-id.decorator';

const CLIENT_ID_MAX = 128;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._\-:/]+$/;

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<
      Request & { [REQUEST_ID_KEY]?: string; id?: string }
    >();
    const response = http.getResponse<Response>();

    const incoming = request.headers[REQUEST_ID_HEADER];
    const raw = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = isValidClientRequestId(raw) ? raw : generateRequestId();

    request[REQUEST_ID_KEY] = requestId;
    request.id = requestId;
    response.setHeader('X-Request-Id', requestId);

    return next.handle();
  }
}

function isValidClientRequestId(value: string | undefined): value is string {
  if (!value) return false;
  if (value.length < 8 || value.length > CLIENT_ID_MAX) return false;
  return CLIENT_ID_PATTERN.test(value);
}
