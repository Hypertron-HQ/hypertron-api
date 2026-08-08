/**
 * CustomersRepository — data access for Customer documents.
 *
 * Key operation: upsert by (businessId, email) — used during payment creation
 * to resolve or create the merchant-scoped customer identity.
 */

import { Injectable } from '@nestjs/common';
import type { Customer } from '@prisma/client';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { generateId, PREFIXES } from '@/common/utils/id-generator';

@Injectable()
export class CustomersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upserts a customer by (businessId, email).
   * Email is normalised to lowercase before lookup and storage.
   * If no email is provided, a new anonymous customer is created each time.
   */
  async upsertByEmail(params: {
    businessId: string;
    email?: string;
    name?: string;
    metadata?: Record<string, string>;
  }): Promise<Customer> {
    const { businessId, email, name, metadata } = params;
    const normalisedEmail = email?.toLowerCase().trim() ?? null;

    if (normalisedEmail) {
      // Try to find existing customer first
      const existing = await this.prisma.customer.findFirst({
        where: { businessId, email: normalisedEmail },
      });

      if (existing) {
        return existing;
      }
    }

    // Create new customer
    const publicId = generateId(PREFIXES.CUSTOMER);
    return this.prisma.customer.create({
      data: {
        publicId,
        businessId,
        email: normalisedEmail,
        name: name ?? null,
        metadata: (metadata as object) ?? {},
      },
    });
  }

  /** Finds a customer by their publicId, scoped to businessId. */
  async findByPublicId(
    publicId: string,
    businessId: string,
  ): Promise<Customer | null> {
    return this.prisma.customer.findFirst({
      where: { publicId, businessId },
    });
  }

  /** Paginated list of customers for a business. */
  async findAll(params: {
    businessId: string;
    limit: number;
    cursor?: { createdAt: Date; id: string } | null;
  }): Promise<Customer[]> {
    const { businessId, limit, cursor } = params;

    return this.prisma.customer.findMany({
      where: {
        businessId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }
}
