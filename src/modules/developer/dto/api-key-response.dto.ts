/**
 * Response DTOs for API key endpoints.
 *
 * SECURITY:
 *  - `secret_key` is ONLY present (non-null) in the create and rotate responses.
 *    All other responses return `secret_key: null`.
 *  - `secretHash` is NEVER included.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Expose, Transform } from 'class-transformer';

// ─── Single key response ──────────────────────────────────────────────────────

export class ApiKeyResponseDto {
  @ApiProperty({ example: 'key_01J...' })
  @Expose()
  id!: string;

  @ApiProperty({ example: 'api_key' })
  @Expose()
  object = 'api_key';

  @ApiProperty({ example: 'Production server' })
  @Expose()
  name!: string;

  @ApiProperty({ enum: ['test', 'live'], example: 'test' })
  @Expose()
  environment!: string;

  @ApiProperty({
    description: 'Key prefix for display (e.g. sk_test_)',
    example: 'sk_test_',
  })
  @Expose()
  key_prefix!: string;

  @ApiProperty({
    description: 'Last four characters of the raw key, for identification',
    example: 'abcd',
  })
  @Expose()
  last_four!: string;

  @ApiPropertyOptional({
    description:
      'Full raw key — only returned once at creation/rotation. Null on all other responses.',
    example: 'sk_test_ABC123...',
    nullable: true,
  })
  @Expose()
  secret_key!: string | null;

  @ApiProperty({ example: true })
  @Expose()
  active!: boolean;

  @ApiPropertyOptional({ example: '2024-01-01T00:00:00.000Z', nullable: true })
  @Expose()
  last_used_at!: string | null;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  @Expose()
  created_at!: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  @Expose()
  revoked_at!: string | null;
}

// ─── List response ────────────────────────────────────────────────────────────

export class ApiKeyListResponseDto {
  @ApiProperty({ example: 'list' })
  object = 'list';

  @ApiProperty({ type: [ApiKeyResponseDto] })
  data!: ApiKeyResponseDto[];
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

import type { ApiKey } from '@prisma/client';

/**
 * Maps a DB record to an ApiKeyResponseDto.
 *
 * @param record     The DB record (secretHash already stripped by service layer)
 * @param secretKey  The raw key to include — ONLY pass this on create/rotate.
 *                   Omit (or pass null) for all other responses.
 */
export function toApiKeyResponse(
  record: Omit<ApiKey, 'secretHash'>,
  secretKey: string | null = null,
): ApiKeyResponseDto {
  const dto = new ApiKeyResponseDto();
  dto.id = record.publicId;
  dto.name = record.name;
  dto.environment = record.environment;
  dto.key_prefix = record.keyPrefix;
  dto.last_four = record.lastFour;
  dto.secret_key = secretKey;
  dto.active = record.active;
  dto.last_used_at = record.lastUsedAt?.toISOString() ?? null;
  dto.created_at = record.createdAt.toISOString();
  dto.revoked_at = record.revokedAt?.toISOString() ?? null;
  return dto;
}

export function toApiKeyListResponse(
  records: Omit<ApiKey, 'secretHash'>[],
): ApiKeyListResponseDto {
  const dto = new ApiKeyListResponseDto();
  dto.data = records.map((r) => toApiKeyResponse(r, null));
  return dto;
}
