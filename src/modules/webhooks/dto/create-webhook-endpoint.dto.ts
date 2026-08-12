import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { WEBHOOK_EVENT_TYPES } from '../webhooks.constants';

export enum WebhookEnvironmentDto {
  test = 'test',
  live = 'live',
}

export class CreateWebhookEndpointDto {
  @ApiProperty({
    description:
      'HTTPS URL that receives signed events. Plain http is allowed only for localhost in the test environment.',
    example: 'https://merchant.example.com/hypertron/webhook',
  })
  @IsString()
  @MaxLength(2048)
  url!: string;

  @ApiProperty({ enum: WebhookEnvironmentDto, example: 'test' })
  @IsEnum(WebhookEnvironmentDto)
  environment!: WebhookEnvironmentDto;

  @ApiProperty({
    description: 'Event types this endpoint subscribes to',
    example: ['payment.completed', 'payment.failed'],
    isArray: true,
    enum: WEBHOOK_EVENT_TYPES,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsString({ each: true })
  events!: string[];

  @ApiPropertyOptional({ example: 'Production order updates', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
