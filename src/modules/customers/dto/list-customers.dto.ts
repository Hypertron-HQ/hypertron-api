import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListCustomersDto {
  @ApiPropertyOptional({
    description: 'Number of results to return (default 25, max 100)',
    minimum: 1,
    maximum: 100,
    default: 25,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  @ApiPropertyOptional({
    description:
      'Opaque cursor from a previous list response next_cursor field',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
