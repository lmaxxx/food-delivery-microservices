import { Controller, Get, Injectable, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { databaseUrl, EventEnvelope } from '@food/contracts';
import { EventBus } from '@food/kafka';
import { correlationMiddleware } from '@food/observability';
import { Prisma, PrismaClient } from './generated/prisma';

// Simulates a slow card network, so load experiments can create a real bottleneck.
const SIMULATED_DELAY_MS = Number(process.env.PAYMENT_DELAY_MS ?? 0);

@Injectable()
class PaymentService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly prisma = new PrismaClient({ datasourceUrl: databaseUrl('payments') });
  private readonly bus = new EventBus('payment');

  async onApplicationBootstrap() {
    await this.bus.connect();
    await this.bus.subscribe('payment', {
      'order.created': (event) => this.charge(event),
      'payment.refund_requested': (event) => this.refund(event),
    });
  }

  async onModuleDestroy() {
    await this.bus.disconnect();
  }

  private once<T>(eventId: string, apply: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.processedEvent.createMany({ data: [{ eventId }], skipDuplicates: true });
      return count === 1 ? apply(tx) : null;
    });
  }

  private async charge({ eventId, payload }: EventEnvelope<'order.created'>) {
    if (SIMULATED_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, SIMULATED_DELAY_MS));
    const payment = await this.once(eventId, async (tx) => {
      // A row may already exist if a timeout refund voided this order first. Do not charge then.
      const existing = await tx.payment.findUnique({ where: { orderId: payload.orderId } });
      if (existing) return null;
      return tx.payment.create({
        data: {
          orderId: payload.orderId,
          amountCents: payload.totalCents,
          status: payload.cardWillFail ? 'FAILED' : 'CHARGED',
        },
      });
    });
    if (!payment) return;

    // No outbox here, as in the diagram. A crash at this point loses the event, and
    // Order's saga deadline issues a refund. Lesson exercise: add an outbox here.
    if (payment.status === 'FAILED') {
      await this.bus.publish('payment.failed', payload.orderId, {
        orderId: payload.orderId,
        reason: 'Card declined',
      });
    } else {
      await this.bus.publish('payment.done', payload.orderId, {
        orderId: payload.orderId,
        paymentId: payment.id,
        amountCents: payment.amountCents,
      });
    }
  }

  private async refund({ eventId, payload }: EventEnvelope<'payment.refund_requested'>) {
    const amountCents = await this.once(eventId, async (tx) => {
      const payment = await tx.payment.findUnique({ where: { orderId: payload.orderId } });
      if (!payment) {
        // Refund overtook the charge. A VOIDED row blocks the charge when it arrives later.
        await tx.payment.create({
          data: { orderId: payload.orderId, amountCents: 0, status: 'VOIDED' },
        });
        return 0;
      }
      if (payment.status !== 'CHARGED') return 0;
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });
      return payment.amountCents;
    });
    if (amountCents === null) return;
    await this.bus.publish('payment.refunded', payload.orderId, {
      orderId: payload.orderId,
      amountCents,
    });
  }
}

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController], providers: [PaymentService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3004));
}
void bootstrap();
