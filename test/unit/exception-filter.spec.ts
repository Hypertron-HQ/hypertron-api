/**
 * Unit tests — HypertronExceptionFilter + RequestIdInterceptor (Phase 8)
 */

import { CallHandler, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { of } from 'rxjs';

import { HypertronExceptionFilter } from '@/common/filters/hypertron-exception.filter';
import { RequestIdInterceptor } from '@/common/interceptors/request-id.interceptor';
import {
  InvalidRequestException,
  ResourceNotFoundException,
} from '@/common/exceptions/hypertron.exception';
import { REQUEST_ID_KEY } from '@/common/decorators/request-id.decorator';

type FakeResponse = {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
};

function mockHost(request: Record<string, unknown>, response: FakeResponse) {
  const res = {
    statusCode: 200,
    setHeader: (key: string, value: string) => {
      response.headers[key] = value;
    },
    getHeader: (key: string) => response.headers[key],
    status: (code: number) => {
      response.statusCode = code;
      return {
        json: (body: unknown) => {
          response.body = body;
        },
      };
    },
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext & { switchToHttp: () => unknown };
}

function emptyResponse(): FakeResponse {
  return { headers: {} };
}

describe('HypertronExceptionFilter', () => {
  const filter = new HypertronExceptionFilter();

  it('shapes HypertronException with request_id', () => {
    const response = emptyResponse();
    const request = { [REQUEST_ID_KEY]: 'req_test_12345678' };
    const host = mockHost(request, response);

    filter.catch(
      new ResourceNotFoundException('payment', 'pay_missing'),
      host as never,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: {
        type: 'resource_missing',
        code: 'resource_not_found',
        message: "No such payment: 'pay_missing'",
        request_id: 'req_test_12345678',
      },
    });
    expect(response.headers['X-Request-Id']).toBe('req_test_12345678');
  });

  it('shapes ValidationPipe-style BadRequestException with param', () => {
    const response = emptyResponse();
    const request = { [REQUEST_ID_KEY]: 'req_validation_1' };
    const host = mockHost(request, response);

    filter.catch(
      new HttpException(
        {
          statusCode: 400,
          message: ['amount must be a positive decimal string'],
          error: 'Bad Request',
        },
        HttpStatus.BAD_REQUEST,
      ),
      host as never,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'validation_error',
        message: 'amount must be a positive decimal string',
        param: 'amount',
        request_id: 'req_validation_1',
      },
    });
  });

  it('never leaks stack traces for unknown errors', () => {
    const response = emptyResponse();
    const request = { [REQUEST_ID_KEY]: 'req_boom' };
    const host = mockHost(request, response);

    filter.catch(
      new Error('Prisma P2025 Document not found in collection foobar'),
      host as never,
    );

    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('Prisma');
    expect(JSON.stringify(response.body)).not.toContain('foobar');
    expect(response.body).toEqual({
      error: {
        type: 'api_error',
        code: 'api_error',
        message: 'An unexpected error occurred. Please try again later.',
        request_id: 'req_boom',
      },
    });
  });

  it('maps ThrottlerException to rate_limit_error when catch-all handles it', () => {
    const response = emptyResponse();
    const request = { [REQUEST_ID_KEY]: 'req_rl' };
    const host = mockHost(request, response);

    filter.catch(new ThrottlerException(), host as never);

    expect(response.statusCode).toBe(429);
    expect(response.body).toMatchObject({
      error: {
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        request_id: 'req_rl',
      },
    });
  });

  it('preserves InvalidRequestException param', () => {
    const response = emptyResponse();
    const request = { [REQUEST_ID_KEY]: 'req_param' };
    const host = mockHost(request, response);

    filter.catch(
      new InvalidRequestException('invalid_amount', 'bad amount', 'amount'),
      host as never,
    );

    expect(response.body).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_amount',
        param: 'amount',
        request_id: 'req_param',
      },
    });
  });
});

describe('RequestIdInterceptor', () => {
  const interceptor = new RequestIdInterceptor();

  function run(headers: Record<string, string | string[] | undefined>) {
    const responseHeaders: Record<string, string> = {};
    const request: Record<string, unknown> = { headers };
    const response = {
      setHeader: (k: string, v: string) => {
        responseHeaders[k] = v;
      },
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;

    const next: CallHandler = { handle: () => of({ ok: true }) };
    let emitted: unknown;
    interceptor.intercept(context, next).subscribe((v) => {
      emitted = v;
    });

    return { request, responseHeaders, emitted };
  }

  it('generates a req_ id when none is supplied', () => {
    const { request, responseHeaders } = run({});
    expect(request[REQUEST_ID_KEY]).toMatch(/^req_/);
    expect(responseHeaders['X-Request-Id']).toBe(request[REQUEST_ID_KEY]);
  });

  it('reuses a valid client X-Request-Id', () => {
    const { request, responseHeaders } = run({
      'x-request-id': 'client-correlation-abc123',
    });
    expect(request[REQUEST_ID_KEY]).toBe('client-correlation-abc123');
    expect(responseHeaders['X-Request-Id']).toBe('client-correlation-abc123');
  });

  it('rejects malformed client ids and generates a new one', () => {
    const { request } = run({ 'x-request-id': 'bad id with spaces!!!' });
    expect(request[REQUEST_ID_KEY]).toMatch(/^req_/);
  });
});
