/**
 * Public checkout link resolution for /pay/cl_… (no API key).
 */

import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PrismaService } from '@/infrastructure/prisma/prisma.service';

@ApiTags('Checkout Links')
@Controller('v1/checkout-links')
export class CheckoutLinksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':publicId')
  async getPublic(@Param('publicId') publicId: string) {
    if (!publicId?.startsWith('cl_')) {
      throw new NotFoundException('Checkout link not found');
    }

    const link = await this.prisma.checkoutLink.findUnique({
      where: { publicId },
    });
    if (!link) {
      throw new NotFoundException('Checkout link not found');
    }

    if (
      link.expiresAt &&
      link.expiresAt.getTime() <= Date.now() &&
      !link.paidAt
    ) {
      // Shape matches Collect public GET so FE can branch on `expired`
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
