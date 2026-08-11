/**
 * @CurrentMerchant() parameter decorator.
 *
 * Extracts the resolved merchant context attached to the request by
 * `ApiKeyGuard`. Provides `{ businessId, environment, apiKeyId }`.
 *
 * Usage:
 *   @Get(':id')
 *   findOne(@Param('id') id: string, @CurrentMerchant() merchant: MerchantContext) {
 *     return this.service.findOne(id, merchant);
 *   }
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface MerchantContext {
  /** Core Business.id (cuid string) */
  businessId: string;
  /** Resolved from the API key — 'test' or 'live' */
  environment: 'test' | 'live';
  /** The ApiKey.publicId that authenticated this request */
  apiKeyId: string;
}

/** The property name used to store the merchant context on the request object. */
export const MERCHANT_CONTEXT_KEY = 'merchant';

export const CurrentMerchant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MerchantContext => {
    const request = ctx.switchToHttp().getRequest<Request & { merchant: MerchantContext }>();
    return request.merchant;
  },
);
