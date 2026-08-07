import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum ApiKeyEnvironment {
  TEST = 'test',
  LIVE = 'live',
}

export class CreateApiKeyDto {
  @ApiProperty({
    description: 'Human-readable label for this key',
    example: 'Production server',
    minLength: 1,
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: 'Key environment — test keys cannot access live payments',
    enum: ApiKeyEnvironment,
    example: 'test',
  })
  @IsEnum(ApiKeyEnvironment)
  environment!: ApiKeyEnvironment;
}
