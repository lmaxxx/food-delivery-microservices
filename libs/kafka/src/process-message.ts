import { EventEnvelope, parseEvent } from '@food/contracts';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export type DeadLetter = (reason: string, attempts: number) => Promise<void>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * What happens to one consumed message:
 *   - invalid contract: retrying cannot help, so it goes straight to the DLQ
 *   - handler error:    retry with exponential backoff, then DLQ
 *
 * It resolves once the message is handled or dead-lettered, and only then may
 * the caller commit the offset. That order is what gives at-least-once delivery.
 * The retries block this partition, which preserves per-key ordering.
 */
export async function processMessage(
  raw: string,
  topic: string,
  handler: (event: EventEnvelope) => Promise<void>,
  deadLetter: DeadLetter,
  { maxRetries, baseDelayMs, sleep = defaultSleep }: RetryOptions,
): Promise<'handled' | 'dead-lettered'> {
  let event: EventEnvelope;
  try {
    event = parseEvent(raw, topic);
  } catch (error) {
    await deadLetter(`invalid: ${(error as Error).message}`, 0);
    return 'dead-lettered';
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await handler(event);
      return 'handled';
    } catch (error) {
      if (attempt >= maxRetries) {
        await deadLetter((error as Error).message, attempt + 1);
        return 'dead-lettered';
      }
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}
