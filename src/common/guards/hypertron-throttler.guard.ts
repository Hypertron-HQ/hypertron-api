/**
 * HypertronThrottlerGuard — keys rate limits by API key / dashboard business,
 * never by shared merchant IP alone (Plan §18.3).
 *
 * Attaches RateLimitMeta on the request so ThrottlerExceptionFilter can emit
 * Retry-After and X-RateLimit-* headers.
 */

import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerLimitDetail,
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';

import {
  MERCHANT_CONTEXT_KEY,
  type MerchantContext,
} from '@/common/decorators/current-merchant.decorator';
import {
  SESSION_USER_KEY,
  type SessionUser,
} from '@/common/decorators/current-user.decorator';
import {
  RATE_LIMIT_META_KEY,
  type RateLimitMeta,
} from '@/common/filters/throttler-exception.filter';

@Injectable()
export class HypertronThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as Request & {
      [MERCHANT_CONTEXT_KEY]?: MerchantContext;
      [SESSION_USER_KEY]?: SessionUser;
    };

    const merchant = request[MERCHANT_CONTEXT_KEY] ?? (request as { merchant?: MerchantContext }).merchant;
    if (merchant?.apiKeyId) {
      return `apikey:${merchant.apiKeyId}`;
    }

    const user =
      request[SESSION_USER_KEY] ?? (request as { user?: SessionUser }).user;
    if (user?.businessId) {
      return `dashboard:${user.businessId}`;
    }

    const ip =
      (typeof request.ip === 'string' && request.ip) ||
      request.socket?.remoteAddress ||
      'unknown';
    return `ip:${ip}`;
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<
      Request & { [RATE_LIMIT_META_KEY]?: RateLimitMeta }
    >();

    const ttlMs = throttlerLimitDetail.timeToExpire * 1000;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(throttlerLimitDetail.timeToExpire),
    );

    request[RATE_LIMIT_META_KEY] = {
      limit: throttlerLimitDetail.limit,
      remaining: 0,
      resetUnix: Math.floor((Date.now() + ttlMs) / 1000),
      retryAfterSeconds,
      group: throttlerLimitDetail.key || 'default',
    };

    return super.throwThrottlingException(context, throttlerLimitDetail);
  }
}
