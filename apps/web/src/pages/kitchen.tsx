import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, money, post, Restaurant, Ticket, time } from '../api';
import { useRefreshOnStatusChange } from '../live';
import { useSession } from '../main';
import { Empty, ErrorNotice, Loading } from '../ui';

function PriceEditor({ item }: { item: Restaurant['menu'][number] }) {
  const client = useQueryClient();
  const [value, setValue] = useState((item.priceCents / 100).toFixed(2));
  const cents = Math.round(Number(value) * 100);
  const valid = Number.isFinite(cents) && cents > 0;
  const save = useMutation({
    mutationFn: () => api(`/restaurants/menu/${item.id}`, { method: 'PATCH', body: JSON.stringify({ priceCents: cents }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['my-restaurant'] }),
  });
  return (
    <tr>
      <td>{item.name}</td>
      <td className="num mono">{money(item.priceCents)}</td>
      <td>
        <div className="row">
          <input className="price mono" aria-label={`New price for ${item.name}`} aria-invalid={!valid} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
          <button aria-busy={save.isPending} disabled={!valid || cents === item.priceCents || save.isPending} onClick={() => save.mutate()}>Save</button>
        </div>
        {save.isError && <ErrorNotice error={save.error} />}
      </td>
    </tr>
  );
}

export function KitchenPage() {
  const { session } = useSession();
  const client = useQueryClient();
  useRefreshOnStatusChange(['tickets']);
  const tickets = useQuery({ queryKey: ['tickets'], queryFn: () => api<Ticket[]>('/kitchen/tickets'), refetchInterval: 5000 });
  const restaurant = useQuery({
    queryKey: ['my-restaurant'],
    queryFn: () => api<Restaurant>(`/restaurants/${session!.user.restaurantId}`),
  });
  const act = useMutation({
    mutationFn: ({ orderId, action }: { orderId: string; action: 'accept' | 'reject' | 'ready' }) =>
      post(`/kitchen/tickets/${orderId}/${action}`),
    onSettled: () => client.invalidateQueries({ queryKey: ['tickets'] }),
  });

  return (
    <>
      <h1>{restaurant.data?.name ?? 'Kitchen'}</h1>
      {act.isError && <ErrorNotice error={act.error} />}
      <section className="panel flush" aria-label="Tickets">
        {tickets.isPending && <Loading />}
        {tickets.isError && <ErrorNotice error={tickets.error} retry={() => void tickets.refetch()} />}
        {tickets.data?.length === 0 && <Empty title="No open tickets">Paid orders for this restaurant appear here. Place one from a customer window.</Empty>}
        {!!tickets.data?.length && (
          <table>
            <thead><tr><th>Order</th><th>Received</th><th>Items</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {tickets.data.map((t) => (
                <tr key={t.orderId}>
                  <td className="mono">{t.orderId.slice(0, 8)}</td>
                  <td className="mono">{time(t.createdAt)}</td>
                  <td>{t.items.map((i) => `${i.quantity} x ${i.name}`).join(', ')}<div className="muted">{t.address}</div></td>
                  <td><span className="status">{t.status}</span></td>
                  <td>
                    <div className="row">
                      {t.status === 'NEW' && <>
                        <button className="primary" disabled={act.isPending} onClick={() => act.mutate({ orderId: t.orderId, action: 'accept' })}>Accept</button>
                        <button className="danger" disabled={act.isPending} onClick={() => act.mutate({ orderId: t.orderId, action: 'reject' })}>Reject</button>
                      </>}
                      {t.status === 'ACCEPTED' && <button className="primary" disabled={act.isPending} onClick={() => act.mutate({ orderId: t.orderId, action: 'ready' })}>Mark ready</button>}
                      {t.status === 'READY' && <span className="muted">Waiting for courier</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="stack" aria-label="Menu prices">
        <h2>Menu prices</h2>
        <p className="muted">Saving publishes restaurant.updated. Order Service and search update from that event.</p>
        <div className="panel flush">
          {restaurant.isPending && <Loading />}
          {restaurant.isError && <ErrorNotice error={restaurant.error} retry={() => void restaurant.refetch()} />}
          {restaurant.data && (
            <table>
              <thead><tr><th>Dish</th><th className="num">Current</th><th>New price</th></tr></thead>
              <tbody>{restaurant.data.menu.map((item) => <PriceEditor key={item.id} item={item} />)}</tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}
