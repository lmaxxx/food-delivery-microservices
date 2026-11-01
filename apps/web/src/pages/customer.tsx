import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, LiveEvent, money, Order, Point, post, Restaurant, time } from '../api';
import { useLiveEvents, useRefreshOnStatusChange } from '../live';
import { Empty, ErrorNotice, LiveMap, Loading, Marker, UrlInput } from '../ui';

const restaurantId = (r: Restaurant) => r.id ?? r.restaurantId!;

export function BrowsePage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  // Reads from Elasticsearch through the Search Indexer: a read model, not the Restaurants DB.
  const results = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<Restaurant[]>(`/search?q=${encodeURIComponent(q)}`),
  });
  return (
    <>
      <div className="head">
        <h1>Restaurants</h1>
        <label style={{ flex: '1 1 260px', maxWidth: 420 }}>
          Search by name, cuisine or dish
          <UrlInput type="search" value={q} placeholder="Try margerita, typo included" onCommit={(value) => setParams(value ? { q: value } : {}, { replace: true })} />
        </label>
      </div>
      {results.isPending && <div className="panel"><Loading /></div>}
      {results.isError && <ErrorNotice error={results.error} retry={() => void results.refetch()} />}
      {results.data?.length === 0 && (
        <div className="panel"><Empty title="Nothing matches that search"><button onClick={() => setParams({})}>Clear search</button></Empty></div>
      )}
      <div className="cards">
        {results.data?.map((r) => (
          <Link className="panel card" key={restaurantId(r)} to={`/restaurants/${restaurantId(r)}`}>
            <h2>{r.name}</h2>
            <span className="muted">{r.cuisine}</span>
            <span className="muted">{r.menu.map((m) => m.name).join(', ')}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

const DEFAULT_DELIVERY = { address: 'Khreshchatyk 1, Kyiv', lat: 50.4475, lng: 30.5222 };

export function RestaurantPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const restaurant = useQuery({ queryKey: ['restaurant', id], queryFn: () => api<Restaurant>(`/restaurants/${id}`) });
  const [cart, setCart] = useState<Record<string, number>>({});
  const [address, setAddress] = useState(DEFAULT_DELIVERY.address);
  const [cardWillFail, setCardWillFail] = useState(false);
  // Same key for every retry of this checkout: a double click cannot create two orders.
  const idempotencyKey = useRef(crypto.randomUUID());

  const place = useMutation({
    mutationFn: () => post<Order>('/orders', {
      restaurantId: id,
      items: Object.entries(cart).map(([menuItemId, quantity]) => ({ menuItemId, quantity })),
      delivery: { ...DEFAULT_DELIVERY, address },
      cardWillFail,
    }, { 'idempotency-key': idempotencyKey.current }),
    onSuccess: (order) => {
      void client.invalidateQueries({ queryKey: ['orders'] });
      navigate(`/orders/${order.id}`);
    },
  });

  const change = (itemId: string, delta: number) => setCart((current) => {
    const quantity = (current[itemId] ?? 0) + delta;
    const { [itemId]: _removed, ...rest } = current;
    return quantity > 0 ? { ...current, [itemId]: quantity } : rest;
  });

  if (restaurant.isPending) return <div className="panel"><Loading rows={5} /></div>;
  if (restaurant.isError) return <ErrorNotice error={restaurant.error} retry={() => void restaurant.refetch()} />;

  const menu = restaurant.data.menu;
  const total = menu.reduce((sum, item) => sum + item.priceCents * (cart[item.id] ?? 0), 0);
  const submit = (event: FormEvent) => { event.preventDefault(); place.mutate(); };

  return (
    <>
      <div className="head"><h1>{restaurant.data.name}</h1><span className="muted">{restaurant.data.cuisine}</span></div>
      <div className="split">
        <div className="panel flush">
          <table>
            <thead><tr><th>Dish</th><th className="num">Price</th><th className="num">Quantity</th></tr></thead>
            <tbody>
              {menu.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}<div className="muted">{item.description}</div></td>
                  <td className="num mono">{money(item.priceCents)}</td>
                  <td className="num">
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button aria-label={`Remove one ${item.name}`} disabled={!cart[item.id]} onClick={() => change(item.id, -1)}>-</button>
                      <span className="mono">{cart[item.id] ?? 0}</span>
                      <button aria-label={`Add one ${item.name}`} onClick={() => change(item.id, 1)}>+</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="panel" onSubmit={submit}>
          <h2>Checkout</h2>
          <label>Delivery address<input required value={address} onChange={(e) => setAddress(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={cardWillFail} onChange={(e) => setCardWillFail(e.target.checked)} />Simulate a declined card</label>
          <div className="head"><span>Total</span><span className="mono">{money(total)}</span></div>
          <button className="primary" aria-busy={place.isPending} disabled={total === 0 || place.isPending}>Place order</button>
          {place.isError && <ErrorNotice error={place.error} />}
        </form>
      </div>
    </>
  );
}

export function OrdersPage() {
  useRefreshOnStatusChange(['orders']);
  const orders = useQuery({ queryKey: ['orders'], queryFn: () => api<Order[]>('/orders') });
  return (
    <>
      <h1>My orders</h1>
      <div className="panel flush">
        {orders.isPending && <Loading />}
        {orders.isError && <ErrorNotice error={orders.error} retry={() => void orders.refetch()} />}
        {orders.data?.length === 0 && <Empty title="No orders yet"><Link className="button" to="/">Browse restaurants</Link></Empty>}
        {!!orders.data?.length && (
          <table>
            <thead><tr><th>Order</th><th>Placed</th><th>Status</th><th className="num">Total</th></tr></thead>
            <tbody>
              {orders.data.map((o) => (
                <tr key={o.id}>
                  <td className="mono"><Link to={`/orders/${o.id}`}>{o.id.slice(0, 8)}</Link></td>
                  <td className="mono">{time(o.createdAt)}</td>
                  <td><span className={`status ${o.status}`}>{o.status}</span></td>
                  <td className="num mono">{money(o.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const HAPPY_PATH = ['PENDING_PAYMENT', 'PAID', 'ACCEPTED', 'COURIER_ASSIGNED', 'READY', 'PICKED_UP', 'DELIVERED'];
const WAITING_FOR: Record<string, string> = {
  PENDING_PAYMENT: 'Payment Service charges the card',
  PAID: 'The restaurant accepts or rejects',
  ACCEPTED: 'Delivery Service searches for a courier',
  COURIER_ASSIGNED: 'Food is cooked, then the courier picks it up',
  READY: 'The courier picks up the food',
  PICKED_UP: 'The courier delivers',
  DELIVERED: 'Delivered',
};

/** The signature: an order's real saga history, followed by the steps still ahead. */
function SagaLedger({ order }: { order: Order }) {
  const failed = order.status === 'REFUNDING' || order.status === 'CANCELLED';
  const reached = new Set(order.history.map((h) => h.status));
  const ahead = failed ? [] : HAPPY_PATH.filter((step) => !reached.has(step));
  return (
    <ol className="ledger">
      {order.history.map((entry, index) => {
        const last = index === order.history.length - 1;
        const bad = entry.status === 'REFUNDING' || entry.status === 'CANCELLED';
        return (
          <li key={`${entry.status}-${entry.at}`} className={bad ? 'failed' : last ? 'current' : ''}>
            <span className="mono">{time(entry.at)}</span>
            <div>
              <div className="step">{entry.status}</div>
              {entry.reason && <div className="muted">{entry.reason}</div>}
              {last && !failed && order.status !== 'DELIVERED' && <div className="muted">Waiting: {WAITING_FOR[entry.status]}</div>}
              {order.status === 'REFUNDING' && last && <div className="muted">Waiting: Payment Service confirms the refund</div>}
            </div>
          </li>
        );
      })}
      {ahead.map((step) => (
        <li key={step} className="pending"><span className="mono">Ahead</span><div className="step">{step}</div></li>
      ))}
    </ol>
  );
}

export function OrderPage() {
  const { id = '' } = useParams();
  useRefreshOnStatusChange(['order', id], ['orders']);
  const order = useQuery({ queryKey: ['order', id], queryFn: () => api<Order>(`/orders/${id}`) });
  const [courier, setCourier] = useState<Point | null>(null);
  useLiveEvents(useCallback((event: LiveEvent) => {
    if (event.type === 'courier.location' && event.payload.orderId === id) {
      setCourier({ lat: event.payload.lat!, lng: event.payload.lng! });
    }
  }, [id]));

  const markers = useMemo<Marker[]>(() => {
    if (!order.data) return [];
    const list: Marker[] = [{ lat: order.data.deliveryLat, lng: order.data.deliveryLng, label: 'Delivery address', tone: '--color-ink' }];
    if (courier) list.push({ ...courier, label: 'Courier', tone: '--color-accent' });
    return list;
  }, [order.data?.deliveryLat, order.data?.deliveryLng, courier]);

  if (order.isPending) return <div className="panel"><Loading rows={6} /></div>;
  if (order.isError) return <ErrorNotice error={order.error} retry={() => void order.refetch()} />;
  const data = order.data;
  return (
    <>
      <div className="head">
        <h1>Order <span className="mono">{data.id.slice(0, 8)}</span></h1>
        <span className={`status ${data.status}`}>{data.status}</span>
      </div>
      <div className="split">
        <section className="panel" aria-label="Saga steps"><h2>Saga</h2><SagaLedger order={data} /></section>
        <div className="stack">
          <section className="panel" aria-label="Courier location">
            <h2>Courier</h2>
            <LiveMap markers={markers} />
            {!courier && <span className="muted">The courier appears here when they send a location.</span>}
          </section>
          <section className="panel">
            <h2>Items</h2>
            {data.items.map((item) => (
              <div className="head" key={item.menuItemId}><span>{item.quantity} x {item.name}</span><span className="mono">{money(item.priceCents * item.quantity)}</span></div>
            ))}
            <div className="head"><strong>Total</strong><span className="mono">{money(data.totalCents)}</span></div>
            <span className="muted">{data.deliveryAddress}</span>
          </section>
        </div>
      </div>
    </>
  );
}
