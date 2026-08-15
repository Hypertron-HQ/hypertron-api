import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { WEBHOOK_EVENT_TYPES } from '../webhooks.constants';

/** Environment is immutable — create a separate endpoint for the other mode. */
export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({ example: 'https://merchant.example.com/hooks/v2' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: WEBHOOK_EVENT_TYPES,
    example: ['payment.completed'],
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsString({ each: true })
  events?: string[];

  @ApiPropertyOptional({ example: 'Production order updates', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Set false to stop delivering to this endpoint',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
