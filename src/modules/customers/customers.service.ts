/**
 * CustomersService — read-side of the Customer resource.
 *
 * Customers are created implicitly during payment creation (upsert-by-email).
 * This service exposes read-only access for the /v1/customers endpoints and
 * the developer dashboard.
 */

import { Injectable } from '@nestjs/common';
import type { Customer } from '@prisma/client';
import { CustomersRepository } from './customers.repository';
import { ResourceNotFoundException } from '@/common/exceptions/hypertron.exception';
import { decodeCursor } from '@/modules/payments/payments.repository';
import type { ListCustomersDto } from './dto/list-customers.dto';

export interface CustomerPage {
  data: Customer[];
  hasMore: boolean;
  nextCursor: string | null;
}

@Injectable()
export class CustomersService {
  constructor(private readonly repo: CustomersRepository) {}

  /** Retrieves a single customer by publicId, scoped to businessId. */
  async findOne(publicId: string, businessId: string): Promise<Customer> {
    const customer = await this.repo.findByPublicId(publicId, businessId);
    if (!customer) {
      throw new ResourceNotFoundException('customer', publicId);
    }
    return customer;
  }

  /** Cursor-paginated list of customers for a merchant. */
  async findAll(
    query: ListCustomersDto,
    businessId: string,
  ): Promise<CustomerPage> {
    const limit = query.limit ?? 25;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    // Fetch limit+1 to determine has_more
    const rows = await this.repo.findAll({
      businessId,
      limit: limit + 1,
      cursor,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ t: last.createdAt.toISOString(), id: last.id }),
            'utf8',
          ).toString('base64url')
        : null;

    return { data, hasMore, nextCursor };
  }
}
