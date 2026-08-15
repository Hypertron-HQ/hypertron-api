/**
 * Shared OpenAPI error envelope (Payments_API_v1_Schema.md §10).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HypertronErrorBodyDto {
  @ApiProperty({
    example: 'invalid_request_error',
    enum: [
      'invalid_request_error',
      'authentication_error',
      'permission_error',
      'resource_missing',
      'idempotency_error',
      'invalid_state_transition',
      'unprocessable_entity',
      'rate_limit_error',
      'api_error',
      'service_unavailable',
    ],
  })
  type!: string;

  @ApiProperty({ example: 'invalid_amount' })
  code!: string;

  @ApiProperty({ example: 'amount must be a positive decimal string' })
  message!: string;

  @ApiPropertyOptional({
    example: 'amount',
    description: 'Present only for field-level validation errors',
  })
  param?: string;

  @ApiProperty({ example: 'req_01J...' })
  request_id!: string;
}

export class HypertronErrorResponseDto {
  @ApiProperty({ type: HypertronErrorBodyDto })
  error!: HypertronErrorBodyDto;
}
