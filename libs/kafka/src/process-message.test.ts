import { describe, expect, it, vi } from 'vitest';
import { makeEvent } from '@food/contracts';
import { processMessage } from './process-message';

const valid = JSON.stringify(
  makeEvent(
    'payment.failed',
    { orderId: '3f1d3a9e-8a4e-4b7a-9c55-0e6f1a2b3c4d', reason: 'declined' },
    'corr',
  ),
);
const options = { maxRetries: 2, baseDelayMs: 100, sleep: vi.fn(async () => {}) };

describe('processMessage', () => {
  it('passes a valid event to the handler', async () => {
    const handler = vi.fn(async () => {});
    const dlq = vi.fn(async () => {});
    await expect(processMessage(valid, 'payment.failed', handler, dlq, options)).resolves.toBe('handled');
    expect(handler).toHaveBeenCalledOnce();
    expect(dlq).not.toHaveBeenCalled();
  });

  it('sends malformed JSON straight to the DLQ without retrying', async () => {
    const handler = vi.fn(async () => {});
    const dlq = vi.fn(async () => {});
    await processMessage('not json', 'payment.failed', handler, dlq, options);
    expect(handler).not.toHaveBeenCalled();
    expect(dlq).toHaveBeenCalledOnce();
  });

  it('rejects an event on the wrong topic', async () => {
    const dlq = vi.fn(async () => {});
    const result = await processMessage(valid, 'payment.done', vi.fn(), dlq, options);
    expect(result).toBe('dead-lettered');
  });

  it('recovers when a retry succeeds', async () => {
    const handler = vi.fn(async () => {}).mockRejectedValueOnce(new Error('blip'));
    const dlq = vi.fn(async () => {});
    await expect(processMessage(valid, 'payment.failed', handler, dlq, options)).resolves.toBe('handled');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(dlq).not.toHaveBeenCalled();
  });

  it('backs off exponentially, then dead-letters', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const handler = vi.fn(async () => {
      throw new Error('down');
    });
    const dlq = vi.fn(async () => {});
    const result = await processMessage(valid, 'payment.failed', handler, dlq, { ...options, sleep });
    expect(result).toBe('dead-lettered');
    expect(handler).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    expect(dlq).toHaveBeenCalledWith('down', 3);
  });
});
