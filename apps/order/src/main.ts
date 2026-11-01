import { Metadata } from '@grpc/grpc-js';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GrpcMethod, MicroserviceOptions, Transport } from '@nestjs/microservices';
import { GRPC_LOADER_OPTIONS, ORDER_PROTO_PATH } from '@food/contracts';
import { CORRELATION_HEADER, correlationMiddleware, runWithCorrelation } from '@food/observability';
import { CreateOrderInput, OrderService } from './order.service';

type OrderLike = Awaited<ReturnType<OrderService['get']>>;

/** Maps a database row to the shape of the Order message in proto/order.proto. */
const toProto = (order: OrderLike) => ({
  id: order.id,
  customerId: order.customerId,
  restaurantId: order.restaurantId,
  status: order.status,
  totalCents: order.totalCents,
  items: order.items,
  deliveryAddress: order.deliveryAddress,
  deliveryLat: order.deliveryLat,
  deliveryLng: order.deliveryLng,
  courierId: order.courierId ?? '',
  ready: order.ready,
  createdAt: order.createdAt.toISOString(),
  history: order.history.map((h) => ({
    status: h.status,
    reason: h.reason ?? '',
    at: h.at.toISOString(),
  })),
});

const withCorrelation = <T>(metadata: Metadata, fn: () => T) =>
  runWithCorrelation(String(metadata.get(CORRELATION_HEADER)[0] ?? crypto.randomUUID()), fn);

@Controller()
class OrderGrpcController {
  constructor(private readonly orders: OrderService) {}

  @GrpcMethod('OrderService', 'CreateOrder')
  async createOrder(input: CreateOrderInput, metadata: Metadata) {
    return withCorrelation(metadata, async () => toProto(await this.orders.create(input)));
  }

  @GrpcMethod('OrderService', 'GetOrder')
  async getOrder(
    input: { orderId: string; requesterId: string; requesterRole: string },
    metadata: Metadata,
  ) {
    return withCorrelation(metadata, async () =>
      toProto(await this.orders.get(input.orderId, input.requesterId, input.requesterRole)),
    );
  }

  @GrpcMethod('OrderService', 'ListOrders')
  async listOrders(input: { customerId: string }) {
    return { orders: (await this.orders.list(input.customerId)).map(toProto) };
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [OrderGrpcController], providers: [OrderService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        package: 'orders',
        protoPath: ORDER_PROTO_PATH,
        url: process.env.GRPC_BIND ?? '0.0.0.0:50051',
        loader: GRPC_LOADER_OPTIONS,
      },
    },
    { inheritAppConfig: true },
  );
  await app.startAllMicroservices();
  await app.listen(Number(process.env.PORT ?? 3003));
}
void bootstrap();
