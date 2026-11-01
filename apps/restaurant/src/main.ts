import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { databaseUrl, EventEnvelope } from '@food/contracts';
import { EventBus } from '@food/kafka';
import { correlationMiddleware } from '@food/observability';
import { Prisma, PrismaClient } from './generated/prisma';
import { SEED } from './seed';

@Injectable()
class RestaurantService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly prisma = new PrismaClient({ datasourceUrl: databaseUrl('restaurants') });
  private readonly bus = new EventBus('restaurant');

  async onApplicationBootstrap() {
    await this.bus.connect();
    await this.seed();
    await this.bus.subscribe('restaurant', {
      'order.paid': (event) => this.onOrderPaid(event),
      'order.status_changed': (event) => this.onStatusChanged(event),
    });
  }

  async onModuleDestroy() {
    await this.bus.disconnect();
  }

  private async seed() {
    for (const r of SEED) {
      await this.prisma.restaurant.upsert({
        where: { id: r.id },
        create: { id: r.id, ownerId: r.ownerId, name: r.name, cuisine: r.cuisine, lat: r.lat, lng: r.lng },
        update: {},
      });
      for (const item of r.menu) {
        await this.prisma.menuItem.upsert({
          where: { id: item.id },
          create: { ...item, restaurantId: r.id },
          update: {},
        });
      }
      await this.publishRestaurant(r.id);
    }
  }

  /** Event-carried state transfer: the event holds everything a reader needs. */
  private async publishRestaurant(restaurantId: string) {
    const r = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      include: { menu: true },
    });
    await this.bus.publish('restaurant.updated', r.id, {
      restaurantId: r.id,
      name: r.name,
      cuisine: r.cuisine,
      lat: r.lat,
      lng: r.lng,
      menu: r.menu.map(({ id, name, description, priceCents }) => ({ id, name, description, priceCents })),
    });
  }

  /**
   * Inserts the event ID and applies the change in one transaction, so a
   * redelivered event becomes a no-op. Returns false for a duplicate.
   */
  private once(eventId: string, apply: (tx: Prisma.TransactionClient) => Promise<void>) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.processedEvent.createMany({
        data: [{ eventId }],
        skipDuplicates: true,
      });
      if (count === 0) return false;
      await apply(tx);
      return true;
    });
  }

  private async onOrderPaid({ eventId, payload }: EventEnvelope<'order.paid'>) {
    await this.once(eventId, async (tx) => {
      await tx.ticket.create({
        data: {
          orderId: payload.orderId,
          restaurantId: payload.restaurantId,
          customerId: payload.customerId,
          items: payload.items,
          totalCents: payload.totalCents,
          address: payload.delivery.address,
          deliveryLat: payload.delivery.lat,
          deliveryLng: payload.delivery.lng,
        },
      });
    });
  }

  private async onStatusChanged({ eventId, payload }: EventEnvelope<'order.status_changed'>) {
    // The kitchen's part ends when the courier takes the food or the order is cancelled.
    if (!['PICKED_UP', 'DELIVERED', 'REFUNDING', 'CANCELLED'].includes(payload.status)) return;
    await this.once(eventId, async (tx) => {
      await tx.ticket.updateMany({
        where: { orderId: payload.orderId, status: { in: ['NEW', 'ACCEPTED', 'READY'] } },
        data: { status: 'CLOSED' },
      });
    });
  }

  list() {
    return this.prisma.restaurant.findMany({ include: { menu: { orderBy: { name: 'asc' } } } });
  }

  async get(id: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id },
      include: { menu: { orderBy: { name: 'asc' } } },
    });
    if (!restaurant) throw new NotFoundException();
    return restaurant;
  }

  async updatePrice(restaurantId: string, itemId: string, priceCents: number) {
    const { count } = await this.prisma.menuItem.updateMany({
      where: { id: itemId, restaurantId },
      data: { priceCents },
    });
    if (count === 0) throw new NotFoundException();
    await this.publishRestaurant(restaurantId);
    return this.get(restaurantId);
  }

  tickets(restaurantId: string) {
    return this.prisma.ticket.findMany({
      where: { restaurantId, status: { in: ['NEW', 'ACCEPTED', 'READY'] } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** A status-guarded update, so two clicks cannot both succeed. */
  private async moveTicket(restaurantId: string, orderId: string, from: string, to: string) {
    const { count } = await this.prisma.ticket.updateMany({
      where: { orderId, restaurantId, status: from },
      data: { status: to },
    });
    if (count === 0) throw new ConflictException(`Ticket is not ${from}`);
    return this.prisma.ticket.findUniqueOrThrow({ where: { orderId } });
  }

  async accept(restaurantId: string, orderId: string) {
    const ticket = await this.moveTicket(restaurantId, orderId, 'NEW', 'ACCEPTED');
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
    // Direct publish: a crash right here loses the event. The saga deadline in Order catches it.
    await this.bus.publish('order.accepted', orderId, {
      orderId,
      customerId: ticket.customerId,
      restaurantId,
      pickup: { lat: restaurant.lat, lng: restaurant.lng },
      delivery: { lat: ticket.deliveryLat, lng: ticket.deliveryLng },
    });
    return ticket;
  }

  async reject(restaurantId: string, orderId: string, reason: string) {
    const ticket = await this.moveTicket(restaurantId, orderId, 'NEW', 'REJECTED');
    await this.bus.publish('order.rejected', orderId, { orderId, restaurantId, reason });
    return ticket;
  }

  async ready(restaurantId: string, orderId: string) {
    const ticket = await this.moveTicket(restaurantId, orderId, 'ACCEPTED', 'READY');
    await this.bus.publish('order.ready', orderId, { orderId, restaurantId });
    return ticket;
  }
}

const requireRestaurant = (restaurantId?: string) => {
  if (!restaurantId) throw new ForbiddenException('Restaurant account required');
  return restaurantId;
};

@Controller()
class RestaurantController {
  constructor(private readonly service: RestaurantService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('restaurants')
  list() {
    return this.service.list();
  }

  @Get('restaurants/:id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch('restaurants/menu/:itemId')
  updatePrice(
    @Headers('x-user-restaurant-id') restaurantId: string | undefined,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ priceCents: z.number().int().positive() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.updatePrice(requireRestaurant(restaurantId), itemId, parsed.data.priceCents);
  }

  @Get('kitchen/tickets')
  tickets(@Headers('x-user-restaurant-id') restaurantId?: string) {
    return this.service.tickets(requireRestaurant(restaurantId));
  }

  @Post('kitchen/tickets/:orderId/accept')
  accept(@Headers('x-user-restaurant-id') restaurantId: string | undefined, @Param('orderId') orderId: string) {
    return this.service.accept(requireRestaurant(restaurantId), orderId);
  }

  @Post('kitchen/tickets/:orderId/reject')
  reject(
    @Headers('x-user-restaurant-id') restaurantId: string | undefined,
    @Param('orderId') orderId: string,
    @Body() body: { reason?: string } | undefined,
  ) {
    return this.service.reject(requireRestaurant(restaurantId), orderId, body?.reason ?? 'Kitchen is busy');
  }

  @Post('kitchen/tickets/:orderId/ready')
  ready(@Headers('x-user-restaurant-id') restaurantId: string | undefined, @Param('orderId') orderId: string) {
    return this.service.ready(requireRestaurant(restaurantId), orderId);
  }
}

@Module({ controllers: [RestaurantController], providers: [RestaurantService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3002));
}
void bootstrap();
