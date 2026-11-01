import { randomUUID } from 'node:crypto';
import { DEMO } from '@food/contracts';

export const API = process.env.API_URL ?? 'http://localhost:4400';
export const PIZZA_ID = DEMO.restaurants[0].restaurantId;
const DELIVERY = { address: 'Khreshchatyk 1, Kyiv', lat: 50.4475, lng: 30.5222 };

export interface Session {
  token: string;
  user: { id: string; email: string };
}

export async function http(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  const response = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...rest.headers,
    },
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body };
}

/** Throws on a non-2xx response. */
export async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const { status, body } = await http(path, init);
  if (status >= 300) throw new Error(`${init.method ?? 'GET'} ${path}: ${status} ${JSON.stringify(body)}`);
  return body;
}

export async function login(email: string, password = DEMO.password): Promise<Session> {
  const body = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  return { token: body.accessToken, user: body.user };
}

export const placeOrder = (customer: Session, options: { cardWillFail?: boolean; key?: string } = {}) =>
  api('/orders', {
    method: 'POST',
    token: customer.token,
    headers: { 'idempotency-key': options.key ?? randomUUID() },
    body: JSON.stringify({
      restaurantId: PIZZA_ID,
      items: [
        { menuItemId: 'pizza-margherita', quantity: 2 },
        { menuItemId: 'pasta-carbonara', quantity: 1 },
      ],
      delivery: DELIVERY,
      cardWillFail: options.cardWillFail ?? false,
    }),
  });

export async function waitFor<T>(
  label: string,
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError}` : ''}`);
}

export const waitForStatus = (customer: Session, orderId: string, status: string, timeoutMs?: number) =>
  waitFor(
    `order ${orderId.slice(0, 8)} to reach ${status}`,
    async () => {
      const order = await api(`/orders/${orderId}`, { token: customer.token });
      return order.status === status ? order : null;
    },
    timeoutMs,
  );
