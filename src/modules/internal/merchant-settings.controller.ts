/**
 * Internal MerchantSettings upsert — called by hypertron-core-backend.
 * Auth: X-Internal-Token header matching INTERNAL_SERVICE_TOKEN.
 */

import { Body, Controller, HttpCode, Put, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiProperty,
} from '@nestjs/swagger';
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
  @ApiProperty({
    description: 'Business ID from Core Backend',
    example: 'biz_12345',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(128)
  businessId!: string;

  @ApiProperty({
    description: 'Stellar wallet address of the merchant',
    example: 'GABC123...',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(128)
  walletAddress!: string;

  @ApiProperty({
    description: 'Stellar receive address for payments (optional)',
    example: 'GXYZ789...',
    required: false,
    nullable: true,
  })
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsOptional()
  @IsString()
  @MaxLength(128)
  receiveAddress?: string | null;
}

@ApiTags('Internal')
@ApiBearerAuth('InternalToken')
@Controller('internal/merchant-settings')
@UseGuards(InternalServiceGuard)
@ApiResponse({
  status: 401,
  description: 'Missing or invalid X-Internal-Token',
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', example: false },
      error: { type: 'string', example: 'Unauthorized' },
    },
  },
})
export class MerchantSettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync merchant settings',
    description:
      'Internal endpoint called by Core Backend to sync merchant settings. ' +
      'Requires X-Internal-Token header. Upserts merchant settings based on businessId or walletAddress.',
  })
  @ApiResponse({
    status: 200,
    description: 'Settings synchronized successfully',
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', example: true },
        businessId: { type: 'string', example: 'biz_12345' },
        walletAddress: { type: 'string', example: 'GABC123...' },
        receiveAddress: { type: 'string', example: 'GXYZ789...', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request body',
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', example: false },
        error: { type: 'string', example: 'businessId and walletAddress required' },
      },
    },
  })
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
