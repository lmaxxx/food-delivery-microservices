import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, Job, Point, post } from '../api';
import { useRefreshOnStatusChange } from '../live';
import { Empty, ErrorNotice, LiveMap, Loading, Marker } from '../ui';

const START: Point = { lat: 50.449, lng: 30.53 };
const STEP = 0.0006;
const PING_MS = 2000;

function moveToward(from: Point, to: Point): Point {
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const distance = Math.hypot(dLat, dLng);
  if (distance <= STEP) return to;
  return { lat: from.lat + (dLat / distance) * STEP, lng: from.lng + (dLng / distance) * STEP };
}

export function CourierPage() {
  const client = useQueryClient();
  useRefreshOnStatusChange(['job']);
  const [online, setOnline] = useState(false);
  const [position, setPosition] = useState(START);
  const [sendError, setSendError] = useState<unknown>(null);
  const positionRef = useRef(position);

  const job = useQuery({
    queryKey: ['job'],
    queryFn: () => api<{ job: Job | null }>('/courier/job'),
    refetchInterval: online ? 3000 : false,
  });
  const current = job.data?.job ?? null;
  const target = current ? (current.status === 'ASSIGNED' ? current.pickup : current.delivery) : null;
  const targetRef = useRef(target);
  targetRef.current = target;
  // A courier who reloads mid-job is still working it.
  const active = online || current !== null;

  // Simulated GPS: each ping moves toward the target and reports to Delivery Service.
  useEffect(() => {
    if (!active) return;
    const send = async () => {
      const next = targetRef.current ? moveToward(positionRef.current, targetRef.current) : positionRef.current;
      positionRef.current = next;
      setPosition(next);
      try {
        await post('/courier/location', next);
        setSendError(null);
      } catch (error) {
        setSendError(error);
      }
    };
    void send();
    const timer = setInterval(() => void send(), PING_MS);
    return () => clearInterval(timer);
  }, [active]);

  const offline = useMutation({ mutationFn: () => post('/courier/offline'), onSuccess: () => setOnline(false) });
  const advance = useMutation({
    mutationFn: (action: 'pickup' | 'deliver') => post(`/courier/job/${action}`),
    onSettled: () => client.invalidateQueries({ queryKey: ['job'] }),
  });

  const markers = useMemo<Marker[]>(() => {
    const list: Marker[] = [{ ...position, label: 'You', tone: '--color-accent' }];
    if (current) {
      list.push({ ...current.pickup, label: 'Restaurant', tone: '--color-cool' });
      list.push({ ...current.delivery, label: 'Customer', tone: '--color-ink' });
    }
    return list;
  }, [position, current]);

  return (
    <>
      <div className="head">
        <h1>Deliveries</h1>
        {!active
          ? <button className="primary" onClick={() => setOnline(true)}>Go online</button>
          : <button aria-busy={offline.isPending} disabled={current !== null || offline.isPending} onClick={() => offline.mutate()}>Go offline</button>}
      </div>
      {!!sendError && <ErrorNotice error={sendError} />}
      {offline.isError && <ErrorNotice error={offline.error} />}
      <div className="split">
        <section className="panel" aria-label="Map"><LiveMap markers={markers} /></section>
        <section className="panel" aria-label="Current job">
          <h2>Current job</h2>
          {job.isPending && <Loading />}
          {job.isError && <ErrorNotice error={job.error} retry={() => void job.refetch()} />}
          {job.data && !current && (
            <Empty title={active ? 'Waiting for an order' : 'You are offline'}>
              {active ? 'You get the next accepted order if you are the nearest free courier.' : 'Go online so Delivery Service can find you.'}
            </Empty>
          )}
          {current && (
            <div className="stack">
              <div className="head"><span>Order</span><span className="mono">{current.orderId.slice(0, 8)}</span></div>
              <div className="head"><span>Status</span><span className="status">{current.status}</span></div>
              <div className="head"><span>Food</span><span className="muted">{current.ready ? 'Ready for pickup' : 'Still cooking'}</span></div>
              {current.status === 'ASSIGNED'
                ? <button className="primary" disabled={!current.ready || advance.isPending} onClick={() => advance.mutate('pickup')}>Picked up</button>
                : <button className="primary" disabled={advance.isPending} onClick={() => advance.mutate('deliver')}>Delivered</button>}
              {advance.isError && <ErrorNotice error={advance.error} />}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
