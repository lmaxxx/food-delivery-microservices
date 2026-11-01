import { Consumer, Kafka, logLevel, Partitioners, Producer } from 'kafkajs';
import {
  config,
  dlqTopic,
  EventEnvelope,
  EventPayload,
  EventType,
  makeEvent,
} from '@food/contracts';
import { createLogger, currentCorrelationId, runWithCorrelation } from '@food/observability';
import { processMessage } from './process-message';

export { processMessage } from './process-message';

export type Handlers = { [T in EventType]?: (event: EventEnvelope<T>) => Promise<void> };

/** One service's connection to the event bus. */
export class EventBus {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumers = new Set<Consumer>();
  private stopping = false;
  private readonly log;

  constructor(private readonly service: string) {
    this.kafka = new Kafka({
      clientId: service,
      brokers: config.kafkaBrokers,
      logLevel: logLevel.ERROR,
    });
    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
      // Broker discards duplicates caused by producer retries
      idempotent: true,
    });
    this.log = createLogger(service);
  }

  async connect() {
    await this.producer.connect();
  }

  /** Direct publish. Unlike the outbox, a crash right after a DB commit loses this event. */
  async publish<T extends EventType>(type: T, key: string, payload: EventPayload<T>) {
    const event = makeEvent(type, payload, currentCorrelationId());
    await this.publishEnvelope(event, key);
    return event;
  }

  async publishEnvelope(event: EventEnvelope, key: string) {
    await this.producer.send({
      topic: event.type,
      acks: -1,
      messages: [{ key, value: JSON.stringify(event) }],
    });
  }

  /**
   * Instances sharing a groupId split the partitions between them.
   * Different groupIds each get their own copy of every event.
   */
  async subscribe(groupId: string, handlers: Handlers) {
    const consumer = this.kafka.consumer({ groupId });
    this.consumers.add(consumer);

    // kafkajs gives up on some errors, such as committing after the group removed this
    // member during a long pause. The process would stay up and look healthy while
    // consuming nothing, so replace the consumer. Uncommitted messages are redelivered.
    consumer.on(consumer.events.CRASH, ({ payload }) => {
      if (payload.restart || this.stopping) return;
      this.log.error({ groupId, err: payload.error }, 'consumer crashed, replacing it');
      this.consumers.delete(consumer);
      void consumer
        .disconnect()
        .catch(() => undefined)
        .then(() => this.resubscribe(groupId, handlers));
    });

    await consumer.connect();
    await consumer.subscribe({ topics: Object.keys(handlers), fromBeginning: true });

    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const raw = message.value?.toString() ?? '';
        const handler = handlers[topic as EventType] as (e: EventEnvelope) => Promise<void>;

        await processMessage(
          raw,
          topic,
          (event) =>
            runWithCorrelation(event.correlationId, async () => {
              await handler(event);
              this.log.info({ eventId: event.eventId, topic, partition }, 'event handled');
            }),
          async (reason, attempts) => {
            this.log.error({ topic, partition, offset: message.offset, reason }, 'sent to DLQ');
            await this.producer.send({
              topic: dlqTopic(topic),
              messages: [
                {
                  key: message.key,
                  value: message.value,
                  headers: {
                    'x-failed-group': groupId,
                    'x-reason': reason.slice(0, 500),
                    'x-attempts': String(attempts),
                    'x-original-partition': String(partition),
                    'x-original-offset': message.offset,
                  },
                },
              ],
            });
          },
          {
            maxRetries: Number(process.env.KAFKA_MAX_RETRIES ?? 3),
            baseDelayMs: Number(process.env.KAFKA_RETRY_BASE_MS ?? 200),
          },
        );

        // Committed last: a crash before this line means the message is redelivered.
        await consumer.commitOffsets([
          { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
        ]);
      },
    });
  }

  private async resubscribe(groupId: string, handlers: Handlers) {
    for (let delayMs = 1000; !this.stopping; delayMs = Math.min(delayMs * 2, 30000)) {
      try {
        await this.subscribe(groupId, handlers);
        this.log.info({ groupId }, 'consumer replaced');
        return;
      } catch (err) {
        this.log.error({ groupId, err, delayMs }, 'could not replace consumer, retrying');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async disconnect() {
    this.stopping = true;
    await Promise.allSettled([...this.consumers].map((consumer) => consumer.disconnect()));
    await this.producer.disconnect();
  }
}
