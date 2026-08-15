/**
 * DeveloperCustomersController — /api/developer/customers
 *
 * Session-authenticated dashboard view of customers.
 * Read-only — customers are created implicitly via payment creation.
 *
 * Routes:
 *   GET /api/developer/customers       — cursor-paginated list
 *   GET /api/developer/customers/:id   — single customer by publicId
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { SessionGuard } from '@/common/guards/session.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import {
  CurrentUser,
  type SessionUser,
} from '@/common/decorators/current-user.decorator';
import { CustomersService } from '@/modules/customers/customers.service';
import { ListCustomersDto } from '@/modules/customers/dto/list-customers.dto';
import {
  toCustomerResponse,
  toCustomerListResponse,
} from '@/modules/customers/dto/customer-response.dto';

@ApiTags('Developer')
@ApiBearerAuth('SessionCookie')
@Controller('api/developer/customers')
@UseGuards(SessionGuard, RolesGuard)
export class DeveloperCustomersController {
  constructor(private readonly customersService: CustomersService) {}

  // ─── GET /api/developer/customers ─────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List customers (dashboard)' })
  @ApiResponse({ status: 200, description: 'Paginated list of customers' })
  async findAll(
    @Query() query: ListCustomersDto,
    @CurrentUser() user: SessionUser,
  ) {
    const page = await this.customersService.findAll(query, user.businessId);
    return toCustomerListResponse(page.data, page.hasMore, page.nextCursor);
  }

  // ─── GET /api/developer/customers/:id ────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve a customer (dashboard)' })
  @ApiParam({ name: 'id', description: 'Customer publicId (cus_...)' })
  @ApiResponse({ status: 200, description: 'Customer object' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    const customer = await this.customersService.findOne(id, user.businessId);
    return toCustomerResponse(customer);
  }
}
