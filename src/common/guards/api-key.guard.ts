/**
 * ApiKeyGuard — authenticates all /v1/* routes via Bearer API key.
 *
 * Implementation follows spec section 9.3:
 *  1. Extract Authorization: Bearer <key> header — 401 if missing
 *  2. Reject keys passed in query params or body
 *  3. Never log the raw key — log only keyPrefix and lastFour
 *  4. Attach { businessId, environment, apiKeyId } to request.merchant
 *  5. Fast path: prefix index scan → bcrypt compare only on candidates
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';

import { ApiKeyService } from '@/modules/auth/api-key.service';
import { AuthenticationException } from '@/common/exceptions/hypertron.exception';
import {
  MERCHANT_CONTEXT_KEY,
  type MerchantContext,
} from '@/common/decorators/current-merchant.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & { [MERCHANT_CONTEXT_KEY]: MerchantContext }
    >();

    const rawKey = this.extractBearerToken(request);

    if (!rawKey) {
      throw new AuthenticationException(
        'missing_api_key',
        'No API key provided. Include your key in the Authorization header as: Bearer sk_<env>_<token>',
      );
    }

    const result = await this.apiKeyService.verify(rawKey);

    if (!result) {
      // Log last four only — never the full key
      const lastFour = rawKey.length >= 4 ? rawKey.slice(-4) : '????';
      this.logger.warn({ lastFour }, 'API key authentication failed');
      throw new AuthenticationException(
        'invalid_api_key',
        'The API key provided is invalid or has been revoked.',
      );
    }

    // Attach merchant context to the request
    request[MERCHANT_CONTEXT_KEY] = {
      businessId: result.record.businessId,
      environment: result.record.environment as 'test' | 'live',
      apiKeyId: result.record.publicId,
    };

    return true;
  }

  /**
   * Extracts the raw Bearer token from the Authorization header.
   *
   * Returns null for:
   *  - Missing header
   *  - Non-Bearer schemes
   *  - Empty token
   *  - Keys found in query params instead (rejected per spec)
   */
  private extractBearerToken(request: Request): string | null {
    const authHeader = request.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') return null;

    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token?.trim()) return null;

    return token.trim();
  }
}
