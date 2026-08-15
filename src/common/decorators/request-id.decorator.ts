/**
 * @RequestId() — extracts the request id attached by RequestIdInterceptor.
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
export const REQUEST_ID_KEY = 'requestId';

export const RequestId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { [REQUEST_ID_KEY]?: string; id?: string }>();
    return (
      request[REQUEST_ID_KEY] ??
      (typeof request.id === 'string' ? request.id : '') ??
      ''
    );
  },
);
