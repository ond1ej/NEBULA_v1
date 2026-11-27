// Password Vault → Settings → Trusted sign-in providers: the built-in identity providers NEBULA trusts for their own
// services, the owner's service → provider relationships and owner-verified sites (routes_v33.py). Only exact https
// origins are accepted; the host refuses look-alike addresses. Nothing secret is involved.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { IconShield, IconTrash } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Checkbox, ErrorBanner, Field, Input, LoadingRows } from '../../components/ui';
import { smartAuthApi } from './api';
import type { TrustConfig } from './core/types';

/** Exact https origin of what the owner typed ("example.com" → "https://example.com"), else ''. */
export function trustOrigin(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === 'https:' && u.hostname ? u.origin : '';
  } catch {
    return '';
  }
}

const problem = (raw: string) => (!raw.trim() ? 'Enter an https:// address' : !trustOrigin(raw) ? 'Only https:// addresses can be trusted' : null);

export function SmartAuthTrustCard() {
  const toast = useToast();
  const ids = useId();
  const [data, setData] = useState<TrustConfig | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [service, setService] = useState('');
  const [idp, setIdp] = useState('');
  const [firstParty, setFirstParty] = useState(false);
  const [site, setSite] = useState('');
  const [tried, setTried] = useState<'rel' | 'site' | null>(null);

  const load = () => {
    setLoadError(null);
    smartAuthApi.trust().then(setData, setLoadError);
  };
  useEffect(load, []);

  const act = async (key: string, fn: () => Promise<TrustConfig>, success: string) => {
    setBusy(key);
    try {
      setData(await fn());
      toast.success(success);
      return true;
    } catch (e) {
      toast.error(e, 'Not changed');
      return false;
    } finally {
      setBusy(null);
    }
  };
  const addRel = async (e: FormEvent) => {
    e.preventDefault();
    setTried('rel');
    if (problem(service) || problem(idp)) return;
    if (await act('rel', () => smartAuthApi.addRelationship(trustOrigin(service), trustOrigin(idp), firstParty), 'Sign-in relationship added')) {
      setService('');
      setIdp('');
      setFirstParty(false);
      setTried(null);
    }
  };
  const addSite = async (e: FormEvent) => {
    e.preventDefault();
    setTried('site');
    if (problem(site)) return;
    if (await act('site', () => smartAuthApi.verifySite(trustOrigin(site)), 'Site verified')) {
      setSite('');
      setTried(null);
    }
  };

  return (
    <Card
      title="Trusted sign-in providers"
      icon={<IconShield />}
      subtitle="A sign-in that continues on a verified provider (for example Teams → Microsoft) needs no confirmation. Unknown addresses are shown to you exactly; look-alikes are blocked."
    >
      {!data ? (
        loadError ? (
          <ErrorBanner error={loadError} onRetry={load} title="Could not load the trusted providers" />
        ) : (
          <LoadingRows rows={2} label="Loading trusted providers…" />
        )
      ) : (
        <div className="space-y-5" data-testid="smart-signin-trust">
          <div className="flex flex-wrap gap-1.5" aria-label="Built-in providers">
            {data.builtin.map((b) => (
              <Badge key={b.id} tone="success">
                {b.name}
              </Badge>
            ))}
          </div>
          <section className="space-y-2">
            <h4 className="text-[13px] font-semibold text-text">Your sign-in relationships</h4>
            {data.relationships.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.relationships.map((r) => (
                  <li key={`${r.service}|${r.idp}`} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 font-mono break-all text-text">
                      {r.service} → {r.idp}
                      {r.first_party && <span className="ml-1.5 font-sans text-xs text-muted">(same company)</span>}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={<IconTrash />}
                      aria-label={`Remove ${r.service} → ${r.idp}`}
                      loading={busy === `rel:${r.service}|${r.idp}`}
                      onClick={() => void act(`rel:${r.service}|${r.idp}`, () => smartAuthApi.removeRelationship(r.service, r.idp), 'Relationship removed')}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">None yet.</p>
            )}
            <form className="grid gap-3 md:grid-cols-2" onSubmit={(e) => void addRel(e)} noValidate aria-label="Add a sign-in relationship">
              <Field label="Service (https://…)" htmlFor={`${ids}-svc`} error={tried === 'rel' ? problem(service) : null}>
                <Input id={`${ids}-svc`} value={service} onChange={(e) => setService(e.target.value)} placeholder="https://teams.example.com" autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Sign-in provider (https://…)" htmlFor={`${ids}-idp`} error={tried === 'rel' ? problem(idp) : null}>
                <Input id={`${ids}-idp`} value={idp} onChange={(e) => setIdp(e.target.value)} placeholder="https://login.example.com" autoComplete="off" spellCheck={false} />
              </Field>
              <Checkbox label="Both belong to the same company" checked={firstParty} onChange={setFirstParty} />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" size="sm" loading={busy === 'rel'}>
                  Add relationship
                </Button>
              </div>
            </form>
          </section>
          <section className="space-y-2">
            <h4 className="text-[13px] font-semibold text-text">Verified sites</h4>
            {data.verified_sites.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.verified_sites.map((s) => (
                  <li key={s.origin} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 font-mono break-all text-text">{s.origin}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={<IconTrash />}
                      aria-label={`Remove ${s.origin}`}
                      loading={busy === `site:${s.origin}`}
                      onClick={() => void act(`site:${s.origin}`, () => smartAuthApi.unverifySite(s.origin), 'Site removed')}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">None yet. A site you verify is no longer treated as a look-alike (transport problems are still reported).</p>
            )}
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => void addSite(e)} noValidate aria-label="Add a verified site">
              <div className="min-w-0 flex-1">
                <Field label="Site (https://…)" htmlFor={`${ids}-site`} error={tried === 'site' ? problem(site) : null}>
                  <Input id={`${ids}-site`} value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://intranet.example.com" autoComplete="off" spellCheck={false} />
                </Field>
              </div>
              <Button type="submit" variant="secondary" size="sm" loading={busy === 'site'}>
                Verify site
              </Button>
            </form>
          </section>
        </div>
      )}
    </Card>
  );
}
