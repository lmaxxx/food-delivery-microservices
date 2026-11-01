export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4400';
export const WS_URL = import.meta.env.VITE_WS_URL ?? 'http://localhost:3010';

export type Role = 'CUSTOMER' | 'COURIER' | 'RESTAURANT';
export interface User { id: string; email: string; role: Role; restaurantId?: string }
export interface Session { accessToken: string; user: User }

export interface MenuItem { id: string; name: string; description: string; priceCents: number }
export interface Restaurant { id?: string; restaurantId?: string; name: string; cuisine: string; lat: number; lng: number; menu: MenuItem[] }
export interface OrderItem { menuItemId: string; name: string; quantity: number; priceCents: number }
export interface Order {
  id: string; restaurantId: string; status: string; totalCents: number; items: OrderItem[];
  deliveryAddress: string; deliveryLat: number; deliveryLng: number; courierId: string; ready: boolean;
  createdAt: string; history: { status: string; reason: string; at: string }[];
}
export interface Ticket { orderId: string; items: OrderItem[]; totalCents: number; address: string; status: 'NEW' | 'ACCEPTED' | 'READY'; createdAt: string }
export interface Point { lat: number; lng: number }
export interface Job { orderId: string; status: 'ASSIGNED' | 'PICKED_UP'; pickup: Point; delivery: Point; ready: boolean }
export interface Summary { orders: number; revenueCents: number; refundedCents: number; avgDeliverySeconds: number | null; eventCounts: { type: string; count: number }[] }
export interface LiveEvent { eventId: string; type: string; occurredAt: string; correlationId: string; payload: Record<string, unknown> & { orderId?: string; status?: string; lat?: number; lng?: number } }

const STORAGE_KEY = 'food-session';

export function loadSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}
export function saveSession(session: Session | null) {
  if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(STORAGE_KEY);
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = loadSession();
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('The API gateway is not reachable. Is pnpm dev running?', 0);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.message === 'string' ? body.message : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), headers });

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const time = (iso: string) => new Date(iso).toLocaleTimeString();
