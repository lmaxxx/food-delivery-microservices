import { useMutation } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { post, Session } from '../api';
import { useSession } from '../main';
import { ErrorNotice } from '../ui';

const DEMO_PASSWORD = 'demo1234';
const DEMOS = [
  ['Customer', 'customer@demo.com'],
  ['Courier', 'courier@demo.com'],
  ['Forno Kyiv kitchen', 'pizza@demo.com'],
  ['Dnipro Sushi kitchen', 'sushi@demo.com'],
];

export function LoginPage() {
  const { setSession } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: (input: { email: string; password: string }) => post<Session>('/auth/login', input),
    onSuccess: setSession,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ email, password });
  };

  return (
    <div className="panel login">
      <h1>Sign in</h1>
      <p className="muted">Use one browser window per role to follow an order through the system.</p>
      <div className="row">
        {DEMOS.map(([label, demoEmail]) => (
          <button key={demoEmail} disabled={login.isPending} onClick={() => login.mutate({ email: demoEmail, password: DEMO_PASSWORD })}>
            {label}
          </button>
        ))}
      </div>
      <form className="stack" onSubmit={submit}>
        <label>Email<input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button className="primary" aria-busy={login.isPending} disabled={login.isPending}>Sign in</button>
      </form>
      {login.isError && <ErrorNotice error={login.error} />}
    </div>
  );
}
