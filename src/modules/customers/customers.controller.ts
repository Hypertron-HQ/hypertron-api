/**
 * CustomersController — /v1/customers
 *
 * API-key authenticated. Returns merchant-scoped customer records.
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { CustomersService } from './customers.service';
import { ListCustomersDto } from './dto/list-customers.dto';
import {
  CustomerListResponseDto,
  CustomerResponseDto,
  toCustomerResponse,
  toCustomerListResponse,
} from './dto/customer-response.dto';

@ApiTags('Customers')
@ApiBearerAuth('ApiKey')
@Controller('v1/customers')
@UseGuards(ApiKeyGuard, HypertronThrottlerGuard)
@SkipThrottle({ 'payment-create': true, dashboard: true })
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
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @ApiOperation({
    summary: 'List customers',
    description: 'Cursor-paginated merchant-scoped customer list.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list',
    type: CustomerListResponseDto,
  })
  async findAll(
    @Query() query: ListCustomersDto,
    @CurrentMerchant() merchant: MerchantContext,
  ): Promise<CustomerListResponseDto> {
    const page = await this.customersService.findAll(
      query,
      merchant.businessId,
    );
    return toCustomerListResponse(page.data, page.hasMore, page.nextCursor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve a customer' })
  @ApiParam({ name: 'id', description: 'Customer publicId (cus_...)' })
  @ApiResponse({
    status: 200,
    description: 'Customer object',
    type: CustomerResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Customer not found',
    type: HypertronErrorResponseDto,
  })
  async findOne(
    @Param('id') id: string,
    @CurrentMerchant() merchant: MerchantContext,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customersService.findOne(
      id,
      merchant.businessId,
    );
    return toCustomerResponse(customer);
  }
}
