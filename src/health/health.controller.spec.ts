import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { CoreBackendClient } from '../infrastructure/core-backend/core-backend.client';

describe('HealthController', () => {
  let controller: HealthController;
  let healthCheckService: jest.Mocked<HealthCheckService>;

  beforeEach(async () => {
    const mockHealthResult = {
      status: 'ok' as const,
      info: { database: { status: 'up' as const } },
      error: {},
      details: { database: { status: 'up' as const } },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: {
            check: jest.fn().mockResolvedValue(mockHealthResult),
          },
        },
        {
          provide: PrismaHealthIndicator,
          useValue: {
            pingCheck: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: CoreBackendClient,
          useValue: { isConfigured: () => true },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthCheckService = module.get(HealthCheckService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('check() calls HealthCheckService.check', async () => {
    const result = await controller.check();
    expect(healthCheckService.check).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
  });
});
