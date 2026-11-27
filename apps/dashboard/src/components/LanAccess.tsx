import { useState } from 'react';
import { api } from '../api';
import { useAction, useApi } from '../hooks/useApi';
import { authedLinkProps } from '../lib/authedUrl';
import type { LanStatus } from '../types';
import { useToast } from './Toast';
import { IconCopy, IconWifi } from './icons';
import { Badge, Button, Card, Checkbox, ErrorBanner, KeyValue, LoadingRows, Mono, Notice } from './ui';

export const isLoopbackHost = (): boolean => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname);

function CopyUrl({ url }: { url: string }) {
  const toast = useToast();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a href={url} className="rounded font-mono text-[13px] break-all text-accent-soft underline-offset-2 hover:underline focus-ring">
        {url}
      </a>
      <Button
        size="xs"
        variant="ghost"
        icon={<IconCopy />}
        onClick={() => {
          navigator.clipboard?.writeText(url).then(
            () => toast.success('Copied', url),
            () => toast.error(new Error('Clipboard not available in this browser'), 'Copy failed'),
          );
        }}
      >
        Copy
      </Button>
    </span>
  );
}

/** Settings card: LAN Access enable/disable, HTTPS option, addresses for other devices, CA download. */
export function LanAccessCard() {
  const toast = useToast();
  const status = useApi(() => api.system.lan(), []);
  const { run, isPending } = useAction();
  const [confirmOff, setConfirmOff] = useState(false);
  const s = status.data;
  const viaLan = s?.this_request ? !s.this_request.via_loopback : !isLoopbackHost();

  const apply = async (body: { enabled: boolean; https?: boolean }, key: string) => {
    const r = await run(key, () => api.system.setLan(body), {
      success: body.enabled ? 'LAN access settings saved' : 'LAN access disabled',
      errorTitle: 'LAN access not changed',
    });
    if (r) status.reload();
  };

  return (
    <Card
      icon={<IconWifi />}
      title="LAN Access"
      subtitle="Open this dashboard from other devices on your local network (MacBook, iPhone, Windows PC). Off by default; never exposed to the internet."
    >
      {status.error && !s ? (
        <ErrorBanner error={status.error} onRetry={status.reload} />
      ) : !s ? (
        <LoadingRows rows={3} label="Loading LAN status…" />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={s.enabled ? 'success' : 'neutral'} dot>
              {s.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            {s.enabled ? (
              viaLan && !confirmOff ? (
                <Button size="sm" variant="danger" onClick={() => setConfirmOff(true)}>
                  Disable LAN access
                </Button>
              ) : (
                <Button size="sm" variant="danger" loading={isPending('off')} onClick={() => apply({ enabled: false }, 'off')}>
                  {viaLan ? 'Confirm: disconnect this device and disable' : 'Disable LAN access'}
                </Button>
              )
            ) : (
              <Button size="sm" variant="primary" loading={isPending('on')} onClick={() => apply({ enabled: true }, 'on')}>
                Enable LAN access
              </Button>
            )}
          </div>

          {s.enabled && (
            <>
              <div className="space-y-2">
                <h3 className="text-2xs font-semibold tracking-wider text-subtle uppercase">Open on another device</h3>
                {s.addresses.length === 0 ? (
                  <Notice tone="warn">No local network address right now (Wi-Fi/Ethernet not connected). NEBULA starts listening automatically when the network comes back.</Notice>
                ) : (
                  <ul className="space-y-2">
                    {s.addresses.map((a) => (
                      <li key={a.ip} className="space-y-1">
                        <CopyUrl url={a.http_url} />
                        {a.https_url && (
                          <div>
                            <CopyUrl url={a.https_url} />
                          </div>
                        )}
                        <p className="text-xs text-muted">
                          Interface {a.iface}, network {a.network}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {s.mdns_urls.length > 0 && (
                  <p className="text-xs text-muted">
                    Also works by name on Apple devices: {s.mdns_urls.map((u) => <Mono key={u} className="mr-2">{u}</Mono>)}
                  </p>
                )}
              </div>

              <Checkbox
                label={`Also serve HTTPS on port ${s.https_port} (recommended)`}
                description="Encrypts the dashboard on Wi-Fi with a NEBULA local certificate authority. Install its certificate once on each device; it is restricted to local addresses only."
                checked={s.https}
                disabled={isPending('https')}
                onChange={(v) => apply({ enabled: true, https: v }, 'https')}
              />
              {s.https && s.ca && (
                <div className="space-y-2 rounded-xl border border-border p-3.5">
                  <a className="rounded text-sm text-accent-soft underline-offset-2 hover:underline focus-ring" {...authedLinkProps('/api/v1/system/lan/ca.crt', 'nebula-local-ca.crt', (e) => toast.error(e, 'Could not download the certificate'))}>
                    Download NEBULA local CA certificate
                  </a>
                  <KeyValue items={[['CA', s.ca.subject], ['SHA-256', <Mono key="fp" className="break-all text-[11px]">{s.ca.sha256}</Mono>]]} />
                  <p className="text-xs text-muted">
                    iPhone/iPad: open the download, Settings → Profile Downloaded → Install, then Settings → General → About → Certificate Trust Settings → enable
                    it. macOS: open the file in Keychain Access → Always Trust. Windows: import into “Trusted Root Certification Authorities”. Compare the
                    SHA-256 fingerprint before trusting it.
                  </p>
                </div>
              )}

              {!s.https && (
                <Notice tone="warn" title="Plain HTTP on your network">
                  Without HTTPS, your password and session travel unencrypted over Wi-Fi. Use LAN access only on a network you trust, or enable HTTPS above.
                </Notice>
              )}
              <Notice tone="info">
                Only devices in your local network subnet can connect. The agents’ virtual machine and VPN peers are blocked. “Continue with ChatGPT”
                must be started on the Mac mini itself (OpenAI only allows a 127.0.0.1 callback); the connection then works from every device.
              </Notice>
              {s.last_error && <Notice tone="danger">{s.last_error}</Notice>}
            </>
          )}
          <p className="text-xs text-muted">
            On this Mac: <Mono>{s.loopback_url}</Mono> always works. The setting is stored in config.yaml and survives restarts.
          </p>
        </div>
      )}
    </Card>
  );
}

/** Compact line for the Overview page. */
export function LanAddressLine({ status }: { status: LanStatus | null }) {
  if (!status) return null;
  if (!status.enabled) return <p className="text-sm text-muted">LAN access is off — enable it in Settings to use NEBULA from other devices.</p>;
  if (status.addresses.length === 0) return <p className="text-sm text-muted">LAN access is on, waiting for a network address.</p>;
  return (
    <div className="space-y-1">
      {status.addresses.map((a) => (
        <div key={a.ip} className="space-y-1">
          <CopyUrl url={a.http_url} />
          {a.https_url && (
            <div>
              <CopyUrl url={a.https_url} />
              <p className="text-xs text-muted">HTTPS needs the NEBULA local CA installed on the device (Settings → LAN Access).</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
