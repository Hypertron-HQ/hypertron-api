import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';

import { AuthenticationException } from '@/common/exceptions/hypertron.exception';
import type { SecurityConfig } from '@/common/config/security.config';

@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected =
      this.config
        .get<SecurityConfig>('security')
        ?.internalServiceToken?.trim() ?? '';
    if (!expected) {
      throw new AuthenticationException(
        'server_misconfigured',
        'INTERNAL_SERVICE_TOKEN is not configured.',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided =
      (request.headers['x-internal-token'] as string | undefined)?.trim() ?? '';

    if (!safeEqual(provided, expected)) {
      throw new AuthenticationException(
        'invalid_internal_token',
        'Invalid internal service token.',
      );
    }
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
