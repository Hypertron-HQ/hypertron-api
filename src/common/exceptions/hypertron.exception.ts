/**
 * Exception hierarchy for the HyperTone Payments API.
 *
 * All exceptions carry a structured payload matching the error contract:
 *   { type, code, message, param?, requestId? }
 *
 * Callers never construct raw HttpException — always use a subclass here so
 * that HypertronExceptionFilter can shape the response consistently.
 */

import { HttpException, HttpStatus } from '@nestjs/common';

// ─── Base payload ──────────────────────────────────────────────────────────────

export interface HypertronErrorPayload {
  type: string;
  code: string;
  message: string;
  /** Field-level param; only present for validation errors */
  param?: string;
  /** Attached by the exception filter after reading from request context */
  request_id?: string;
}

// ─── Base class ────────────────────────────────────────────────────────────────

export class HypertronException extends HttpException {
  constructor(
    public readonly payload: HypertronErrorPayload,
    status: HttpStatus,
  ) {
    super({ error: payload }, status);
  }
}

// ─── 400 invalid_request_error ─────────────────────────────────────────────────

export class InvalidRequestException extends HypertronException {
  constructor(code: string, message: string, param?: string) {
    super(
      { type: 'invalid_request_error', code, message, ...(param ? { param } : {}) },
      HttpStatus.BAD_REQUEST,
    );
  }
}

// ─── 401 authentication_error ──────────────────────────────────────────────────

export class AuthenticationException extends HypertronException {
  constructor(
    code = 'invalid_api_key',
    message = 'No valid API key provided.',
  ) {
    super({ type: 'authentication_error', code, message }, HttpStatus.UNAUTHORIZED);
  }
}

// ─── 403 permission_error ──────────────────────────────────────────────────────

export class PermissionException extends HypertronException {
  constructor(
    code = 'permission_denied',
    message = 'You do not have permission to perform this action.',
  ) {
    super({ type: 'permission_error', code, message }, HttpStatus.FORBIDDEN);
  }
}

// ─── 404 resource_missing ──────────────────────────────────────────────────────

export class ResourceNotFoundException extends HypertronException {
  constructor(resource: string, id?: string) {
    const message = id
      ? `No such ${resource}: '${id}'`
      : `${resource} not found.`;
    super(
      { type: 'resource_missing', code: 'resource_not_found', message },
      HttpStatus.NOT_FOUND,
    );
  }
}

// ─── 409 idempotency_error ──────────────────────────────────────────────────────

export class IdempotencyException extends HypertronException {
  constructor(
    code = 'idempotency_error',
    message = 'The Idempotency-Key was already used with a different request body.',
  ) {
    super({ type: 'idempotency_error', code, message }, HttpStatus.CONFLICT);
  }
}

// ─── 409 invalid_state_transition ─────────────────────────────────────────────

export class StateTransitionException extends HypertronException {
  constructor(fromState: string, toState: string, resource = 'payment') {
    super(
      {
        type: 'invalid_state_transition',
        code: 'invalid_state_transition',
        message: `Cannot transition ${resource} from '${fromState}' to '${toState}'.`,
      },
      HttpStatus.CONFLICT,
    );
  }
}

// ─── 422 unprocessable_entity ─────────────────────────────────────────────────

export class UnprocessableEntityException extends HypertronException {
  constructor(code: string, message: string) {
    super(
      { type: 'unprocessable_entity', code, message },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

// ─── 429 rate_limit_error ─────────────────────────────────────────────────────

export class RateLimitException extends HypertronException {
  constructor(
    message = 'Too many requests. Please retry after a short delay.',
  ) {
    super(
      { type: 'rate_limit_error', code: 'rate_limit_exceeded', message },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

// ─── 500 api_error ────────────────────────────────────────────────────────────

export class ApiException extends HypertronException {
  constructor(
    code = 'api_error',
    message = 'An unexpected error occurred. Please try again later.',
  ) {
    super({ type: 'api_error', code, message }, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

// ─── 503 service_unavailable ──────────────────────────────────────────────────

export class ServiceUnavailableException extends HypertronException {
  constructor(
    service = 'service',
    message = 'The service is temporarily unavailable. Please try again later.',
  ) {
    super(
      { type: 'service_unavailable', code: `${service}_unavailable`, message },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
