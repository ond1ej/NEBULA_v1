// Remote Access (#/remote): the app gateway used by the Telegram Mini App and the iPhone / Mac apps, how it is reached
// (Tailscale Serve: private, tailnet-only, recommended; Tailscale Funnel / Cloudflare: public Internet, only needed for
// the Telegram Mini App; or your own reverse proxy), bot menu buttons and active Mini App sessions.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { IconArrowRight, IconExternal, IconLock, IconPower, IconRemote, IconShield, IconTelegram } from '../../components/icons';
import { IconGlobe, IconPhone, IconServer } from './icons';
import { ConfirmDialog } from '../../components/Modal';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  KeyValue,
  LoadingRows,
  Mono,
  Notice,
  PageHeader,
  Stat,
  Switch,
  type Column,
} from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { formatTime, relativeTime } from '../../lib/format';
import { PUBLIC_TUNNELS, PUBLIC_URL_RE, remoteApi, type MiniAppSession, type RemoteStatus, type TunnelKind } from './api';

type StartKind = 'tailscale_serve' | 'tailscale_funnel' | 'cloudflared_quick';

const TUNNEL_LABEL: Record<string, string> = {
  none: 'None',
  tailscale_serve: 'Tailscale Serve',
  tailscale_funnel: 'Tailscale Funnel',
  cloudflared_quick: 'Cloudflare quick tunnel',
  custom: 'Custom reverse proxy',
};

// ---------------------------------------------------------------- architecture
function Node({ icon, title, children, tone = 'neutral' }: { icon: ReactNode; title: string; children: ReactNode; tone?: 'neutral' | 'accent' | 'private' }) {
  const ring = tone === 'accent' ? 'border-accent/40 bg-accent/[0.07]' : tone === 'private' ? 'border-success/30 bg-success/[0.05]' : 'border-border bg-panel-2';
  return (
    <div className={`flex min-w-0 flex-1 items-start gap-2.5 rounded-xl border px-3 py-2.5 ${ring}`}>
      <span className="mt-0.5 text-muted [&>svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-text">{title}</p>
        <p className="text-2xs leading-4 text-muted">{children}</p>
      </div>
    </div>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex shrink-0 items-center justify-center gap-1 text-2xs text-subtle md:flex-col">
      <IconArrowRight className="size-4 rotate-90 md:rotate-0" />
      <span>{label}</span>
    </div>
  );
}

function Architecture({ port, tunnel }: { port: number; tunnel: string }) {
  const publicTunnel = PUBLIC_TUNNELS.has(tunnel);
  return (
    <Card
      title="How remote access works"
      subtitle="NEBULA never opens router ports. Its app gateway listens on this Mac only; a tunnel you start decides who can reach it."
      icon={<IconShield />}
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch" role="img" aria-label={`Your phone or another computer connects over HTTPS through a tunnel or reverse proxy to the app gateway on 127.0.0.1:${port}, which forwards signed-in sessions to the local NEBULA API.`}>
        <Node icon={<IconPhone />} title="Your phone or computer">
          The NEBULA iPhone / Mac app, a browser on your tailnet, or Telegram (Mini App).
        </Node>
        <Arrow label="HTTPS" />
        <Node icon={<IconGlobe />} title="Tunnel / reverse proxy">
          Tailscale Serve (private), Tailscale Funnel or Cloudflare (public), or your own proxy. Started by you.
        </Node>
        <Arrow label="loopback" />
        <Node icon={<IconRemote />} title={`App gateway 127.0.0.1:${port}`} tone="accent">
          Verified sign-in, rate limits, strict headers, a route policy.
        </Node>
        <Arrow label="signed-in" />
        <Node icon={<IconServer />} title="NEBULA (this Mac)" tone="private">
          Agents, tasks, files, vault and settings stay on this Mac.
        </Node>
      </div>
      <ul className="mt-4 grid gap-x-6 gap-y-1.5 text-xs text-muted sm:grid-cols-2">
        <li className="flex gap-2">
          <IconLock className="mt-0.5 size-3.5 shrink-0 text-success" />
          The gateway listens on loopback only; nothing is reachable until you start a tunnel.
        </li>
        <li className="flex gap-2">
          <IconLock className="mt-0.5 size-3.5 shrink-0 text-success" />
          Every call needs a short-lived session from signed Telegram data of an approved user, or from a device you paired and approved.
        </li>
        <li className={`flex gap-2 ${publicTunnel ? 'text-warn' : ''}`}>
          <IconShield className="mt-0.5 size-3.5 shrink-0 text-warn" />
          Once the gateway is on, a signed-in owner session can use almost every Dashboard page remotely, including administration. Sensitive changes ask for an extra owner confirmation.
        </li>
        <li className="flex gap-2">
          <IconLock className="mt-0.5 size-3.5 shrink-0 text-success" />
          Stopping the tunnel or disabling the gateway cuts remote access immediately.
        </li>
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------- gateway settings
function GatewayCard({ st, onStatus }: { st: RemoteStatus; onStatus: (s: RemoteStatus) => void }) {
  const ids = { port: useId(), rate: useId() };
  const { run, isPending } = useAction();
  const [port, setPort] = useState(String(st.port));
  const [rate, setRate] = useState(String(st.rate_limit_per_min));
  useEffect(() => {
    setPort(String(st.port));
    setRate(String(st.rate_limit_per_min));
  }, [st.port, st.rate_limit_per_min]);
  const p = Number(port);
  const r = Number(rate);
  const dashboardPort = Number(window.location.port) || null;
  const portErr = !Number.isInteger(p) || p < 1024 || p > 65535 ? 'Use a port between 1024 and 65535' : p === dashboardPort ? 'This is the Dashboard port' : null;
  const rateErr = !Number.isInteger(r) || r < 30 || r > 2000 ? 'Between 30 and 2000 requests per minute' : null;
  const dirty = p !== st.port || r !== st.rate_limit_per_min;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || portErr || rateErr) return;
    const res = await run('save', () => remoteApi.configure({ port: p, rate_limit_per_min: r }), { success: 'Gateway settings saved', errorTitle: 'Could not save the gateway settings' });
    if (res) onStatus(res);
  };

  return (
    <Card title="App gateway" subtitle="The separate server behind remote access: the Telegram Mini App and the iPhone / Mac apps connect to it." icon={<IconRemote />}>
      <div className="space-y-4">
        <Switch
          checked={st.enabled}
          loading={isPending('enabled')}
          label="Enable the app gateway"
          description={`Listens on 127.0.0.1:${st.port} only. Nothing is reachable from outside until a tunnel or proxy points at it.`}
          onChange={async (v) => {
            const res = await run('enabled', () => remoteApi.configure({ enabled: v }), { success: v ? 'Gateway enabled' : 'Gateway disabled', errorTitle: 'Could not change the gateway' });
            if (res) onStatus(res);
          }}
        />
        <KeyValue
          items={[
            [
              'Status',
              st.listening ? (
                <Badge key="s" tone="success" dot>
                  Listening on 127.0.0.1:{st.port}
                </Badge>
              ) : (
                <Badge key="s" tone={st.enabled ? 'danger' : 'neutral'} dot>
                  {st.enabled ? 'Not listening' : 'Off'}
                </Badge>
              ),
            ],
            ['Gateway URL', <Mono key="u" className="break-all text-text">{st.local_url}</Mono>],
          ]}
        />
        {st.last_error && (
          <Notice tone="danger" title="Gateway error">
            <span className="break-words">{st.last_error}</span>
          </Notice>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink size="sm" href="/mini/" target="_blank" rel="noopener noreferrer" icon={<IconExternal />}>
            Local preview (/mini/)
          </ButtonLink>
          <span className="text-xs text-subtle">Opens the Mini App in this browser (outside Telegram it runs in preview mode).</span>
        </div>
        <form onSubmit={save} className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <Field label="Port" htmlFor={ids.port} error={dirty ? portErr : undefined} hint="Default: the Dashboard port + 2. The Dashboard and LAN ports are reserved.">
            <Input id={ids.port} type="number" inputMode="numeric" min={1024} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
          <Field label="Rate limit" htmlFor={ids.rate} error={dirty ? rateErr : undefined} hint="Requests per minute per client and per session.">
            <Input id={ids.rate} type="number" inputMode="numeric" min={30} max={2000} value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button
              onClick={() => {
                setPort(String(st.port));
                setRate(String(st.rate_limit_per_min));
              }}
              disabled={!dirty}
            >
              Reset
            </Button>
            <Button type="submit" variant="primary" loading={isPending('save')} disabledReason={!dirty ? 'No changes' : (portErr ?? rateErr)}>
              Save
            </Button>
          </div>
        </form>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- public address + tunnels
function TunnelOption({
  title,
  available,
  children,
  action,
  badge,
}: {
  title: string;
  available: boolean | null;
  children: ReactNode;
  action?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
          {title}
          {badge}
          {available !== null && (
            <Badge tone={available ? 'success' : 'neutral'} dot>
              {available ? 'Installed' : 'Not installed'}
            </Badge>
          )}
        </p>
        <div className="mt-0.5 text-xs leading-5 text-muted">{children}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}

function PublicAccessCard({ st, onStatus }: { st: RemoteStatus; onStatus: (s: RemoteStatus) => void }) {
  const urlId = useId();
  const { run, isPending } = useAction();
  const [url, setUrl] = useState(st.public_url ?? '');
  const [starting, setStarting] = useState<StartKind | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [understoodAdmin, setUnderstoodAdmin] = useState(false);
  useEffect(() => setUrl(st.public_url ?? ''), [st.public_url]);
  const trimmed = url.trim().replace(/\/+$/, '');
  const urlErr = trimmed && !PUBLIC_URL_RE.test(trimmed) ? 'Enter an https:// origin without a path, e.g. https://nebula.example.com' : null;
  const urlDirty = trimmed !== (st.public_url ?? '');
  const tunnelActive = st.tunnel_running || (st.tunnel !== 'none' && st.tunnel !== 'custom');
  const gatewayOff = !st.enabled ? 'Enable the app gateway first' : null;
  const publicTunnelActive = tunnelActive && PUBLIC_TUNNELS.has(st.tunnel);
  const startingPublic = starting !== null && PUBLIC_TUNNELS.has(starting);
  const closeStart = () => {
    setStarting(null);
    setUnderstood(false);
    setUnderstoodAdmin(false);
  };

  const saveUrl = async (e: FormEvent) => {
    e.preventDefault();
    if (!urlDirty || urlErr) return;
    const body = trimmed ? { public_url: trimmed, tunnel: (st.tunnel === 'none' ? 'custom' : st.tunnel) as TunnelKind } : { public_url: null, tunnel: 'none' as TunnelKind };
    const res = await run('url', () => remoteApi.configure(body), { success: trimmed ? 'Public address saved' : 'Public address removed', errorTitle: 'Could not save the public address' });
    if (res) onStatus(res);
  };

  const startDisabled = (kind: StartKind): string | null => {
    if (gatewayOff) return gatewayOff;
    if ((kind === 'tailscale_funnel' || kind === 'tailscale_serve') && !st.tools.tailscale) return 'Tailscale is not installed';
    if (kind === 'cloudflared_quick' && !st.tools.cloudflared) return 'cloudflared is not installed';
    if (tunnelActive) return 'A tunnel is already running — stop it first';
    return null;
  };

  return (
    <Card title="How it is reached" subtitle="Private over your tailnet (recommended), public on the Internet, or through your own reverse proxy." icon={<IconGlobe />}>
      <div className="space-y-4">
        <KeyValue
          items={[
            ['Address', st.public_mini_url ? (
              <a key="m" href={st.public_mini_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded break-all text-accent-soft hover:underline focus-ring">
                {st.public_mini_url}
                <IconExternal className="size-3.5 shrink-0" />
              </a>
            ) : (
              <span key="m" className="text-muted">Not published</span>
            )],
            [
              'Tunnel',
              <span key="t" className="inline-flex flex-wrap items-center gap-2">
                {TUNNEL_LABEL[st.tunnel] ?? st.tunnel}
                {st.tunnel !== 'none' && (
                  <Badge tone={st.tunnel_running || st.tunnel === 'custom' ? 'success' : 'warn'} dot>
                    {st.tunnel === 'custom' ? 'managed by you' : st.tunnel_running ? 'running' : 'not running'}
                  </Badge>
                )}
              </span>,
            ],
          ]}
        />
        {tunnelActive && (
          <div className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 ${publicTunnelActive ? 'border-warn/30 bg-warn/[0.06]' : 'border-success/30 bg-success/[0.05]'}`}>
            <p className="min-w-0 flex-1 text-sm text-text">
              {publicTunnelActive
                ? `The app gateway is reachable from the Internet through ${TUNNEL_LABEL[st.tunnel] ?? 'a tunnel'}.`
                : `The app gateway is reachable from devices on your tailnet through ${TUNNEL_LABEL[st.tunnel] ?? 'a tunnel'} — not from the public Internet.`}
            </p>
            <Button
              size="sm"
              variant="danger"
              icon={<IconPower />}
              loading={isPending('stop')}
              onClick={async () => {
                const res = await run('stop', () => remoteApi.stopTunnel(), { success: 'Tunnel stopped — the gateway is no longer reachable remotely', errorTitle: 'Could not stop the tunnel' });
                if (res) onStatus(res);
              }}
            >
              Stop tunnel
            </Button>
          </div>
        )}

        <ul className="divide-y divide-border/60 rounded-xl border border-border" aria-label="Tunnel options">
          <TunnelOption
            title="Tailscale Serve"
            available={Boolean(st.tools.tailscale)}
            badge={<Badge tone="success">Recommended · private</Badge>}
            action={
              <Button size="sm" variant="primary" onClick={() => setStarting('tailscale_serve')} disabledReason={startDisabled('tailscale_serve')}>
                Start
              </Button>
            }
          >
            Reachable only from devices signed in to <strong>your tailnet</strong> at a <Mono>https://&lt;machine&gt;.&lt;tailnet&gt;.ts.net</Mono> address. Not on the public Internet. Use it for the
            NEBULA iPhone / Mac apps and for browsers on your tailnet. Telegram Mini Apps cannot open it.
          </TunnelOption>
          <TunnelOption
            title="Tailscale Funnel"
            available={Boolean(st.tools.tailscale)}
            badge={<Badge tone="warn">Public Internet</Badge>}
            action={
              <Button size="sm" onClick={() => setStarting('tailscale_funnel')} disabledReason={startDisabled('tailscale_funnel')}>
                Start
              </Button>
            }
          >
            Stable public <Mono>https://&lt;machine&gt;.&lt;tailnet&gt;.ts.net</Mono> address that <strong>anyone on the Internet can reach</strong>. Only needed for the Telegram Mini App, because Telegram opens
            Mini Apps from public HTTPS addresses only. Needs your Tailscale login and Funnel allowed in your tailnet policy.
          </TunnelOption>
          <TunnelOption
            title="Cloudflare quick tunnel"
            available={Boolean(st.tools.cloudflared)}
            badge={<Badge tone="warn">Public Internet</Badge>}
            action={
              <Button size="sm" onClick={() => setStarting('cloudflared_quick')} disabledReason={startDisabled('cloudflared_quick')}>
                Start
              </Button>
            }
          >
            No account needed. Random public <Mono>https://….trycloudflare.com</Mono> address that changes on every start (re-apply the menu buttons afterwards). For the Telegram Mini App only.
            {!st.tools.cloudflared && ' Install it yourself with: brew install cloudflared'}
          </TunnelOption>
          <TunnelOption title="Custom reverse proxy" available={null}>
            Point your own HTTPS proxy (Caddy, nginx, a VPS…) at <Mono>http://127.0.0.1:{st.port}</Mono> and enter its origin below. Who can reach it is up to your proxy.
          </TunnelOption>
        </ul>

        <form onSubmit={saveUrl} className="space-y-3">
          <Field label="Public URL" htmlFor={urlId} error={urlErr} hint="Filled automatically when a tunnel starts. Origin only, https required.">
            <Input id={urlId} type="url" inputMode="url" placeholder="https://nebula.example.com" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoCapitalize="off" />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            {st.public_url && (
              <Button
                variant="ghost"
                loading={isPending('clear')}
                onClick={async () => {
                  const res = await run('clear', () => remoteApi.configure({ public_url: null, tunnel: 'none' }), { success: 'Public address removed', errorTitle: 'Could not remove the address' });
                  if (res) onStatus(res);
                }}
              >
                Remove address
              </Button>
            )}
            <Button type="submit" variant="primary" loading={isPending('url')} disabledReason={!urlDirty ? 'No changes' : urlErr}>
              Save address
            </Button>
          </div>
        </form>
      </div>

      <ConfirmDialog
        open={starting !== null}
        title={startingPublic ? 'Make the Mini App gateway reachable from the Internet?' : 'Share the app gateway with your tailnet?'}
        confirmLabel={startingPublic ? 'Start tunnel' : 'Start Serve'}
        busyText="Starting…"
        confirmDisabled={startingPublic && !(understood && understoodAdmin) ? 'Confirm that you understand first' : null}
        onCancel={closeStart}
        onConfirm={async () => {
          if (!starting) return;
          const kind = starting;
          const res = await run('start', () => remoteApi.startTunnel(kind), {
            success: (s) => (s.public_url ? `${PUBLIC_TUNNELS.has(kind) ? 'Public' : 'Available on your tailnet'} at ${s.public_url}` : 'Tunnel started — waiting for its address'),
            errorTitle: 'The tunnel could not be started',
          });
          if (res) {
            onStatus(res);
            closeStart();
          }
        }}
      >
        {startingPublic ? (
          <>
            <p>
              Starting <strong>{starting ? TUNNEL_LABEL[starting] : ''}</strong> publishes the NEBULA <strong>app gateway</strong> (127.0.0.1:{st.port}) at a public HTTPS address.{' '}
              <strong>It becomes reachable from the Internet</strong> — anyone who knows the address can reach its sign-in endpoint.
            </p>
            <p>
              <strong>Owner administration becomes reachable through it.</strong> After a successful sign-in, an owner session can use almost every Dashboard page remotely: providers, agents, the Password Vault,
              files and settings. The only protection is the gateway&apos;s sign-in (signed Telegram data of an approved user, or a paired and approved device), its rate limits and the extra owner confirmation for
              sensitive changes. Network location no longer protects it.
            </p>
            <p>Prefer Tailscale Serve unless you need the Telegram Mini App. You can stop the tunnel here at any time.</p>
            <Checkbox checked={understood} onChange={setUnderstood} label="I understand that the Mini App gateway will be reachable from the Internet" />
            <Checkbox checked={understoodAdmin} onChange={setUnderstoodAdmin} label="I understand that owner administration becomes reachable behind the gateway sign-in" />
          </>
        ) : (
          <>
            <p>
              <strong>Tailscale Serve</strong> publishes the NEBULA <strong>app gateway</strong> (127.0.0.1:{st.port}) at an HTTPS address on <strong>your tailnet</strong>. Only devices signed in to your tailnet can
              reach it; it is not reachable from the public Internet.
            </p>
            <p>The NEBULA iPhone / Mac apps and browsers on your tailnet can use it. Everyone still has to sign in (or be paired and approved) first. You can stop it here at any time.</p>
          </>
        )}
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------- menu buttons
function MenuButtonsCard({ st }: { st: RemoteStatus }) {
  const { run, isPending } = useAction();
  const [result, setResult] = useState<Record<string, string> | null>(null);
  const isPublic = Boolean(st.public_mini_url);
  return (
    <Card title="Bot menu buttons" subtitle="The button next to the message field that opens the Mini App." icon={<IconTelegram />}>
      <p className="text-sm text-muted">
        {isPublic
          ? 'Point the main bot and every agent bot at the Mini App (agent bots open their own agent). Re-apply after the public address changes.'
          : 'No public address — applying resets the menu buttons to Telegram’s default.'}
      </p>
      <Button
        className="mt-3"
        size="sm"
        loading={isPending('menu')}
        onClick={async () => {
          const r = await run('menu', () => remoteApi.menuButtons(), { success: isPublic ? 'Menu buttons applied' : 'Menu buttons reset', errorTitle: 'Could not apply the menu buttons' });
          if (r) setResult(r);
        }}
      >
        {isPublic ? 'Apply menu buttons' : 'Reset menu buttons'}
      </Button>
      {result && (
        <ul className="mt-3 divide-y divide-border/60 rounded-xl border border-border text-sm" aria-label="Menu button results">
          {Object.keys(result).length === 0 ? (
            <li className="px-3 py-2 text-muted">No running bot to update.</li>
          ) : (
            Object.entries(result).map(([k, v]) => (
              <li key={k} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="text-text">{k === 'main' ? 'Main NEBULA bot' : <Mono>agent bot {k.slice(0, 8)}</Mono>}</span>
                <Badge tone={v === 'ok' || v === 'reset' ? 'success' : 'danger'}>{v}</Badge>
              </li>
            ))
          )}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- sessions
function SessionsCard({ refreshKey }: { refreshKey: number }) {
  const sessions = useApi((s) => remoteApi.sessions(s), [refreshKey], { pollMs: 60_000 });
  const { run, isPending } = useAction();
  const [confirmAll, setConfirmAll] = useState(false);
  const rows = sessions.data ?? [];
  const active = rows.filter((r) => r.active);

  const columns: Column<MiniAppSession>[] = [
    { key: 'user', header: 'Telegram user', mobile: 'title', cell: (s) => (s.telegram_user_id ? <Mono className="text-text">{s.telegram_user_id}</Mono> : <span className="text-subtle">unknown</span>) },
    { key: 'bot', header: 'Opened from', cell: (s) => (s.bot && s.bot !== 'main' ? <Mono>agent bot {s.bot.slice(0, 8)}</Mono> : 'Main bot') },
    {
      key: 'state',
      header: 'State',
      mobile: 'aside',
      cell: (s) => (
        <Badge tone={s.active ? 'success' : 'neutral'} dot>
          {s.active ? 'Active' : 'Expired'}
        </Badge>
      ),
    },
    { key: 'seen', header: 'Last seen', cell: (s) => <span title={formatTime(s.last_seen_at)}>{relativeTime(s.last_seen_at)}</span> },
    { key: 'exp', header: 'Expires', cell: (s) => <span title={formatTime(s.expires_at)}>{relativeTime(s.expires_at)}</span> },
    {
      key: 'act',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (s) =>
        s.active ? (
          <Button
            size="xs"
            variant="danger"
            loading={isPending(`r-${s.id}`)}
            onClick={async () => {
              const r = await run(`r-${s.id}`, () => remoteApi.revokeSession(s.id), { success: 'Session revoked', errorTitle: 'Could not revoke the session' });
              if (r) sessions.reload();
            }}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <Card
      title="Mini App sessions"
      subtitle="Short-lived sessions created from verified Telegram data. Paired iPhone / Mac apps are listed under Devices."
      actions={
        <Button size="sm" variant="danger" onClick={() => setConfirmAll(true)} disabledReason={active.length === 0 ? 'No active session' : null}>
          Revoke all
        </Button>
      }
      padded={false}
    >
      {sessions.error && !sessions.data ? (
        <div className="p-4">
          <ErrorBanner error={sessions.error} onRetry={sessions.reload} />
        </div>
      ) : !sessions.data ? (
        <div className="p-5">
          <LoadingRows rows={3} />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState compact title="No Mini App sessions">
            Sessions appear when someone opens the Mini App from Telegram.
          </EmptyState>
        </div>
      ) : (
        <div className="p-3 sm:p-4">
          <DataTable columns={columns} rows={rows} rowKey={(s) => s.id} label="Mini App sessions" minWidth={620} dense />
        </div>
      )}
      <ConfirmDialog
        open={confirmAll}
        title="Revoke every Mini App session?"
        confirmLabel="Revoke all"
        onCancel={() => setConfirmAll(false)}
        onConfirm={async () => {
          const r = await run('all', () => remoteApi.revokeAll(), { success: (x) => `${x.revoked} session(s) revoked`, errorTitle: 'Could not revoke the sessions' });
          if (r) {
            setConfirmAll(false);
            sessions.reload();
          }
        }}
      >
        <p>Everyone currently using the Mini App is signed out immediately. They can open it again from Telegram if they are still approved.</p>
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------- page
export function RemoteAccessPage(_props: Record<string, never>) {
  const remote = useApi((s) => remoteApi.status(s), [], { pollMs: 20_000 });
  const [tick, setTick] = useState(0);
  useLiveRefresh(
    () => {
      remote.reload();
      setTick((t) => t + 1);
    },
    (e) => e.type === 'remote.state.changed',
    300,
  );
  const st = remote.data;
  const setStatus = (s: RemoteStatus) => remote.setData(() => s);

  return (
    <>
      <PageHeader
        title="Remote Access"
        icon={<IconRemote className="size-6 text-accent-soft" />}
        description="Reach NEBULA from your phone or another computer: privately over your tailnet with Tailscale Serve (recommended), or on a public address only if you need the Telegram Mini App."
        meta={
          st ? (
            <>
              <Badge tone={st.listening ? 'success' : 'neutral'} dot>
                Gateway {st.listening ? 'listening' : 'off'}
              </Badge>
              <Badge tone={st.tunnel === 'tailscale_serve' && st.public_mini_url ? 'success' : st.public_mini_url ? 'warn' : 'neutral'} dot>
                {st.tunnel === 'tailscale_serve' && st.public_mini_url ? 'Tailnet only' : st.public_mini_url ? 'Public' : 'Not public'}
              </Badge>
            </>
          ) : undefined
        }
      />
      {remote.error && !st ? (
        <ErrorBanner error={remote.error} onRetry={remote.reload} title="Could not load the remote access status" />
      ) : !st ? (
        <LoadingRows rows={6} label="Loading remote access…" />
      ) : (
        <div className="space-y-5">
          <Architecture port={st.port} tunnel={st.tunnel} />
          {st.setup_required && (
            <Notice tone="warn" title="Setup required">
              {st.setup_required}
            </Notice>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="Gateway requests" value={st.stats?.requests ?? '—'} hint={st.stats ? 'Since the gateway started' : 'Gateway not running'} />
            <Stat label="Denied" value={st.stats?.denied ?? '—'} hint="Outside the allow-list or unauthenticated" tone={st.stats?.denied ? 'warn' : undefined} />
            <Stat label="Rate limited" value={st.stats?.rate_limited ?? '—'} hint={`Limit ${st.rate_limit_per_min}/min`} tone={st.stats?.rate_limited ? 'warn' : undefined} />
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <div className="min-w-0 space-y-5">
              <GatewayCard st={st} onStatus={setStatus} />
              <MenuButtonsCard st={st} />
            </div>
            <div className="min-w-0 space-y-5">
              <PublicAccessCard st={st} onStatus={setStatus} />
            </div>
          </div>
          <SessionsCard refreshKey={tick} />
        </div>
      )}
    </>
  );
}
