import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export enum DeliveryStatusDto {
  pending = 'pending',
  delivered = 'delivered',
  failed = 'failed',
}

export class ListDeliveriesDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  @ApiPropertyOptional({
    description: 'Opaque cursor from a previous response next_cursor field',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ enum: DeliveryStatusDto })
  @IsOptional()
  @IsEnum(DeliveryStatusDto)
  status?: DeliveryStatusDto;
}
