import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';
import {
  isValidPaymentAmount,
  type SupportedCurrency,
} from '@/common/utils/amount.util';

// ─── Custom validator: decimal amount + currency precision ────────────────────

@ValidatorConstraint({ name: 'IsPaymentAmount', async: false })
class IsPaymentAmountConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as CreatePaymentDto;
    if (typeof value !== 'string') return false;
    const currency = dto.currency as SupportedCurrency;
    if (!currency) return false;
    return isValidPaymentAmount(value, currency);
  }

  defaultMessage(): string {
    return 'amount must be a positive decimal string with valid precision for the given currency';
  }
}

// ─── Supported currencies ─────────────────────────────────────────────────────

export enum PaymentCurrencyDto {
  USDC = 'USDC',
  EURC = 'EURC',
  XLM  = 'XLM',
}

// ─── DTO ──────────────────────────────────────────────────────────────────────

export class CreatePaymentDto {
  @ApiProperty({
    description: 'Payment amount as a positive decimal string (no scientific notation)',
    example: '10.50',
  })
  @IsString()
  @IsNotEmpty()
  @Validate(IsPaymentAmountConstraint)
  amount!: string;

  @ApiProperty({
    description: 'Currency code',
    enum: PaymentCurrencyDto,
    example: 'USDC',
  })
  @IsEnum(PaymentCurrencyDto)
  currency!: PaymentCurrencyDto;

  @ApiPropertyOptional({
    description: 'Human-readable description shown on the checkout page',
    example: 'Order #1234',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Customer email — used to upsert the merchant-scoped customer record',
    example: 'alice@example.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customer_email?: string;

  @ApiPropertyOptional({
    description: 'Customer display name',
    example: 'Alice Smith',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customer_name?: string;

  @ApiPropertyOptional({
    description: 'Key-value metadata (max 50 pairs, values max 500 chars)',
    example: { order_id: 'ord_123' },
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  metadata?: Record<string, string>;
}
