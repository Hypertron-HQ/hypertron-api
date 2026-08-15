/**
 * PaymentsController — /v1/payments
 *
 * All routes require ApiKeyGuard (Bearer sk_test_/sk_live_).
 * Idempotency-Key header is required on POST only.
 * Rate limits: payment-create on POST; read on GET/cancel.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Headers,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { ApiKeyGuard } from '@/common/guards/api-key.guard';
import { HypertronThrottlerGuard } from '@/common/guards/hypertron-throttler.guard';
import {
  CurrentMerchant,
  type MerchantContext,
} from '@/common/decorators/current-merchant.decorator';
import { HypertronErrorResponseDto } from '@/common/dto/hypertron-error.dto';
import { PaymentsService } from './payments.service';
import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ListPaymentsDto } from './dto/list-payments.dto';
import {
  PaymentEventListResponseDto,
  PaymentListResponseDto,
  PaymentResponseDto,
  toPaymentListResponse,
  toPaymentEventListResponse,
} from './dto/payment-response.dto';

@ApiTags('Payments')
@ApiBearerAuth('ApiKey')
@Controller('v1/payments')
@UseGuards(ApiKeyGuard, HypertronThrottlerGuard)
@SkipThrottle({ dashboard: true })
@ApiResponse({
  status: 401,
  description: 'Invalid or missing API key',
  type: HypertronErrorResponseDto,
})
@ApiResponse({
  status: 429,
  description: 'Rate limit exceeded',
  type: HypertronErrorResponseDto,
})
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @SkipThrottle({ read: true })
  @ApiOperation({
    summary: 'Create a payment',
    description:
      'Creates a Payment and hosted checkout session. Requires Idempotency-Key. Returns the same payment on replay with the same key and body.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Unique key (1–255 chars) to guarantee at-most-once creation',
    required: true,
  })
  @ApiHeader({
    name: 'X-Request-Id',
    description: 'Optional client correlation id (echoed on the response)',
    required: false,
  })
  @ApiResponse({
    status: 201,
    description: 'Payment created',
    type: PaymentResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error',
    type: HypertronErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'Idempotency key reused with a different body',
    type: HypertronErrorResponseDto,
  })
  async create(
    @Body() dto: CreatePaymentDto,
    @CurrentMerchant() merchant: MerchantContext,
    @Headers('idempotency-key') rawKey: string | undefined,
  ): Promise<PaymentResponseDto> {
    const key = this.idempotency.validateKey(rawKey);
    const result = await this.paymentsService.create(dto, merchant, key);
    return result.payment;
  }

  @Get()
  @SkipThrottle({ 'payment-create': true })
  @ApiOperation({
    summary: 'List payments',
    description:
      'Cursor-paginated list of payments for the authenticated merchant/environment.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list',
    type: PaymentListResponseDto,
  })
  async findAll(
    @Query() query: ListPaymentsDto,
    @CurrentMerchant() merchant: MerchantContext,
  ): Promise<PaymentListResponseDto> {
    const page = await this.paymentsService.findAll(query, merchant);
    return toPaymentListResponse(page.data, page.hasMore, page.nextCursor);
  }

  @Get(':id')
  @SkipThrottle({ 'payment-create': true })
  @ApiOperation({ summary: 'Retrieve a payment' })
  @ApiParam({ name: 'id', description: 'Payment publicId (pay_...)' })
  @ApiResponse({
    status: 200,
    description: 'Payment object',
    type: PaymentResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Payment not found',
    type: HypertronErrorResponseDto,
  })
  async findOne(
    @Param('id') id: string,
    @CurrentMerchant() merchant: MerchantContext,
  ): Promise<PaymentResponseDto> {
    return this.paymentsService.findOne(id, merchant);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle({ 'payment-create': true })
  @ApiOperation({
    summary: 'Cancel a payment',
    description: 'Cancels a payment in created or pending status.',
  })
  @ApiParam({ name: 'id', description: 'Payment publicId (pay_...)' })
  @ApiResponse({
    status: 200,
    description: 'Canceled payment',
    type: PaymentResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Payment not found',
    type: HypertronErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'Invalid state transition',
    type: HypertronErrorResponseDto,
  })
  async cancel(
    @Param('id') id: string,
    @CurrentMerchant() merchant: MerchantContext,
  ): Promise<PaymentResponseDto> {
    return this.paymentsService.cancel(id, merchant);
  }

  @Get(':id/events')
  @SkipThrottle({ 'payment-create': true })
  @ApiOperation({ summary: 'List events for a payment' })
  @ApiParam({ name: 'id', description: 'Payment publicId (pay_...)' })
  @ApiResponse({
    status: 200,
    description: 'Immutable payment event log',
    type: PaymentEventListResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Payment not found',
    type: HypertronErrorResponseDto,
  })
  async findEvents(
    @Param('id') id: string,
    @CurrentMerchant() merchant: MerchantContext,
  ): Promise<PaymentEventListResponseDto> {
    const events = await this.paymentsService.findEvents(id, merchant);
    return toPaymentEventListResponse(events);
  }
}
