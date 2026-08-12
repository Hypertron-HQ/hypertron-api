/**
 * WebhookEndpointsController — /api/developer/webhook-endpoints
 *
 * Session-authenticated dashboard control-plane for webhook endpoints.
 * Reads are open to any member; mutations require Owner or Admin.
 *
 * Routes (spec section 8):
 *   GET    /api/developer/webhook-endpoints                     — list
 *   POST   /api/developer/webhook-endpoints                     — create (secret once)
 *   PATCH  /api/developer/webhook-endpoints/:id                 — update
 *   POST   /api/developer/webhook-endpoints/:id/rotate-secret   — new secret once
 *   DELETE /api/developer/webhook-endpoints/:id                 — delete
 *   GET    /api/developer/webhook-endpoints/:id/deliveries      — delivery log
 *   POST   /api/developer/webhook-endpoints/:id/deliveries/:deliveryId/retry
 *   POST   /api/developer/webhook-endpoints/:id/test            — one test delivery
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SessionGuard } from '@/common/guards/session.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { Roles } from '@/common/decorators/roles.decorator';
import {
  CurrentUser,
  type SessionUser,
} from '@/common/decorators/current-user.decorator';
import { WebhookEndpointService } from '@/modules/webhooks/webhook-endpoint.service';
import { WebhookDeliveryService } from '@/modules/webhooks/webhook-delivery.service';
import { CreateWebhookEndpointDto } from '@/modules/webhooks/dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from '@/modules/webhooks/dto/update-webhook-endpoint.dto';
import { ListDeliveriesDto } from '@/modules/webhooks/dto/list-deliveries.dto';
import {
  DeletedWebhookEndpointResponseDto,
  WebhookEndpointListResponseDto,
  WebhookEndpointResponseDto,
  toDeletedWebhookEndpointResponse,
  toWebhookEndpointListResponse,
  toWebhookEndpointResponse,
} from '@/modules/webhooks/dto/webhook-endpoint-response.dto';
import {
  TestWebhookResponseDto,
  WebhookDeliveryListResponseDto,
  WebhookDeliveryResponseDto,
  toWebhookDeliveryListResponse,
  toWebhookDeliveryResponse,
} from '@/modules/webhooks/dto/webhook-delivery-response.dto';

@ApiTags('Developer')
@ApiBearerAuth('SessionCookie')
@Controller('api/developer/webhook-endpoints')
@UseGuards(SessionGuard, RolesGuard)
export class WebhookEndpointsController {
  constructor(
    private readonly endpoints: WebhookEndpointService,
    private readonly deliveries: WebhookDeliveryService,
  ) {}

  // ─── GET /api/developer/webhook-endpoints ───────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'List webhook endpoints',
    description:
      'Returns all endpoints for the authenticated merchant. signing_secret is always null here.',
  })
  @ApiResponse({ status: 200, type: WebhookEndpointListResponseDto })
  async list(
    @CurrentUser() user: SessionUser,
  ): Promise<WebhookEndpointListResponseDto> {
    const records = await this.endpoints.list(user.businessId);
    return toWebhookEndpointListResponse(records);
  }

  // ─── POST /api/developer/webhook-endpoints ──────────────────────────────────

  @Post()
  @Roles('owner', 'admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create webhook endpoint',
    description:
      'Creates an endpoint and returns signing_secret exactly once. Store it — it cannot be retrieved again.',
  })
  @ApiResponse({ status: 201, type: WebhookEndpointResponseDto })
  async create(
    @Body() dto: CreateWebhookEndpointDto,
    @CurrentUser() user: SessionUser,
  ): Promise<WebhookEndpointResponseDto> {
    const result = await this.endpoints.create({
      businessId: user.businessId,
      url: dto.url,
      environment: dto.environment,
      events: dto.events,
      description: dto.description ?? null,
    });

    return toWebhookEndpointResponse(result.endpoint, result.signingSecret);
  }

  // ─── PATCH /api/developer/webhook-endpoints/:id ─────────────────────────────

  @Patch(':id')
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Update webhook endpoint',
    description: 'Updates url, events, description, or active state.',
  })
  @ApiParam({ name: 'id', description: 'Endpoint publicId (we_...)' })
  @ApiResponse({ status: 200, type: WebhookEndpointResponseDto })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookEndpointDto,
    @CurrentUser() user: SessionUser,
  ): Promise<WebhookEndpointResponseDto> {
    const updated = await this.endpoints.update(id, user.businessId, dto);
    return toWebhookEndpointResponse(updated, null);
  }

  // ─── POST /api/developer/webhook-endpoints/:id/rotate-secret ────────────────

  @Post(':id/rotate-secret')
  @Roles('owner', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate signing secret',
    description:
      'Generates a new signing secret and returns it once. Deliveries still queued sign with the new secret.',
  })
  @ApiParam({ name: 'id', description: 'Endpoint publicId (we_...)' })
  @ApiResponse({ status: 200, type: WebhookEndpointResponseDto })
  async rotateSecret(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<WebhookEndpointResponseDto> {
    const result = await this.endpoints.rotateSecret(id, user.businessId);
    return toWebhookEndpointResponse(result.endpoint, result.signingSecret);
  }

  // ─── DELETE /api/developer/webhook-endpoints/:id ────────────────────────────

  @Delete(':id')
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Delete webhook endpoint',
    description: 'Deletes the endpoint and its delivery history.',
  })
  @ApiParam({ name: 'id', description: 'Endpoint publicId (we_...)' })
  @ApiResponse({ status: 200, type: DeletedWebhookEndpointResponseDto })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<DeletedWebhookEndpointResponseDto> {
    const removed = await this.endpoints.remove(id, user.businessId);
    return toDeletedWebhookEndpointResponse(removed);
  }

  // ─── GET /api/developer/webhook-endpoints/:id/deliveries ────────────────────

  @Get(':id/deliveries')
  @ApiOperation({
    summary: 'List webhook deliveries',
    description:
      'Cursor-paginated delivery log with attempt counts, response status, and truncated response bodies.',
  })
  @ApiParam({ name: 'id', description: 'Endpoint publicId (we_...)' })
  @ApiResponse({ status: 200, type: WebhookDeliveryListResponseDto })
  async listDeliveries(
    @Param('id') id: string,
    @Query() query: ListDeliveriesDto,
    @CurrentUser() user: SessionUser,
  ): Promise<WebhookDeliveryListResponseDto> {
    const { page } = await this.deliveries.listDeliveries(id, user.businessId, {
      limit: query.limit ?? 25,
      cursor: query.cursor,
      status: query.status,
    });

    return toWebhookDeliveryListResponse(
      page.data,
      id,
      page.hasMore,
      page.nextCursor,
    );
  }

  // ─── POST .../:id/deliveries/:deliveryId/retry ──────────────────────────────

  @Post(':id/deliveries/:deliveryId/retry')
  @Roles('owner', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a webhook delivery',
    description:
      'Re-queues a pending or failed delivery immediately and restarts the retry schedule.',
  })
  @ApiParam({ name: 'id', description: 'Endpoint publicId (we_...)' })
  @ApiParam({ name: 'deliveryId', description: 'Delivery publicId (whd_...)' })
  @ApiResponse({ status: 200, type: WebhookDeliveryResponseDto })
  async retryDelivery(
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<WebhookDeliveryResponseDto> {
    const delivery = await this.deliveries.retryDelivery(
      id,
      deliveryId,
      user.businessId,
    );
    return toWebhookDeliveryResponse(delivery, id);
  }

  // ─── POST /api/developer/webhook-endpoints/:id/test ─────────────────────────

  @Post(':id/test')
  @Roles('owner', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a test webhook',
    description:
      'Sends one synthetic payment.completed delivery and returns the raw result. No event or delivery record is stored.',
  })
  @ApiParam({ name: 'id', description: 'Endpoint publicId (we_...)' })
  @ApiResponse({ status: 200, type: TestWebhookResponseDto })
  async sendTest(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<TestWebhookResponseDto> {
    const result = await this.deliveries.sendTest(id, user.businessId);

    const dto = new TestWebhookResponseDto();
    dto.delivered = result.ok;
    dto.response_status = result.status;
    dto.response_body = result.body;
    dto.error = result.error;
    return dto;
  }
}
