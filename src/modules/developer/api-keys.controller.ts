/**
 * DeveloperApiKeysController — /api/developer/api-keys
 *
 * Session-authenticated dashboard control-plane for API key lifecycle.
 * All routes require a valid session token (SessionGuard).
 * Mutating routes (create, rotate, revoke) additionally require
 * Owner or Admin role (RolesGuard + @Roles).
 *
 * Routes (spec section 8.1):
 *   GET  /api/developer/api-keys                — list active keys
 *   POST /api/developer/api-keys                — create new key (raw key returned once)
 *   POST /api/developer/api-keys/:id/rotate     — atomic revoke+create
 *   POST /api/developer/api-keys/:id/revoke     — revoke immediately
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { SessionGuard } from '@/common/guards/session.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { HypertronThrottlerGuard } from '@/common/guards/hypertron-throttler.guard';
import { Roles } from '@/common/decorators/roles.decorator';
import {
  CurrentUser,
  type SessionUser,
} from '@/common/decorators/current-user.decorator';
import { ApiKeyService } from '@/modules/auth/api-key.service';
import { ResourceNotFoundException } from '@/common/exceptions/hypertron.exception';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import {
  ApiKeyResponseDto,
  ApiKeyListResponseDto,
  toApiKeyResponse,
  toApiKeyListResponse,
} from './dto/api-key-response.dto';
import { HypertronErrorResponseDto } from '@/common/dto/hypertron-error.dto';
import { SkipThrottle } from '@nestjs/throttler';

@ApiTags('Developer')
@ApiBearerAuth('SessionCookie')
@Controller('api/developer/api-keys')
@UseGuards(SessionGuard, RolesGuard, HypertronThrottlerGuard)
@SkipThrottle({ 'payment-create': true, read: true })
@ApiResponse({ status: 401, description: 'Missing or invalid session', type: HypertronErrorResponseDto })
@ApiResponse({ status: 403, description: 'Insufficient role', type: HypertronErrorResponseDto })
export class ApiKeysController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  // ─── GET /api/developer/api-keys ────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'List API keys',
    description:
      'Returns all active API keys for the Freighter-authenticated merchant ' +
      '(Business.id from ht_dashboard cookie). secret_key is always null in list responses.',
  })
  @ApiResponse({ status: 200, type: ApiKeyListResponseDto })
  @ApiResponse({ status: 401, type: HypertronErrorResponseDto })
  async list(@CurrentUser() user: SessionUser): Promise<ApiKeyListResponseDto> {
    const keys = await this.apiKeyService.listForBusiness(user.businessId);
    return toApiKeyListResponse(keys);
  }

  // ─── POST /api/developer/api-keys ───────────────────────────────────────────

  @Post()
  @Roles('owner', 'admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create API key',
    description:
      'Generates a new API key. The raw secret_key is returned exactly once ' +
      'and cannot be retrieved again. Store it securely immediately.',
  })
  @ApiResponse({ status: 201, type: ApiKeyResponseDto })
  @ApiResponse({ status: 400, type: HypertronErrorResponseDto })
  async create(
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: SessionUser,
  ): Promise<ApiKeyResponseDto> {
    const result = await this.apiKeyService.generate({
      businessId: user.businessId,
      name: dto.name,
      environment: dto.environment,
    });

    // secret_key included exactly once on create
    return toApiKeyResponse(result.record, result.rawKey);
  }

  // ─── POST /api/developer/api-keys/:id/rotate ────────────────────────────────

  @Post(':id/rotate')
  @Roles('owner', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate API key',
    description:
      'Immediately revokes the existing key and generates a replacement with ' +
      'the same environment. The new secret_key is returned exactly once.',
  })
  @ApiParam({ name: 'id', description: 'API key publicId (key_...)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  @ApiResponse({ status: 404, type: HypertronErrorResponseDto })
  async rotate(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<ApiKeyResponseDto> {
    // Fetch current name to preserve it on the rotated key
    const existing = await this.apiKeyService.listForBusiness(user.businessId);
    const current = existing.find((k) => k.publicId === id);
    if (!current) {
      throw new ResourceNotFoundException('api_key', id);
    }

    const result = await this.apiKeyService.rotate(id, user.businessId, current.name);
    if (!result) {
      throw new ResourceNotFoundException('api_key', id);
    }

    // secret_key included exactly once on rotate
    return toApiKeyResponse(result.record, result.rawKey);
  }

  // ─── POST /api/developer/api-keys/:id/revoke ────────────────────────────────

  @Post(':id/revoke')
  @Roles('owner', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke API key',
    description:
      'Immediately revokes the key. Any in-flight requests using this key ' +
      'will be rejected within seconds.',
  })
  @ApiParam({ name: 'id', description: 'API key publicId (key_...)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  @ApiResponse({ status: 404, type: HypertronErrorResponseDto })
  async revoke(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<ApiKeyResponseDto> {
    const revoked = await this.apiKeyService.revoke(id, user.businessId);
    if (!revoked) {
      throw new ResourceNotFoundException('api_key', id);
    }

    // secret_key is null — the revoked key should never be shown again
    return toApiKeyResponse(revoked, null);
  }
}
