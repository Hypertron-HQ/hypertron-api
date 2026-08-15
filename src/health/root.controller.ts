import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller()
@SkipThrottle()
export class RootController {
  @Get()
  @ApiOperation({ summary: 'Service identity' })
  identity() {
    return { service: 'hypertron-api', status: 'ok' };
  }
}
