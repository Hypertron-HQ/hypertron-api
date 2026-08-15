/**
 * PaymentsController — /v1/payments
 *
 * All routes require ApiKeyGuard (Bearer sk_test_/sk_live_).
 * Idempotency-Key header is required on POST only.
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

import { ApiKeyGuard } from '@/common/guards/api-key.guard';
import {
  CurrentMerchant,
  type MerchantContext,
} from '@/common/decorators/current-merchant.decorator';
import { PaymentsService } from './payments.service';
import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ListPaymentsDto } from './dto/list-payments.dto';
import {
  toPaymentListResponse,
  toPaymentEventListResponse,
} from './dto/payment-response.dto';

@ApiTags('Payments')
@ApiBearerAuth('ApiKey')
@Controller('v1/payments')
@UseGuards(ApiKeyGuard)
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ─── POST /v1/payments ──────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a payment' })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'Unique key (1–255 chars) to guarantee at-most-once creation',
    required: true,
  })
  @ApiResponse({ status: 201, description: 'Payment created' })
  @ApiResponse({
    status: 409,
    description: 'Idempotency key reused with different body',
  })
  async create(
    @Body() dto: CreatePaymentDto,
    @CurrentMerchant() merchant: MerchantContext,
    @Headers('idempotency-key') rawKey: string | undefined,
  ) {
    const key = this.idempotency.validateKey(rawKey);
    const result = await this.paymentsService.create(dto, merchant, key);
    return result.payment;
  }

  // ─── GET /v1/payments ───────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List payments (cursor-paginated)' })
  @ApiResponse({ status: 200, description: 'Paginated list of payments' })
  async findAll(
    @Query() query: ListPaymentsDto,
    @CurrentMerchant() merchant: MerchantContext,
  ) {
    const page = await this.paymentsService.findAll(query, merchant);
    return toPaymentListResponse(page.data, page.hasMore, page.nextCursor);
  }

  // ─── GET /v1/payments/:id ───────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve a payment' })
  @ApiParam({ name: 'id', description: 'Payment publicId (pay_...)' })
  @ApiResponse({ status: 200, description: 'Payment object' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentMerchant() merchant: MerchantContext,
  ) {
    return this.paymentsService.findOne(id, merchant);
  }

  // ─── POST /v1/payments/:id/cancel ──────────────────────────────────────────

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a payment' })
  @ApiParam({ name: 'id', description: 'Payment publicId (pay_...)' })
  @ApiResponse({ status: 200, description: 'Canceled payment' })
  @ApiResponse({
    status: 409,
    description: 'Payment cannot be canceled from current state',
  })
  async cancel(
    @Param('id') id: string,
    @CurrentMerchant() merchant: MerchantContext,
  ) {
    return this.paymentsService.cancel(id, merchant);
  }

  // ─── GET /v1/payments/:id/events ───────────────────────────────────────────

  @Get(':id/events')
  @ApiOperation({ summary: 'List events for a payment' })
  @ApiParam({ name: 'id', description: 'Payment publicId (pay_...)' })
  @ApiResponse({ status: 200, description: 'List of payment events' })
  async findEvents(
    @Param('id') id: string,
    @CurrentMerchant() merchant: MerchantContext,
  ) {
    const events = await this.paymentsService.findEvents(id, merchant);
    return toPaymentEventListResponse(events);
  }
}
