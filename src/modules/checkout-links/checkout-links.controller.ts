/**
 * Public checkout link resolution for /pay/cl_… (no API key).
 * Error shape matches core Collect GET so the hosted checkout can branch on `expired`.
 */

import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { HypertronThrottlerGuard } from '@/common/guards/hypertron-throttler.guard';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';

export class PublicCheckoutLinkResponseDto {
  @ApiProperty({ example: 'cl_01JABC123' })
  id!: string;

  @ApiProperty({ example: '25.00' })
  amount!: string;

  @ApiProperty({ example: 'USDC' })
  currency!: string;

  @ApiProperty({ example: 'hpl_abc123' })
  memo!: string;

  @ApiProperty({ example: 'G...' })
  destinationAddress!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  purpose!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  businessName!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  clientName!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  workflowStage!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  metadata!: string | null;

  @ApiProperty({ example: ['wallet', 'qr'] })
  paymentMethods!: string[];

  @ApiPropertyOptional({ nullable: true, type: String })
  expiresAt!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  paidAt!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  paymentTxHash!: string | null;
}

@ApiTags('Checkout Links')
@Controller('v1/checkout-links')
@UseGuards(HypertronThrottlerGuard)
@SkipThrottle({ 'payment-create': true, dashboard: true })
export class CheckoutLinksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':publicId')
  @ApiOperation({
    summary: 'Resolve a public checkout link',
    description:
      'Unauthenticated hosted-checkout lookup by publicId (cl_…). Used by /pay/cl_…',
  })
  @ApiParam({
    name: 'publicId',
    description: 'Checkout link publicId (cl_...)',
  })
  @ApiResponse({
    status: 200,
    description: 'Public checkout payload',
    type: PublicCheckoutLinkResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Checkout link not found' })
  @ApiResponse({ status: 410, description: 'Checkout link expired' })
  async getPublic(
    @Param('publicId') publicId: string,
  ): Promise<PublicCheckoutLinkResponseDto> {
    if (!publicId?.startsWith('cl_')) {
      throw new HttpException(
        { error: 'Checkout link not found' },
        HttpStatus.NOT_FOUND,
      );
    }

    const link = await this.prisma.checkoutLink.findUnique({
      where: { publicId },
    });
    if (!link) {
      throw new HttpException(
        { error: 'Checkout link not found' },
        HttpStatus.NOT_FOUND,
      );
    }

    if (
      link.expiresAt &&
      link.expiresAt.getTime() <= Date.now() &&
      !link.paidAt
    ) {
      throw new HttpException(
        { error: 'This payment link has expired.', expired: true },
        HttpStatus.GONE,
      );
    }

    return {
      id: link.publicId,
      amount: link.amount,
      currency: link.currency,
      memo: link.linkMemo,
      destinationAddress: link.destinationAddress,
      purpose: link.description,
      businessName: null,
      clientName: null,
      workflowStage: null,
      // Intentionally null — API checkout is never private settlement
      metadata: null,
      paymentMethods: ['wallet', 'qr'],
      expiresAt: link.expiresAt?.toISOString() ?? null,
      paidAt: link.paidAt?.toISOString() ?? null,
      paymentTxHash: link.paymentTxHash,
    };
  }
}
