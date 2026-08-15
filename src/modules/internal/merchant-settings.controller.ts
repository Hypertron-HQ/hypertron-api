/**
 * Internal MerchantSettings upsert — called by hypertron-core-backend.
 * Auth: X-Internal-Token header matching INTERNAL_SERVICE_TOKEN.
 */

import { Body, Controller, HttpCode, Put, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { InternalServiceGuard } from '@/common/guards/internal-service.guard';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';

export class UpsertMerchantSettingsDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(128)
  businessId!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(128)
  walletAddress!: string;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsOptional()
  @IsString()
  @MaxLength(128)
  receiveAddress?: string | null;
}

@ApiExcludeController()
@Controller('internal/merchant-settings')
@UseGuards(InternalServiceGuard)
export class MerchantSettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Put()
  @HttpCode(200)
  async upsert(@Body() body: UpsertMerchantSettingsDto) {
    const businessId = String(body.businessId ?? '').trim();
    const walletAddress = String(body.walletAddress ?? '').trim();
    if (!businessId || !walletAddress) {
      return { ok: false, error: 'businessId and walletAddress required' };
    }

    const receiveAddress =
      body.receiveAddress === undefined || body.receiveAddress === null
        ? null
        : String(body.receiveAddress).trim() || null;

    const byBusiness = await this.prisma.merchantSettings.findUnique({
      where: { businessId },
    });

    if (byBusiness) {
      const updated = await this.prisma.merchantSettings.update({
        where: { businessId },
        data: { walletAddress, receiveAddress },
      });
      return {
        ok: true,
        businessId: updated.businessId,
        walletAddress: updated.walletAddress,
        receiveAddress: updated.receiveAddress,
      };
    }

    // walletAddress unique — if another row has this wallet, update that row's businessId
    const byWallet = await this.prisma.merchantSettings.findUnique({
      where: { walletAddress },
    });
    if (byWallet) {
      const updated = await this.prisma.merchantSettings.update({
        where: { walletAddress },
        data: { businessId, receiveAddress },
      });
      return {
        ok: true,
        businessId: updated.businessId,
        walletAddress: updated.walletAddress,
        receiveAddress: updated.receiveAddress,
      };
    }

    const created = await this.prisma.merchantSettings.create({
      data: { businessId, walletAddress, receiveAddress },
    });
    return {
      ok: true,
      businessId: created.businessId,
      walletAddress: created.walletAddress,
      receiveAddress: created.receiveAddress,
    };
  }
}
