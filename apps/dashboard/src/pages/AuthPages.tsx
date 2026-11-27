import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api, setCsrfToken } from '../api';
import { useToast } from '../components/Toast';
import { IconLock } from '../components/icons';
import { BrandMark } from '../components/SideNav';
import { Button, ErrorBanner, Field, Input, Notice } from '../components/ui';
import type { LoginResult } from '../types';
import { MIN_PASSWORD } from './passwordPolicy';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  const local = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname);
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg px-4 py-10 pt-safe pb-safe">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_60%_at_50%_0%,rgb(110_95_240/0.16),transparent_70%)]"
      />
      <div className="relative w-full max-w-[400px]">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-11" />
          <span className="text-sm font-semibold tracking-[0.2em] text-text">NEBULA</span>
        </div>
        <div className="rounded-2xl border border-border-strong bg-panel p-6 shadow-overlay sm:p-7">
          <h1 className="text-lg font-semibold tracking-tight text-text">{title}</h1>
          <p className="mt-1 mb-6 text-sm text-muted">{subtitle}</p>
          {children}
        </div>
        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-subtle">
          <IconLock className="size-3.5" />
          {local ? 'Local dashboard · served on this Mac (127.0.0.1)' : `Local-network access · ${window.location.host} · only devices on your LAN can connect`}
        </p>
      </div>
    </div>
  );
}

export { MIN_PASSWORD };

export function SetupPage({ initialToken, onDone }: { initialToken: string | null; onDone: (r: LoginResult) => void }) {
  const ids = { user: useId(), pw: useId(), pw2: useId(), token: useId() };
  const toast = useToast();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState(initialToken ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);

  const pwError = password.length > 0 && password.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters` : null;
  const confirmError = confirm.length > 0 && confirm !== password ? 'Passwords do not match' : null;
  const invalid = !username.trim() || password.length < MIN_PASSWORD || confirm !== password || !token.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.setup(username.trim(), password, token.trim());
      setCsrfToken(r.csrf_token);
      toast.success('Administrator created', `Signed in as ${r.user.username}`);
      onDone(r);
    } catch (err) {
      setError(err);
      toast.error(err, 'Setup failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="First-run setup" subtitle="Create the local administrator account for this NEBULA installation.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {!initialToken && (
          <Notice tone="warn" title="Setup token missing">
            Open the link printed by <code>nebula setup-url</code> (it contains <code>#/setup?token=…</code>) or paste the token from the setup-token file in the NEBULA run directory.
          </Notice>
        )}
        <Field htmlFor={ids.token} label="Setup token" required error={touched && !token.trim() ? 'Required' : null}>
          <Input id={ids.token} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field htmlFor={ids.user} label="Username" required error={touched && !username.trim() ? 'Required' : null}>
          <Input id={ids.user} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" maxLength={64} />
        </Field>
        <Field htmlFor={ids.pw} label="Password" required hint={`At least ${MIN_PASSWORD} characters. Stored as an Argon2id hash.`} error={pwError}>
          <Input id={ids.pw} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field htmlFor={ids.pw2} label="Confirm password" required error={confirmError ?? (touched && !confirm ? 'Required' : null)}>
          <Input id={ids.pw2} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        {error ? <ErrorBanner error={error} title="Setup failed" /> : null}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Create administrator
        </Button>
      </form>
    </AuthShell>
  );
}

export function LoginPage({ onDone }: { onDone: (r: LoginResult) => void }) {
  const ids = { user: useId(), pw: useId() };
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.login(username.trim(), password);
      setCsrfToken(r.csrf_token);
      setPassword('');
      onDone(r);
    } catch (err) {
      setError(err);
      toast.error(err, 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Use the local administrator account of this Mac’s NEBULA installation.">
      <form onSubmit={submit} className="space-y-4">
        <Field htmlFor={ids.user} label="Username" required>
          <Input id={ids.user} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </Field>
        <Field htmlFor={ids.pw} label="Password" required>
          <Input id={ids.pw} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        {error ? <ErrorBanner error={error} title="Sign-in failed" /> : null}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabledReason={!username || !password ? 'Enter username and password' : null}>
          Sign in
        </Button>
        <p className="text-center text-xs text-subtle">Forgot the password? Run <code className="text-muted">nebula reset-password</code> on this Mac.</p>
      </form>
    </AuthShell>
  );
}
