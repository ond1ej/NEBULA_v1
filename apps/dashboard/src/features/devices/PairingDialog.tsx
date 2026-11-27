// "Pair an iPhone or Mac": a 5-minute, single-use pairing offer — the QR code (an <img> of the host's SVG, never
// inserted as markup), the link for a Mac, the countdown — polled every 2 s while the dialog is open (and at once on an
// `app.device.changed` event). When an app claims it, the owner compares the 6-digit code on both screens and approves
// or rejects. Closing the dialog cancels an offer nobody claimed. The code / link lives only in this dialog's state.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { IconCopy, IconRefresh } from '../../components/icons';
import { Button, ButtonLink, Input, Mono, Notice, Spinner } from '../../components/ui';
import { useNow } from '../../hooks/useApi';
import { useNebulaEvents } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { t } from '../../i18n';
import { isApiError } from '../../lib/http';
import { countdownText, devicesApi, groupCode, platformLabel, qrDataUrl, type AppDevice, type Pairing, type PairingStatus } from './api';
import { IconIphone, IconMac } from './icons';

export const POLL_MS = 2000;

/** The user-facing text of a failed devices request. */
export function deviceErrorText(e: unknown): string {
  if (!isApiError(e)) return e instanceof Error ? e.message : String(e);
  switch (e.code) {
    case 'gateway_not_configured':
      return t('devices.err.gateway_not_configured');
    case 'too_many_pairings':
      return t('devices.err.too_many_pairings');
    case 'stepup_required':
      return t('devices.err.stepup_required');
    case 'owner_only':
      return t('devices.err.owner_only');
    case 'not_found':
      return t('devices.err.not_found');
    case 'rate_limited':
      return t('devices.err.rate_limited');
    case 'network_error':
      return t('common.networkError');
    default:
      return e.message || t('common.requestFailed');
  }
}

export function PlatformIcon({ platform, className = 'size-5' }: { platform: string; className?: string }) {
  return platform === 'macos' ? <IconMac className={className} /> : <IconIphone className={className} />;
}

/** The 6-digit verification code, large, with Approve / Reject (pairing dialog and pending devices). */
export function VerificationCode({ device }: { device: AppDevice }) {
  const code = device.verification_code ?? '';
  return (
    <div className="rounded-xl border border-border bg-panel-2 px-4 py-4 text-center" data-testid="verification-code">
      <p className="text-xs text-muted">{t('pairing.code.label')}</p>
      <p className="my-1 font-mono text-4xl leading-none font-semibold tracking-[0.14em] text-text tabular-nums" aria-label={t('pairing.code.aria', { code: code.split('').join(' ') })}>
        {groupCode(code)}
      </p>
      <p className="text-sm text-muted">{t('pairing.code.check')}</p>
    </div>
  );
}

export function PairingDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const now = useNow(1000);
  const [offer, setOffer] = useState<Pairing | null>(null);
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);
  const alive = useRef(true);
  const started = useRef(false);
  const inFlight = useRef(false);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    setStatus(null);
    setOffer(null);
    try {
      const p = await devicesApi.startPairing();
      if (alive.current) setOffer(p);
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setStarting(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!started.current) {
      started.current = true;
      void start();
    }
    return () => {
      alive.current = false;
    };
  }, [start]);

  const pid = offer?.pairing_id ?? null;
  const state = status?.status ?? (offer ? 'open' : null);
  const expiresAt = status?.expires_at ?? offer?.expires_at ?? 0;
  const remaining = expiresAt - now / 1000;
  const expired = state === 'expired' || (state === 'open' && remaining <= 0);
  const open = Boolean(pid) && state === 'open' && !expired;
  const device = state === 'claimed' ? (status?.device ?? null) : null;

  const poll = useCallback(() => {
    if (!pid || inFlight.current) return;
    inFlight.current = true;
    devicesApi
      .pairing(pid)
      .then((s) => {
        if (alive.current) setStatus(s);
      })
      .catch(() => undefined) // the next tick tries again
      .finally(() => {
        inFlight.current = false;
      });
  }, [pid]);

  // every 2 s while the offer is open (stops on close, expiry and once it is claimed)
  useEffect(() => {
    if (!open) return;
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [open, poll]);
  useNebulaEvents((ev) => {
    if (open && ev.type === 'app.device.changed') poll();
  });

  // an offer nobody claimed is cancelled when the dialog goes away
  const openRef = useRef<string | null>(null);
  openRef.current = open ? pid : null;
  useEffect(
    () => () => {
      const id = openRef.current;
      if (id) void devicesApi.cancelPairing(id).catch(() => undefined);
    },
    [],
  );

  const close = () => {
    const id = openRef.current;
    openRef.current = null;
    if (id) void devicesApi.cancelPairing(id).catch(() => undefined);
    onClose();
  };

  const copy = async () => {
    if (!offer) return;
    try {
      await navigator.clipboard.writeText(offer.url);
      toast.success(t('pairing.copied'), t('pairing.copied.body'));
    } catch {
      toast.warn(t('pairing.copyFailed'), t('pairing.copyFailed.body'));
    }
  };

  const decide = async (what: 'approve' | 'reject') => {
    if (!device) return;
    setActing(what);
    setError(null);
    try {
      if (what === 'approve') {
        await devicesApi.approve(device.id);
        toast.success(t('devices.approved.toast', { name: device.name }), t('devices.approved.body'));
      } else {
        await devicesApi.reject(device.id);
        toast.info(t('devices.rejected.toast', { name: device.name }), t('devices.rejected.body'));
      }
      if (alive.current) onDone();
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setActing(null);
    }
  };

  const gatewayOff = isApiError(error) && error.code === 'gateway_not_configured';
  const errorBox = error ? (
    <div role="alert">
      <Notice
        tone={gatewayOff ? 'warn' : 'danger'}
        title={gatewayOff ? t('pairing.gatewayFirst') : t('pairing.failed')}
        action={
          gatewayOff ? (
            <ButtonLink size="sm" variant="primary" href={href('/remote')} onClick={close}>
              {t('pairing.openRemote')}
            </ButtonLink>
          ) : !offer && !starting ? (
            <Button size="sm" icon={<IconRefresh />} onClick={() => void start()}>
              {t('common.tryAgain')}
            </Button>
          ) : undefined
        }
      >
        {deviceErrorText(error)}
      </Notice>
    </div>
  ) : null;

  let body;
  let footer;
  if (device) {
    body = (
      <div className="space-y-4" data-testid="pairing-claimed">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl border border-border bg-panel-2 text-muted">
            <PlatformIcon platform={device.platform} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text">{device.name}</p>
            <p className="text-xs text-muted">
              {[device.model || platformLabel(device.platform), device.app_version ? `NEBULA ${device.app_version}` : null].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        <VerificationCode device={device} />
        <p className="text-sm text-muted">{t('pairing.claimedWarn')}</p>
        {errorBox}
      </div>
    );
    footer = (
      <>
        <Button variant="danger" loading={acting === 'reject'} disabled={acting !== null} onClick={() => void decide('reject')}>
          {t('devices.reject')}
        </Button>
        <Button variant="primary" loading={acting === 'approve'} disabled={acting !== null} onClick={() => void decide('approve')}>
          {t('devices.approve')}
        </Button>
      </>
    );
  } else if (offer && open) {
    body = (
      <div className="space-y-4" data-testid="pairing-offer">
        <div className="flex flex-col items-center gap-2">
          {offer.qr_svg ? (
            <img src={qrDataUrl(offer.qr_svg)} alt={t('pairing.qrAlt')} className="size-56 rounded-xl bg-white p-2" data-testid="pairing-qr" />
          ) : (
            <p className="rounded-xl border border-border px-4 py-6 text-center text-sm text-muted">{t('pairing.qrFailed')}</p>
          )}
          <p className="text-sm text-muted" role="timer" aria-live="off" data-testid="pairing-countdown">
            {t('pairing.countdown')} <span className="font-mono font-semibold text-text tabular-nums">{countdownText(remaining)}</span>
          </p>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-text">
          <li>{t('pairing.step1')}</li>
          <li>{t('pairing.step2')}</li>
          <li>{t('pairing.step3')}</li>
        </ol>
        <div className="space-y-1.5">
          <label htmlFor="pairing-link" className="text-[13px] font-medium text-text">
            {t('pairing.macLabel')}
          </label>
          <div className="flex gap-2">
            <Input id="pairing-link" readOnly value={offer.url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" spellCheck={false} />
            <Button icon={<IconCopy />} onClick={() => void copy()}>
              {t('pairing.copy')}
            </Button>
          </div>
          <p className="text-xs text-subtle">
            {t('pairing.linkNote')} <Mono>{offer.server_fingerprint}</Mono>
          </p>
        </div>
        {errorBox}
      </div>
    );
    footer = <Button onClick={close}>{t('common.cancel')}</Button>;
  } else if (offer && state && state !== 'open' && state !== 'claimed') {
    const burned = state === 'burned';
    body = (
      <div className="space-y-3" data-testid="pairing-ended">
        <Notice tone="warn" title={burned ? t('pairing.burned.title') : state === 'cancelled' ? t('pairing.cancelled.title') : t('pairing.expired.title')}>
          {burned ? t('pairing.burned.body') : t('pairing.ended.body')}
        </Notice>
        {errorBox}
      </div>
    );
    footer = (
      <>
        <Button onClick={close}>{t('common.close')}</Button>
        <Button variant="primary" icon={<IconRefresh />} onClick={() => void start()}>
          {t('pairing.newCode')}
        </Button>
      </>
    );
  } else if (offer && expired) {
    body = (
      <div className="space-y-3" data-testid="pairing-ended">
        <Notice tone="warn" title={t('pairing.expired.title')}>
          {t('pairing.ended.body')}
        </Notice>
      </div>
    );
    footer = (
      <>
        <Button onClick={close}>{t('common.close')}</Button>
        <Button variant="primary" icon={<IconRefresh />} onClick={() => void start()}>
          {t('pairing.newCode')}
        </Button>
      </>
    );
  } else {
    body = starting ? (
      <div className="grid place-items-center py-10">
        <Spinner label={t('pairing.creating')} />
      </div>
    ) : state === 'claimed' ? (
      <div className="grid place-items-center py-10">
        <Spinner label={t('pairing.connecting')} />
      </div>
    ) : (
      (errorBox ?? <div className="py-6" />)
    );
    footer = <Button onClick={close}>{t('common.close')}</Button>;
  }

  return (
    <Modal open title={device ? t('pairing.titleApprove') : t('pairing.title')} onClose={close} dismissible={acting === null} footer={footer}>
      {body}
    </Modal>
  );
}
