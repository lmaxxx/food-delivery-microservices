import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, StrictMode, useContext, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { loadSession, Role, saveSession, Session } from './api';
import { closeSocket } from './live';
import { CourierPage } from './pages/courier';
import { BrowsePage, OrderPage, OrdersPage, RestaurantPage } from './pages/customer';
import { EventsPage } from './pages/events';
import { KitchenPage } from './pages/kitchen';
import { LoginPage } from './pages/login';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const SessionContext = createContext<{ session: Session | null; setSession: (s: Session | null) => void }>({
  session: null,
  setSession: () => {},
});
export const useSession = () => useContext(SessionContext);

const HOME: Record<Role, string> = { CUSTOMER: '/', COURIER: '/courier', RESTAURANT: '/kitchen' };

const NAV: Record<Role, [string, string][]> = {
  CUSTOMER: [['/', 'Restaurants'], ['/orders', 'My orders']],
  RESTAURANT: [['/kitchen', 'Kitchen']],
  COURIER: [['/courier', 'Deliveries']],
};

function App() {
  const [session, setStored] = useState(loadSession);
  const value = useMemo(() => ({
    session,
    setSession: (next: Session | null) => {
      saveSession(next);
      closeSocket();
      queryClient.clear();
      setStored(next);
    },
  }), [session]);

  if (!session) return (
    <SessionContext.Provider value={value}>
      <main><LoginPage /></main>
    </SessionContext.Provider>
  );

  const { role, email } = session.user;
  return (
    <SessionContext.Provider value={value}>
      <header className="bar">
        <Link className="brand" to={HOME[role]}>Food delivery console</Link>
        <nav aria-label="Main">
          {NAV[role].map(([to, label]) => <NavLink key={to} to={to} end>{label}</NavLink>)}
          <NavLink to="/events">Event stream</NavLink>
        </nav>
        <span className="who">{email}</span>
        <button onClick={() => value.setSession(null)}>Sign out</button>
      </header>
      <main>
        <Routes>
          {role === 'CUSTOMER' && <>
            <Route path="/" element={<BrowsePage />} />
            <Route path="/restaurants/:id" element={<RestaurantPage />} />
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/orders/:id" element={<OrderPage />} />
          </>}
          {role === 'RESTAURANT' && <Route path="/kitchen" element={<KitchenPage />} />}
          {role === 'COURIER' && <Route path="/courier" element={<CourierPage />} />}
          <Route path="/events" element={<EventsPage />} />
          <Route path="*" element={<Navigate to={HOME[role]} replace />} />
        </Routes>
      </main>
    </SessionContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter><App /></BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
