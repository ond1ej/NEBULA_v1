// The sign-in bottom sheet of the Mini App (its own chunk): hosts the shared <SmartAuthRequest> for one session. The
// detail is fetched once and refreshed on this session's auth events and on vault lock changes (polling while live
// events are unavailable), and once when the Mini App is back in the foreground (iOS suspends it while the owner reads
// a code in another app: the step may have moved on meanwhile). A response never replaces a newer step (pickNewer).
// Telegram's BackButton closes it first (backStack); closing unmounts the form and drops every typed value.
//
// Owner confirmations (V4.0): for the owner, ONE confirmation (useOwnerConfirm: Face ID, or the vault passphrase)
// replaces the remote PIN, allows "in future" and unlocks a locked vault for "save to vault" / a saved account — always
// BEFORE the single-use submission token is fetched, so the answer is sent once and without a `pin`. Operators keep
// the remote PIN (they cannot confirm as the owner).
import { useMemo, useState } from 'react';
import { ApiError } from '../lib/http';
import { SmartAuthRequest } from '../features/smartauth/core/SmartAuthRequest';
import { authEventSession, pickNewer, requestTitle, stateText } from '../features/smartauth/core/lib';
import type { AuthSession, SmartAuthClient } from '../features/smartauth/core/types';
import type { MiniClient } from './client';
import type { Assurance } from './types';
import { useBackOverlay } from './backStack';
import { canDecide, isAdmin, useMini } from './context';
import { peekQuery, setQueryData, useQuery } from './hooks';
import { mhref } from './router';
import { applySession, authSessionKey } from './signin';
import { useOwnerConfirm, type OwnerConfirmOptions } from './stepup/StepUpProvider';

/**
 * The Mini App's client of the shared form: the remote-safe endpoints plus, for the owner, the unified owner
 * confirmation (`ownerConfirm`); without it (operators) the inline vault unlock and the step-up as before.
 */
export function miniAuthClient(
  client: MiniClient,
  base: Pick<SmartAuthClient, 'token' | 'submit' | 'cancel'>,
  ownerConfirm: ((opts: OwnerConfirmOptions) => Promise<boolean>) | null = null,
): SmartAuthClient {
  if (ownerConfirm) {
    return {
      token: base.token,
      submit: base.submit,
      cancel: base.cancel,
      confirmOwner: ({ unlockVault }) => ownerConfirm({ unlockVault, reason: unlockVault ? t('confirm.reason.signinVault') : t('confirm.reason.signinSend') }),
    };
  }
  return {
    token: base.token,
    submit: base.submit,
    cancel: base.cancel,
    unlockVault: (passphrase: string) => client.request<unknown>('/vault/unlock', { method: 'POST', body: { passphrase } }),
    ensureFresh: async () => {
      const a = await client.request<Assurance & { fresh?: boolean }>('/auth/assurance');
      if (a.fresh === true || (a.fresh_until !== null && a.fresh_until * 1000 > Date.now() + 5000)) return true;
      const methods = a.methods?.biometric?.enrolled ? ['password', 'biometric'] : ['password'];
      return client.confirm(new ApiError(403, 'stepup_required', 'confirm it’s you to continue', { level: 'fresh', methods }), Date.now());
    },
  };
}
import { ErrorState, Sheet, Spinner } from './uiKit';
import { Notice } from './uiExtra';
import { t } from '../i18n';

export function AuthSheet({ sessionId, seed, onClose }: { sessionId: string; seed?: AuthSession | null; onClose: () => void }) {
  const ctx = useMini();
  const { api } = ctx;
  // answering (token / submit / cancel) is the owner's: other remote roles get 403 owner_only from the host
  const canAnswer = canDecide(ctx);
  const key = authSessionKey(sessionId);
  useState(() => {
    if (seed && !peekQuery(key)) setQueryData<AuthSession>(key, () => seed);
    return null;
  });
  const q = useQuery<AuthSession>(
    key,
    // a slower or older answer (resume, event, submit racing each other) never replaces a newer step in the cache
    (sig) => api.smartAuth.get(sessionId, sig).then((next) => pickNewer(peekQuery<AuthSession>(key), next)),
    {
      refreshOn: (ev) => authEventSession(ev) === sessionId || ev.type === 'vault.status.changed',
      resume: true,
    },
  );
  useBackOverlay(true, onClose);
  const ownerConfirm = useOwnerConfirm();
  const owner = isAdmin(ctx);
  const authClient = useMemo(() => miniAuthClient(ctx.client, api.smartAuth, owner ? ownerConfirm : null), [ctx.client, api.smartAuth, owner, ownerConfirm]);
  const s = q.data;
  return (
    <Sheet open keyboardAware testId="auth-sheet" title={s ? requestTitle(s) : 'Sign-in request'} onClose={onClose}>
      <div className="pt-1 pb-2">
        {s && !canAnswer ? (
          <Notice tone="warning" title={stateText(s)}>
            Only the NEBULA owner can answer sign-in requests, in the main bot’s Mini App or in the Dashboard on the Mac.
          </Notice>
        ) : s ? (
          <SmartAuthRequest
            session={s}
            client={authClient}
            variant="mini"
            hideTitle
            liveDesktopHref={mhref(`/agents/${s.agent_id}/desktop`)}
            onSession={applySession}
            onReload={q.reload}
            onClose={onClose}
          />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={q.reload} title="Could not load the sign-in request" />
        ) : (
          <div className="grid place-items-center py-10">
            <Spinner label="Loading the sign-in request…" />
          </div>
        )}
      </div>
    </Sheet>
  );
}

