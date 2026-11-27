// Smart sign-in settings in the owner's Mini App (#/settings/vault/signin): sign-in assistance on / off, answers from
// outside the Mac, local-network sign-ins, passkey / security key requests, the remote sign-in PIN (set / change /
// remove) and trusted sign-in
// providers (built-in, the owner's service → provider relationships, verified sites). Changes need a fresh owner
// confirmation (step-up). Only exact https origins are accepted; look-alike addresses are refused by the host.
// PINs live only in this form's state and are cleared after each request.
import { useId, useState } from 'react';
import { pinProblem, pinStrength } from '../../features/smartauth/core/lib';
import { formatTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { FieldShell, RadioList, TextInput, ToggleRow, describedBy } from '../agentConfig/fields';
import { useActions } from '../hooks';
import { Btn, ErrorState, List, Pill, Row, Screen, Section, SkeletonList } from '../uiKit';
import { ConfirmSheet, Notice } from '../uiExtra';
import { IconTrash } from '../../components/icons';
import { vaultApiM } from './api';
import { httpsOrigin, useLocal, type SignInSettings, type TrustView } from './data';
import { FormAlert, FormCard, SecretInput, useSubmit } from './ui';

function PinCard({ pin, onPin }: { pin: SignInSettings['pin']; onPin: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const [remove, setRemove] = useState(false);
  const { busy, error, run } = useSubmit();
  const toast = useToast();
  const problem = pinProblem(next);
  const strength = pinStrength(next);
  const mismatch = again !== next ? 'The PINs do not match.' : null;
  const save = async () => {
    setTried(true);
    if (problem || mismatch || (pin.configured && !cur)) return;
    const [a, b] = [next, cur];
    setCur('');
    setNext('');
    setAgain('');
    setTried(false);
    const r = await run(() => vaultApiM.setPin(a, pin.configured ? b : undefined));
    if (r !== undefined) {
      toast.success(pin.configured ? 'Remote sign-in PIN changed' : 'Remote sign-in PIN set');
      onPin();
    }
  };
  const clear = async () => {
    const r = await run(() => vaultApiM.clearPin());
    setRemove(false);
    if (r !== undefined) {
      toast.success('Remote sign-in PIN removed');
      onPin();
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      aria-label="Remote sign-in PIN"
      data-testid="signin-pin"
      noValidate
    >
      <FormCard>
        <p className="px-1 text-subhead text-muted">
          {pin.configured
            ? `Set${pin.set_at ? ` ${formatTime(pin.set_at)}` : ''}. Entering passwords from your phone asks for it unless you just confirmed it’s you.`
            : 'Not set. Without a PIN, passwords can be entered from your phone only right after confirming it’s you (Face ID or your NEBULA password).'}
        </p>
        {pin.locked_until && pin.locked_until * 1000 > Date.now() && <p className="px-1 text-footnote text-warn">Locked after wrong PINs until {formatTime(pin.locked_until)}.</p>}
        {pin.configured && <SecretInput label="Current PIN" value={cur} onChange={setCur} inputMode="numeric" error={tried && !cur ? 'Enter the current PIN.' : null} disabled={busy} data-1p-ignore />}
        <SecretInput
          label={pin.configured ? 'New PIN' : 'PIN'}
          value={next}
          onChange={setNext}
          inputMode="numeric"
          error={tried ? problem : null}
          hint={next && !problem ? `Strength: ${strength.label}` : '6–64 characters; not a sequence like 123456.'}
          disabled={busy}
          data-1p-ignore
        />
        <SecretInput label="Repeat the PIN" value={again} onChange={setAgain} inputMode="numeric" error={tried ? mismatch : null} disabled={busy} data-1p-ignore />
        <FormAlert error={error} />
        <Btn type="submit" variant="primary" className="w-full" loading={busy && !remove}>
          {pin.configured ? 'Change PIN' : 'Set PIN'}
        </Btn>
        {pin.configured && (
          <Btn variant="danger" className="w-full" onClick={() => setRemove(true)} disabled={busy}>
            Remove PIN
          </Btn>
        )}
      </FormCard>
      <ConfirmSheet open={remove} title="Remove the remote sign-in PIN?" confirmLabel="Remove" tone="danger" busy={busy} onCancel={() => setRemove(false)} onConfirm={() => void clear()}>
        Passwords can then be entered from your phone only right after confirming it’s you.
      </ConfirmSheet>
    </form>
  );
}

function TrustCard({ trust, onTrust }: { trust: TrustView; onTrust: (t: TrustView) => void }) {
  const ids = useId();
  const [service, setService] = useState('');
  const [idp, setIdp] = useState('');
  const [firstParty, setFirstParty] = useState(false);
  const [site, setSite] = useState('');
  const [tried, setTried] = useState<'rel' | 'site' | null>(null);
  const rel = useSubmit();
  const ver = useSubmit();
  const { run, isPending } = useActions();
  const svcO = httpsOrigin(service);
  const idpO = httpsOrigin(idp);
  const siteO = httpsOrigin(site);
  const bad = (raw: string, o: string) => (!raw.trim() ? 'Enter an https:// address.' : !o ? 'Only https:// addresses can be trusted.' : null);
  const addRel = async () => {
    setTried('rel');
    if (bad(service, svcO) || bad(idp, idpO)) return;
    const r = await rel.run(() => vaultApiM.addRelationship(svcO, idpO, firstParty));
    if (r) {
      onTrust(r);
      setService('');
      setIdp('');
      setFirstParty(false);
      setTried(null);
    }
  };
  const addSite = async () => {
    setTried('site');
    if (bad(site, siteO)) return;
    const r = await ver.run(() => vaultApiM.verifySite(siteO));
    if (r) {
      onTrust(r);
      setSite('');
      setTried(null);
    }
  };
  return (
    <>
      <Section title="Trusted sign-in providers" footer="NEBULA trusts these providers for their own services automatically (no warning).">
        <List>
          {trust.builtin.map((b) => (
            <Row key={b.id} title={b.name} subtitle={b.sign_in_hosts.slice(0, 3).join(', ')} trailing={<Pill tone="success">built-in</Pill>} chevron={false} />
          ))}
        </List>
      </Section>
      <Section
        title="Your sign-in relationships"
        footer="A service that signs in through another provider, e.g. https://teams.example.com → https://login.example.com. Only exact https:// origins are accepted; look-alike addresses are refused."
      >
        {trust.relationships.length > 0 && (
          <List className="mb-2">
            {trust.relationships.map((r) => (
              <Row
                key={`${r.service}|${r.idp}`}
                title={<span className="font-mono">{r.service}</span>}
                subtitle={`→ ${r.idp}${r.first_party ? ' · same company' : ''}`}
                trailing={
                  <button
                    type="button"
                    aria-label={`Remove ${r.service} → ${r.idp}`}
                    className="grid size-10 place-items-center rounded-full text-danger focus-ring [&>svg]:size-5"
                    disabled={isPending(`rel:${r.service}|${r.idp}`)}
                    onClick={() =>
                      void run(`rel:${r.service}|${r.idp}`, () => vaultApiM.removeRelationship(r.service, r.idp), { success: 'Relationship removed' }).then((t) => t && onTrust(t))
                    }
                  >
                    <IconTrash />
                  </button>
                }
                chevron={false}
              />
            ))}
          </List>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void addRel();
          }}
          aria-label="Add a sign-in relationship"
          noValidate
        >
          <FormCard>
            <FieldShell id={`${ids}-svc`} label="Service (https://…)" error={tried === 'rel' ? bad(service, svcO) : null}>
              <TextInput id={`${ids}-svc`} type="url" inputMode="url" value={service} onChange={(e) => setService(e.target.value)} placeholder="https://teams.example.com" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby={describedBy(`${ids}-svc`, tried === 'rel' ? bad(service, svcO) : null)} />
            </FieldShell>
            <FieldShell id={`${ids}-idp`} label="Sign-in provider (https://…)" error={tried === 'rel' ? bad(idp, idpO) : null}>
              <TextInput id={`${ids}-idp`} type="url" inputMode="url" value={idp} onChange={(e) => setIdp(e.target.value)} placeholder="https://login.example.com" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby={describedBy(`${ids}-idp`, tried === 'rel' ? bad(idp, idpO) : null)} />
            </FieldShell>
            <label className="flex min-h-11 items-center gap-3 px-1 text-subhead text-text">
              <input type="checkbox" className="size-5 accent-accent" checked={firstParty} onChange={(e) => setFirstParty(e.target.checked)} />
              Both belong to the same company
            </label>
            <FormAlert error={rel.error} />
            <Btn type="submit" variant="primary" className="w-full" loading={rel.busy}>
              Add relationship
            </Btn>
          </FormCard>
        </form>
      </Section>
      <Section title="Verified sites" footer="Sites you checked yourself: their address is not treated as a look-alike any more. Transport problems (http, local network) are still reported.">
        {trust.verified_sites.length > 0 && (
          <List className="mb-2">
            {trust.verified_sites.map((s) => (
              <Row
                key={s.origin}
                title={<span className="font-mono">{s.origin}</span>}
                trailing={
                  <button
                    type="button"
                    aria-label={`Remove ${s.origin}`}
                    className="grid size-10 place-items-center rounded-full text-danger focus-ring [&>svg]:size-5"
                    disabled={isPending(`site:${s.origin}`)}
                    onClick={() => void run(`site:${s.origin}`, () => vaultApiM.unverifySite(s.origin), { success: 'Site removed' }).then((t) => t && onTrust(t))}
                  >
                    <IconTrash />
                  </button>
                }
                chevron={false}
              />
            ))}
          </List>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void addSite();
          }}
          aria-label="Add a verified site"
          noValidate
        >
          <FormCard>
            <FieldShell id={`${ids}-site`} label="Site (https://…)" error={tried === 'site' ? bad(site, siteO) : null}>
              <TextInput id={`${ids}-site`} type="url" inputMode="url" value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://intranet.example.com" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby={describedBy(`${ids}-site`, tried === 'site' ? bad(site, siteO) : null)} />
            </FieldShell>
            <FormAlert error={ver.error} />
            <Btn type="submit" variant="primary" className="w-full" loading={ver.busy}>
              Add verified site
            </Btn>
          </FormCard>
        </form>
      </Section>
    </>
  );
}

export function SignInSettings() {
  const { run, isPending } = useActions();
  const settings = useLocal((s) => vaultApiM.signInSettings(s), []);
  const trust = useLocal((s) => vaultApiM.trust(s), []);
  const st = settings.data;
  const apply = async (patch: Partial<Omit<SignInSettings, 'pin'>>, success: string, key: string) => {
    const r = await run(key, () => vaultApiM.updateSignInSettings(patch), { success, errorTitle: 'Setting not changed' });
    if (r) settings.set((p) => (p ? { ...p, ...r, pin: r.pin ?? p.pin } : r));
  };
  return (
    <Screen title="Smart sign-in">
      {!st ? (
        settings.error ? (
          <ErrorState error={settings.error} onRetry={settings.reload} />
        ) : (
          <SkeletonList rows={3} avatar={false} />
        )
      ) : (
        <>
          <Section title="Sign-in assistance">
            <List>
              <ToggleRow
                label="Smart sign-in"
                description="When an agent hits a login, NEBULA asks you for exactly what the page needs."
                checked={st.enabled}
                disabled={isPending('enabled')}
                onChange={(v) => void apply({ enabled: v }, v ? 'Smart sign-in turned on' : 'Smart sign-in turned off', 'enabled')}
              />
              <ToggleRow
                label="Answer from outside the Mac"
                description="Lets you enter sign-in details here in Telegram. Passwords need the remote PIN or a fresh confirmation."
                checked={st.remote_submission}
                disabled={isPending('remote')}
                onChange={(v) => void apply({ remote_submission: v }, v ? 'Remote answers allowed' : 'Remote answers turned off', 'remote')}
              />
              <ToggleRow
                label="Local-network sign-ins"
                description="IP addresses and local names (router, NAS). Off by default; such pages always need your review."
                checked={st.allow_local_network}
                disabled={isPending('localnet')}
                onChange={(v) => void apply({ allow_local_network: v }, v ? 'Local-network sign-ins allowed' : 'Local-network sign-ins blocked', 'localnet')}
              />
            </List>
          </Section>
          <Section
            title="When a site asks for a passkey or security key"
            footer="NEBULA’s isolated sign-in browser has no passkey or security key, so it cannot finish that step itself."
          >
            <RadioList
              label="When a site asks for a passkey or security key"
              testId="passkey-fallback"
              value={st.passkey_fallback}
              disabled={isPending('passkey')}
              onChange={(v) => void apply({ passkey_fallback: v }, v === 'ask' ? 'NEBULA asks you first' : 'NEBULA uses the site’s password option', 'passkey')}
              options={[
                { id: 'password', label: 'Use the site’s password option automatically (recommended)', description: 'NEBULA picks “use your password” or another way the site offers.' },
                { id: 'ask', label: 'Ask me first', description: 'NEBULA shows you the other ways and waits for your choice.' },
              ]}
            />
          </Section>
          <Section title="Remote sign-in PIN">
            <PinCard pin={st.pin} onPin={settings.reload} />
          </Section>
        </>
      )}
      {trust.data ? (
        <TrustCard trust={trust.data} onTrust={(t) => trust.set(() => t)} />
      ) : trust.error ? (
        <Section title="Trusted sign-in providers">
          <ErrorState error={trust.error} onRetry={trust.reload} />
        </Section>
      ) : null}
      {st && (
        <Notice tone="info" className="mb-6">
          A sign-in page on an unknown or look-alike address is never trusted automatically: NEBULA shows its exact address and asks you to check it, or blocks it.
        </Notice>
      )}
    </Screen>
  );
}
