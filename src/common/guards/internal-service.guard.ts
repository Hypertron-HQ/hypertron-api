import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';

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
      throw new UnauthorizedException('INTERNAL_SERVICE_TOKEN not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided =
      (request.headers['x-internal-token'] as string | undefined)?.trim() ?? '';

    if (!safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid internal service token');
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
