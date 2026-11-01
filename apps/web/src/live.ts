import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { LiveEvent, loadSession, WS_URL } from './api';

let socket: Socket | null = null;

/** One authenticated socket for the tab. The handshake carries the JWT. */
function getSocket() {
  const session = loadSession();
  if (!session) return null;
  // WebSocket only: long-polling would need sticky sessions across gateway instances.
  socket ??= io(WS_URL, { auth: { token: session.accessToken }, transports: ['websocket'] });
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
}

export function useLiveEvents(onEvent: (event: LiveEvent) => void, options: { dev?: boolean } = {}) {
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const subscribeDev = () => s.emit('dev:subscribe');
    if (options.dev) {
      // Rooms belong to one connection, so a reconnect must join again.
      subscribeDev();
      s.on('connect', subscribeDev);
    }
    s.on('event', onEvent);
    return () => {
      s.off('event', onEvent);
      s.off('connect', subscribeDev);
    };
  }, [onEvent, options.dev]);
}

/** Server state stays in TanStack Query. A status event means "refetch", not "patch". */
export function useRefreshOnStatusChange(...keys: string[][]) {
  const client = useQueryClient();
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const refresh = (event: LiveEvent) => {
      if (event.type !== 'order.status_changed') return;
      for (const key of keys) void client.invalidateQueries({ queryKey: key });
    };
    s.on('event', refresh);
    return () => void s.off('event', refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, JSON.stringify(keys)]);
}
