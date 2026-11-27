// Devices (#/devices, V4.0): the owner's paired NEBULA apps for iPhone and Mac — pair a new one (QR code / link),
// approve or reject devices waiting with their 6-digit code, rename, and remove one (signs it out and deletes its
// vault key). Refreshed on `app.device.changed` events. Reused as is in the Telegram Mini App's administration area
// (#/admin/devices), where pairing and approving ask the owner's confirmation first (403 `stepup_required`).
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { IconCheck, IconEdit, IconPlus, IconX } from '../../components/icons';
import { Badge, Button, ButtonLink, Card, EmptyState, ErrorBanner, IconButton, Input, LoadingRows, Mono, Notice, PageHeader } from '../../components/ui';
import { useApi, useNow } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { t, tp } from '../../i18n';
import { rich } from '../../i18n/rich';
import { formatTime } from '../../lib/format';
import { devicesApi, platformLabel, protectionLabel, relativeAgo, type AppDevice } from './api';
import { IconQr } from './icons';
import { deviceErrorText, PairingDialog, PlatformIcon, VerificationCode } from './PairingDialog';

const deviceEvent = (ev: { type: string }) => ev.type === 'app.device.changed';

function subtitle(d: AppDevice): string {
  return [d.model || platformLabel(d.platform), d.app_version ? `NEBULA ${d.app_version}` : null].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- one paired device
function DeviceRow({ d, now, onRenamed, onRemove }: { d: AppDevice; now: number; onRenamed: (d: AppDevice) => void; onRemove: (d: AppDevice) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!trimmed || saving) return;
    if (trimmed === d.name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const r = await devicesApi.rename(d.id, trimmed);
      onRenamed({ ...d, ...r });
      setEditing(false);
      toast.success(t('devices.renamed'));
    } catch (err) {
      toast.error(new Error(deviceErrorText(err)), t('devices.renameFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:px-5" data-testid="device-row">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-panel-2 text-muted" title={platformLabel(d.platform)}>
        <PlatformIcon platform={d.platform} />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        {editing ? (
          <form className="flex max-w-md gap-2" onSubmit={(e) => void save(e)}>
            <Input
              aria-label={t('devices.nameLabel')}
              value={name}
              maxLength={60}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setName(d.name);
                  setEditing(false);
                }
              }}
            />
            <IconButton type="submit" label={t('devices.saveName')} icon={<IconCheck />} variant="secondary" loading={saving} disabledReason={trimmed ? null : t('devices.nameRequired')} />
            <IconButton
              label={t('devices.cancelRename')}
              icon={<IconX />}
              onClick={() => {
                setName(d.name);
                setEditing(false);
              }}
            />
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-text">{d.name}</p>
            <IconButton
              size="sm"
              label={t('devices.rename', { name: d.name })}
              icon={<IconEdit />}
              onClick={() => {
                setName(d.name);
                setEditing(true);
              }}
            />
          </div>
        )}
        <p className="text-xs text-muted">{subtitle(d)}</p>
        <div className="flex flex-wrap gap-1.5">
          {d.vault_key && <Badge tone="success">{t('devices.badge.vault')}</Badge>}
          <Badge tone="neutral" title={d.key_protection === 'secure_enclave' ? t('devices.protection.secureEnclave.hint') : t('devices.protection.keychain.hint')}>
            {protectionLabel(d.key_protection)}
          </Badge>
          {d.push && <Badge tone="info">{t('devices.badge.push')}</Badge>}
        </div>
        <p className="text-xs text-subtle">
          {t('devices.lastSeen', { when: relativeAgo(d.last_seen_at, now / 1000) })}
          {d.approved_at ? ` · ${t('devices.pairedAt', { when: formatTime(d.approved_at) })}` : ''} · {t('devices.keyLabel')} <Mono>{d.key_fingerprint}</Mono>
        </p>
      </div>
      <Button size="sm" variant="danger" className="self-start" onClick={() => onRemove(d)} aria-label={t('devices.removeAria', { name: d.name })}>
        {t('devices.remove')}
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------- a device waiting for approval
function PendingRow({ d, now, onDecided }: { d: AppDevice; now: number; onDecided: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const decide = async (what: 'approve' | 'reject') => {
    setBusy(what);
    setError(null);
    try {
      if (what === 'approve') {
        await devicesApi.approve(d.id);
        toast.success(t('devices.approved.toast', { name: d.name }), t('devices.approved.body'));
      } else {
        await devicesApi.reject(d.id);
        toast.info(t('devices.rejected.toast', { name: d.name }));
      }
      onDecided();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="grid gap-4 px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(220px,280px)]" data-testid="pending-row">
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-panel-2 text-muted">
            <PlatformIcon platform={d.platform} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text">{d.name}</p>
            <p className="text-xs text-muted">
              {subtitle(d)} · {t('devices.requested', { when: relativeAgo(d.created_at, now / 1000) })}
            </p>
          </div>
        </div>
        <p className="text-sm text-muted">{t('devices.approveWarn')}</p>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {deviceErrorText(error)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" loading={busy === 'approve'} disabled={busy !== null} onClick={() => void decide('approve')} aria-label={t('devices.approveAria', { name: d.name })}>
            {t('devices.approve')}
          </Button>
          <Button variant="danger" size="sm" loading={busy === 'reject'} disabled={busy !== null} onClick={() => void decide('reject')} aria-label={t('devices.rejectAria', { name: d.name })}>
            {t('devices.reject')}
          </Button>
        </div>
      </div>
      <VerificationCode device={d} />
    </li>
  );
}

// ---------------------------------------------------------------- remove
function RemoveDialog({ device, onCancel, onRemoved }: { device: AppDevice | null; onCancel: () => void; onRemoved: (d: AppDevice) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const remove = async () => {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      const r = await devicesApi.revoke(device.id);
      toast.success(t('devices.remove.toast', { name: device.name }), r.sessions_ended ? t('devices.remove.sessions', { n: r.sessions_ended }) : undefined);
      onRemoved(device);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={device !== null}
      title={t('devices.remove.title', { name: device?.name ?? t('devices.remove.fallbackName') })}
      onClose={() => {
        setError(null);
        onCancel();
      }}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy} data-autofocus>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            {t('devices.remove')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-muted">
        <p>{rich('devices.remove.body1')}</p>
        <p>{t('devices.remove.body2')}</p>
        {error ? (
          <p role="alert" className="text-danger">
            {deviceErrorText(error)}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- page
export function DevicesPage() {
  const list = useApi((s) => devicesApi.list(s), []);
  useLiveRefresh(list.reload, deviceEvent);
  const now = useNow(30_000);
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<AppDevice | null>(null);
  const data = list.data;
  const pending = (data?.devices ?? []).filter((d) => d.status === 'pending');
  const active = (data?.devices ?? []).filter((d) => d.status === 'active');
  const patch = (d: AppDevice) => list.setData((x) => (x ? { ...x, devices: x.devices.map((y) => (y.id === d.id ? d : y)) } : x));

  return (
    <>
      <PageHeader
        title={t('devices.title')}
        description={t('devices.description')}
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={() => setPairing(true)}>
            {t('devices.pair')}
          </Button>
        }
      />
      <div className="space-y-5">
        {data && !data.gateway_url && (
          <Notice
            tone="warn"
            title={t('devices.gatewayOff.title')}
            action={
              <ButtonLink size="sm" href={href('/remote')}>
                {t('devices.gatewayOff.action')}
              </ButtonLink>
            }
          >
            {t('devices.gatewayOff.body')}
          </Notice>
        )}
        {list.error && !data ? <ErrorBanner error={list.error} onRetry={list.reload} title={t('devices.loadError')} /> : null}
        {!data && !list.error && <LoadingRows rows={3} label={t('devices.loading')} />}

        {pending.length > 0 && (
          <Card title={t('devices.pending.title')} subtitle={t('devices.pending.subtitle')} padded={false}>
            <ul className="divide-y divide-border" aria-label={t('devices.pending.aria')}>
              {pending.map((d) => (
                <PendingRow key={d.id} d={d} now={now} onDecided={list.reload} />
              ))}
            </ul>
          </Card>
        )}

        {data && (
          <Card title={t('devices.paired.title')} subtitle={active.length ? tp('devices.paired.count', active.length) : undefined} padded={false}>
            {active.length ? (
              <ul className="divide-y divide-border" aria-label={t('devices.paired.aria')}>
                {active.map((d) => (
                  <DeviceRow key={d.id} d={d} now={now} onRenamed={patch} onRemove={setRemoving} />
                ))}
              </ul>
            ) : (
              <div className="p-4 sm:p-5">
                <EmptyState
                  title={t('devices.empty.title')}
                  icon={<IconQr />}
                  action={
                    <Button variant="primary" icon={<IconPlus />} onClick={() => setPairing(true)}>
                      {t('devices.pair')}
                    </Button>
                  }
                >
                  {t('devices.empty.body')}
                </EmptyState>
              </div>
            )}
          </Card>
        )}

        {data && (
          <p className="text-xs text-subtle">
            {t('devices.fingerprint.before')} <Mono>{data.server_fingerprint}</Mono> {t('devices.fingerprint.after')}
          </p>
        )}
      </div>

      {pairing && (
        <PairingDialog
          onClose={() => {
            setPairing(false);
            list.reload();
          }}
          onDone={() => {
            setPairing(false);
            list.reload();
          }}
        />
      )}
      <RemoveDialog
        device={removing}
        onCancel={() => setRemoving(null)}
        onRemoved={(d) => {
          setRemoving(null);
          list.setData((x) => (x ? { ...x, devices: x.devices.filter((y) => y.id !== d.id) } : x));
          list.reload();
        }}
      />
    </>
  );
}
