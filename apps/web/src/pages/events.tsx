import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, LiveEvent, money, Summary, time } from '../api';
import { useLiveEvents } from '../live';
import { Empty, ErrorNotice, Loading, UrlInput } from '../ui';

const MAX_EVENTS = 300;

export function EventsPage() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? '';
  const order = params.get('order') ?? '';
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [hideGps, setHideGps] = useState(true);

  useLiveEvents(
    useCallback((event: LiveEvent) => {
      setEvents((current) =>
        // An event can arrive twice, via the dev room and a personal room.
        current.some((e) => e.eventId === event.eventId) ? current : [event, ...current].slice(0, MAX_EVENTS),
      );
    }, []),
    { dev: true },
  );

  const summary = useQuery({
    queryKey: ['summary'],
    queryFn: () => api<Summary>('/analytics/summary'),
    refetchInterval: 5000,
  });

  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value); else next.delete(name);
    setParams(next, { replace: true });
  };

  const types = [...new Set(events.map((e) => e.type))].sort();
  const visible = events.filter((e) =>
    (!type || e.type === type) &&
    (!order || String(e.payload.orderId ?? '').startsWith(order)) &&
    (!hideGps || e.type !== 'courier.location'),
  );

  return (
    <>
      <h1>Event stream</h1>
      <section className="panel" aria-label="Analytics">
        <h2>From ClickHouse, all time</h2>
        {summary.isPending && <Loading rows={1} />}
        {summary.isError && <ErrorNotice error={summary.error} retry={() => void summary.refetch()} />}
        {summary.data && (
          <div className="figures">
            <div className="figure"><strong>{summary.data.orders}</strong><span className="muted">Orders</span></div>
            <div className="figure"><strong>{money(summary.data.revenueCents)}</strong><span className="muted">Charged</span></div>
            <div className="figure"><strong>{money(summary.data.refundedCents)}</strong><span className="muted">Refunded</span></div>
            <div className="figure"><strong>{summary.data.avgDeliverySeconds === null ? 'None yet' : `${Math.round(summary.data.avgDeliverySeconds)} s`}</strong><span className="muted">Average delivery</span></div>
          </div>
        )}
      </section>
      <div className="row">
        <label style={{ minWidth: 220 }}>Event type
          <select value={type} onChange={(e) => setFilter('type', e.target.value)}>
            <option value="">All types</option>
            {type && !types.includes(type) && <option value={type}>{type}</option>}
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label style={{ minWidth: 220 }}>Order ID starts with
          <UrlInput className="mono" value={order} onCommit={(value) => setFilter('order', value)} />
        </label>
        <label className="check"><input type="checkbox" checked={hideGps} onChange={(e) => setHideGps(e.target.checked)} />Hide courier.location</label>
      </div>
      <section className="panel flush" aria-label="Live Kafka events" aria-live="off">
        {visible.length === 0 ? (
          <Empty title={events.length ? 'No events match these filters' : 'Listening for events'}>
            {events.length ? 'Change the filters above.' : 'This stream starts now and is not stored. Place an order in another window to see it fill.'}
          </Empty>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Topic</th><th>Order</th><th>Correlation</th><th>Payload</th></tr></thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.eventId}>
                  <td className="mono nowrap">{time(e.occurredAt)}</td>
                  <td className="mono nowrap">{e.type}</td>
                  <td className="mono nowrap">{e.payload.orderId ? String(e.payload.orderId).slice(0, 8) : 'None'}</td>
                  <td className="mono nowrap">{e.correlationId.slice(0, 8)}</td>
                  <td className="mono muted">{JSON.stringify(e.payload).slice(0, 180)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
