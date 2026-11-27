// Settings → Security (V3.3): who this session is, whether sensitive changes are currently confirmed, and Face ID /
// fingerprint confirmations through Telegram's BiometricManager (enrol this device, turn it off, remove devices).
// Loads GET /auth/assurance only when this page opens.
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/Toast';
import { formatTime, relativeTime } from '../../lib/format';
import { errorMessage, isApiError } from '../../lib/http';
import { isAdmin, useMini } from '../context';
import { useQuery, type QueryState } from '../hooks';
import type { TgBiometricManager } from '../telegram';
import type { Assurance, BiometricDevice } from '../types';
import { Btn, Card, List, QueryView, Row, Section } from '../uiKit';
import { ConfirmSheet, KV, Notice } from '../uiExtra';
import { stepUpApi } from './api';
import {
  biometricLabel,
  biometricManager,
  biometricStale,
  deviceName,
  encodeDeviceToken,
  initBiometrics,
  markBiometricStale,
  rememberDevice,
  requestBiometricAccess,
  storeBiometricToken,
} from './biometric';
import { useStepUp } from './StepUpProvider';

const ROLE: Record<string, string> = { owner: 'Owner', operator: 'Operator', agent_bot: 'Agent bot' };

interface BioState {
  bm: TgBiometricManager | null;
  ready: boolean;
}

function useBiometrics(): [BioState, () => void] {
  const [state, setState] = useState<BioState>(() => ({ bm: biometricManager(), ready: false }));
  const [n, setN] = useState(0);
  useEffect(() => {
    const bm = biometricManager();
    if (!bm) {
      setState({ bm: null, ready: true });
      return;
    }
    let alive = true;
    void initBiometrics(bm).then((m) => {
      if (alive) setState({ bm: m, ready: true });
    });
    return () => {
      alive = false;
    };
  }, [n]);
  return [state, () => setN((x) => x + 1)];
}

export function SecuritySection() {
  const ctx = useMini();
  const { client, me } = ctx;
  // biometric devices are the owner's (POST /auth/devices is owner-only on the host)
  const admin = isAdmin(ctx);
  const toast = useToast();
  const { freshUntil, setFreshUntil } = useStepUp();
  const api = useMemo(() => stepUpApi(client), [client]);
  const q = useQuery<Assurance>('auth:assurance', (s) => api.assurance(s));
  const [bio, refreshBio] = useBiometrics();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BiometricDevice | null>(null);

  useEffect(() => {
    if (q.data) setFreshUntil(q.data.fresh_until);
  }, [q.data, setFreshUntil]);

  const bm = bio.bm;
  const label = biometricLabel(bm?.biometricType);
  const fresh = q.data?.fresh_until ?? freshUntil ?? me?.assurance?.fresh_until ?? null;
  const confirmed = fresh !== null && fresh * 1000 > Date.now();
  const local = (q.data?.interface ?? (client.mode === 'telegram' ? 'miniapp' : 'local')) === 'local';
  const onHere = Boolean(bm?.isBiometricTokenSaved) && !biometricStale();
  const devices = q.data?.methods.biometric.devices ?? [];

  const enroll = async () => {
    if (!bm) return;
    setBusy('enroll');
    setProblem(null);
    try {
      const m = await initBiometrics(bm);
      if (!m.isBiometricAvailable) {
        setProblem('Telegram reports no Face ID, Touch ID or fingerprint on this device.');
        return;
      }
      if (!(await requestBiometricAccess(m, `Confirm sensitive NEBULA changes with ${label}`))) {
        setProblem(`Telegram may not use ${label} for NEBULA. Allow it in the bot’s settings in Telegram, then try again.`);
        return;
      }
      // needs a fresh confirmation itself: the confirmation sheet asks once (vault passphrase or NEBULA password)
      const d = await api.addDevice(deviceName());
      if (!(await storeBiometricToken(m, encodeDeviceToken(d.device_id, d.token)))) {
        await api.removeDevice(d.device_id).catch(() => undefined);
        setProblem('Telegram could not save the device key. Nothing was turned on; try again.');
        return;
      }
      markBiometricStale(false);
      // the first vault unlock on this device then offers to keep the vault key for it ("Next time, Face ID only")
      rememberDevice(d.device_id);
      toast.success(`${label} is on`, `Sensitive changes on this device can now be confirmed with ${label}.`);
      q.reload();
      refreshBio();
    } catch (e) {
      setProblem(isApiError(e) && e.code === 'stepup_required' ? 'Not turned on: the confirmation was cancelled.' : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    if (!bm) return;
    setBusy('off');
    setProblem(null);
    try {
      if (!(await storeBiometricToken(bm, ''))) setProblem('Telegram could not remove the device key.');
      else toast.success(`${label} is off on this device`, 'Remove the device from the list below too, so its key stops working on the Mac.');
      refreshBio();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy('remove');
    try {
      await api.removeDevice(removing.id);
      toast.success('Device removed', `${removing.name} can no longer confirm changes.`);
      setRemoving(null);
      q.reload();
    } catch (e) {
      toast.error(e, 'Could not remove the device');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Section title="This session">
        <Card>
          <KV
            items={[
              ['Role', ROLE[q.data?.role ?? me?.role ?? ''] ?? (q.data?.role || me?.role || '—')],
              ['Signed in through', local ? 'Local Dashboard session' : 'Telegram Mini App'],
              ['Sensitive changes', local ? 'No confirmation needed on this Mac' : confirmed && fresh ? `Confirmed until ${formatTime(fresh)}` : 'Ask for a confirmation'],
            ]}
          />
        </Card>
      </Section>

      {admin && (
        <BiometricSettings
          label={label}
          bio={bio}
          onHere={onHere}
          busy={busy}
          problem={problem}
          devices={devices}
          q={q}
          onEnroll={() => void enroll()}
          onTurnOff={() => void turnOff()}
          onRemove={setRemoving}
        />
      )}

      <ConfirmSheet open={removing !== null} title={`Remove ${removing?.name ?? 'device'}?`} confirmLabel="Remove" tone="danger" busy={busy === 'remove'} onCancel={() => setRemoving(null)} onConfirm={() => void remove()}>
        Its biometric key stops working at once. Set it up again from that device’s Settings → Security.
      </ConfirmSheet>
    </>
  );
}

function BiometricSettings({
  label,
  bio,
  onHere,
  busy,
  problem,
  devices,
  q,
  onEnroll,
  onTurnOff,
  onRemove,
}: {
  label: string;
  bio: BioState;
  onHere: boolean;
  busy: string | null;
  problem: string | null;
  devices: BiometricDevice[];
  q: QueryState<Assurance>;
  onEnroll: () => void;
  onTurnOff: () => void;
  onRemove: (d: BiometricDevice) => void;
}) {
  const bm = bio.bm;
  return (
    <>
      <Section
        title={`${label === 'biometrics' ? 'Face ID / biometrics' : label} for confirmations`}
        footer="The device key is kept only in Telegram’s secure biometric storage on this phone. Your NEBULA password always works too."
      >
        {!bio.ready ? null : !bm ? (
          <Notice tone="info" title="Not available here">
            Biometric confirmations need the Telegram app (version 7.2 or newer) on a phone or tablet with Face ID, Touch ID or a fingerprint sensor. Use your
            NEBULA password to confirm sensitive changes.
          </Notice>
        ) : !bm.isBiometricAvailable ? (
          <Notice tone="info" title="No biometrics on this device">
            Telegram reports no Face ID, Touch ID or fingerprint here (or Telegram may not use them).
            {bm.openSettings && (
              <Btn size="sm" className="mt-2" onClick={() => bm.openSettings?.()}>
                Open Telegram settings
              </Btn>
            )}
          </Notice>
        ) : onHere ? (
          <List>
            <Row title={`${label} is on for this device`} subtitle="Sensitive changes ask for it first; the password stays available." value="On" chevron={false} />
            <Row title="Turn off on this device" destructive onClick={busy ? undefined : onTurnOff} chevron={false} />
          </List>
        ) : (
          <Card className="space-y-3">
            <p className="text-subhead text-muted">
              Confirm changes like deleting agents or editing providers with {label} instead of typing a password — after the first vault unlock on this
              device, {label} can unlock the Password Vault too. Turning it on asks you to confirm once.
            </p>
            <Btn variant="primary" className="w-full" loading={busy === 'enroll'} disabled={Boolean(busy)} onClick={onEnroll}>
              Use {label} for confirmations
            </Btn>
          </Card>
        )}
        {problem && (
          <div role="alert" className="mt-2">
            <Notice tone="danger">{problem}</Notice>
          </div>
        )}
      </Section>

      <Section title="Devices that can confirm with biometrics">
        <QueryView q={q} rows={1} isEmpty={() => devices.length === 0} empty={<p className="rounded-card bg-panel px-4 py-3.5 text-subhead text-muted">No device is set up.</p>}>
          {() => (
            <List>
              {devices.map((d) => (
                <Row
                  key={d.id}
                  title={d.name}
                  subtitle={`Added ${relativeTime(d.created_at)}${d.last_used_at ? ` · last used ${relativeTime(d.last_used_at)}` : ' · never used'}${d.vault_key ? ' · unlocks the vault' : ''}`}
                  trailing={
                    <Btn size="sm" variant="ghost" className="text-danger" onClick={() => onRemove(d)} aria-label={`Remove ${d.name}`}>
                      Remove
                    </Btn>
                  }
                  chevron={false}
                />
              ))}
            </List>
          )}
        </QueryView>
      </Section>
    </>
  );
}
