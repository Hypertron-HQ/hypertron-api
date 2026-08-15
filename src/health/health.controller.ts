import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { CoreBackendClient } from '../infrastructure/core-backend/core-backend.client';
import { redisDisabled } from '../common/config/queue.config';

@ApiTags('Health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly coreBackend: CoreBackendClient,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Health check',
    description:
      'Returns process health. Database check is informational — a degraded DB does not cause a 503.',
  })
  @ApiResponse({
    status: 200,
    description: 'Process is healthy (database may report degraded)',
  })
  @ApiResponse({ status: 503, description: 'Service unavailable' })
  async check() {
    const result = await this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
    ]);
    return {
      ...result,
      service: 'hypertron-api',
      coreBackend: this.coreBackend.isConfigured()
        ? 'configured'
        : 'not_configured',
      redis: redisDisabled() ? 'disabled' : 'enabled',
    };
  }
}
