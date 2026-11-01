import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import {
  All,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Module,
  OnModuleInit,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClientGrpc, ClientsModule, Transport } from '@nestjs/microservices';
import { Response } from 'express';
import { firstValueFrom, Observable } from 'rxjs';
import { z } from 'zod';
import { config, GRPC_LOADER_OPTIONS, ORDER_PROTO_PATH } from '@food/contracts';
import { CORRELATION_HEADER, currentCorrelationId } from '@food/observability';
import { AuthedRequest, JwtGuard, Public, RateLimitGuard } from './guards';

const GRPC_DEADLINE_MS = 3_000;
const HTTP_TIMEOUT_MS = 5_000;

interface OrderGrpcClient {
  createOrder(input: unknown, metadata: Metadata, options: { deadline: Date }): Observable<unknown>;
  getOrder(input: unknown, metadata: Metadata, options: { deadline: Date }): Observable<unknown>;
  listOrders(
    input: unknown,
    metadata: Metadata,
    options: { deadline: Date },
  ): Observable<{ orders?: unknown[] }>;
}

const CreateOrderSchema = z.object({
  restaurantId: z.string().uuid(),
  items: z
    .array(z.object({ menuItemId: z.string(), quantity: z.number().int().min(1).max(50) }))
    .min(1),
  delivery: z.object({
    address: z.string().min(1),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  cardWillFail: z.boolean().default(false),
});

const GRPC_TO_HTTP: Record<number, number> = {
  [GrpcStatus.INVALID_ARGUMENT]: HttpStatus.BAD_REQUEST,
  [GrpcStatus.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [GrpcStatus.PERMISSION_DENIED]: HttpStatus.FORBIDDEN,
  [GrpcStatus.DEADLINE_EXCEEDED]: HttpStatus.GATEWAY_TIMEOUT,
  [GrpcStatus.UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
};

@Controller()
class OrdersController implements OnModuleInit {
  private orders!: OrderGrpcClient;

  constructor(@Inject('ORDER_GRPC') private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.orders = this.client.getService<OrderGrpcClient>('OrderService');
  }

  /** Every gRPC call gets a deadline, and the correlation ID travels in metadata. */
  private async call<T>(invoke: (metadata: Metadata, options: { deadline: Date }) => Observable<T>) {
    const metadata = new Metadata();
    metadata.set(CORRELATION_HEADER, currentCorrelationId());
    try {
      return await firstValueFrom(invoke(metadata, { deadline: new Date(Date.now() + GRPC_DEADLINE_MS) }));
    } catch (error) {
      const { code, details } = error as { code?: number; details?: string };
      const status = GRPC_TO_HTTP[code ?? -1] ?? HttpStatus.BAD_GATEWAY;
      throw new HttpException(details ?? 'Order service error', status);
    }
  }

  @Post('orders')
  create(
    @Req() req: AuthedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (req.user!.role !== 'CUSTOMER') throw new ForbiddenException('Customer account required');
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    const parsed = CreateOrderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { delivery, ...order } = parsed.data;
    return this.call((metadata, options) =>
      this.orders.createOrder(
        {
          ...order,
          customerId: req.user!.sub,
          customerEmail: req.user!.email,
          idempotencyKey,
          deliveryAddress: delivery.address,
          deliveryLat: delivery.lat,
          deliveryLng: delivery.lng,
        },
        metadata,
        options,
      ),
    );
  }

  @Get('orders')
  async list(@Req() req: AuthedRequest) {
    const result = await this.call((metadata, options) =>
      this.orders.listOrders({ customerId: req.user!.sub }, metadata, options),
    );
    return result.orders ?? [];
  }

  @Get('orders/:id')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.call((metadata, options) =>
      this.orders.getOrder(
        { orderId: id, requesterId: req.user!.sub, requesterRole: req.user!.role },
        metadata,
        options,
      ),
    );
  }
}

/** Plain HTTP routing to the services that have no gRPC arrow in the diagram. */
@Controller()
class ProxyController {
  private async forward(req: AuthedRequest, res: Response, target: string) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [CORRELATION_HEADER]: currentCorrelationId(),
    };
    // Built from the verified token only. Any x-user-* header sent by a client is dropped.
    if (req.user) {
      headers['x-user-id'] = req.user.sub;
      headers['x-user-role'] = req.user.role;
      if (req.user.restaurantId) headers['x-user-restaurant-id'] = req.user.restaurantId;
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method);

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${target}${req.originalUrl}`, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      res.status(HttpStatus.BAD_GATEWAY).json({ message: 'Upstream service unavailable' });
      return;
    }
    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') ?? 'application/json')
      .send(await upstream.text());
  }

  @Public()
  @All('auth/*path')
  auth(@Req() req: AuthedRequest, @Res() res: Response) {
    return this.forward(req, res, config.services.auth);
  }

  @Public()
  @Get(['restaurants', 'restaurants/:id'])
  restaurants(@Req() req: AuthedRequest, @Res() res: Response) {
    return this.forward(req, res, config.services.restaurant);
  }

  @All(['restaurants/menu/*path', 'kitchen/*path'])
  restaurantWrites(@Req() req: AuthedRequest, @Res() res: Response) {
    return this.forward(req, res, config.services.restaurant);
  }

  @All('courier/*path')
  courier(@Req() req: AuthedRequest, @Res() res: Response) {
    return this.forward(req, res, config.services.delivery);
  }

  @Public()
  @Get('search')
  search(@Req() req: AuthedRequest, @Res() res: Response) {
    return this.forward(req, res, config.services.search);
  }

  @All('analytics/*path')
  analytics(@Req() req: AuthedRequest, @Res() res: Response) {
    return this.forward(req, res, config.services.analytics);
  }

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'ORDER_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'orders',
          protoPath: ORDER_PROTO_PATH,
          url: config.orderGrpcUrl,
          loader: GRPC_LOADER_OPTIONS,
          // gRPC's default reconnect backoff reaches 2 minutes, so the gateway would
          // keep failing long after Order Service came back.
          channelOptions: {
            'grpc.initial_reconnect_backoff_ms': 200,
            'grpc.min_reconnect_backoff_ms': 200,
            'grpc.max_reconnect_backoff_ms': 2_000,
          },
        },
      },
    ]),
  ],
  controllers: [OrdersController, ProxyController],
  providers: [
    // Guards run in this order: rate limit first, so rejected traffic costs the least.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: JwtGuard },
  ],
})
export class AppModule {}
