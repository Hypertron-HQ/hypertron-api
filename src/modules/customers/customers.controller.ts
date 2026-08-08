/**
 * CustomersController — /v1/customers
 *
 * API-key authenticated. Returns merchant-scoped customer records.
 *
 * Routes:
 *   GET /v1/customers       — cursor-paginated list
 *   GET /v1/customers/:id   — single customer by publicId
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { CustomersService } from './customers.service';
import { ListCustomersDto } from './dto/list-customers.dto';
import {
  toCustomerResponse,
  toCustomerListResponse,
} from './dto/customer-response.dto';

@ApiTags('Customers')
@ApiBearerAuth('ApiKey')
@Controller('v1/customers')
@UseGuards(ApiKeyGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  // ─── GET /v1/customers ──────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List customers (cursor-paginated)' })
  @ApiResponse({ status: 200, description: 'Paginated list of customers' })
  async findAll(
    @Query() query: ListCustomersDto,
    @CurrentMerchant() merchant: MerchantContext,
  ) {
    const page = await this.customersService.findAll(query, merchant.businessId);
    return toCustomerListResponse(page.data, page.hasMore, page.nextCursor);
  }

  // ─── GET /v1/customers/:id ─────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve a customer' })
  @ApiParam({ name: 'id', description: 'Customer publicId (cus_...)' })
  @ApiResponse({ status: 200, description: 'Customer object' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentMerchant() merchant: MerchantContext,
  ) {
    const customer = await this.customersService.findOne(id, merchant.businessId);
    return toCustomerResponse(customer);
  }
}
