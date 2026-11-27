import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { IconAlert, IconCheckCircle, IconKey, IconMic, IconRefresh, IconShield, IconTelegram, IconTrash, IconXCircle } from '../components/icons';
import { ConfirmDialog } from '../components/Modal';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
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
  Switch,
  type Column,
} from '../components/ui';
import { useAction, useApi, useNow } from '../hooks/useApi';
import { useLiveRefresh, useNebulaEvents } from '../hooks/useEvents';
import { formatDuration, formatTime, relativeTime, shortId } from '../lib/format';
import type { TelegramPairing, TelegramTest, TelegramTopic, TelegramUser } from '../types';

function PairingBox({ pairing, onNew, busy }: { pairing: TelegramPairing; onNew: () => void; busy: boolean }) {
  const now = useNow(1000) / 1000;
  const left = pairing.expires_at - now;
  const expired = left <= 0;
  return (
    <div className="rounded-xl border border-accent/35 bg-accent/[0.06] p-4" aria-live="polite">
      <p className="text-2xs font-semibold tracking-wider text-subtle uppercase">Pairing code</p>
      <p className={`mt-1 font-mono text-3xl tracking-[0.3em] ${expired ? 'text-subtle line-through' : 'text-text'}`}>{pairing.code}</p>
      <p className={`mt-1 text-sm tabular-nums ${expired ? 'text-danger' : left < 60 ? 'text-warn' : 'text-muted'}`} role="timer">
        {expired ? 'Expired — generate a new code.' : `Expires in ${formatDuration(left)}`}
      </p>
      {!expired && (
        <>
          <p className="mt-3 text-sm text-text">{pairing.instructions}</p>
          {pairing.deep_link && (
            <p className="mt-2 text-sm">
              <a className="rounded break-all text-accent-soft underline-offset-2 hover:underline focus-ring" href={pairing.deep_link} target="_blank" rel="noopener noreferrer">
                {pairing.deep_link}
              </a>
            </p>
          )}
        </>
      )}
      {expired && (
        <Button className="mt-3" size="sm" onClick={onNew} loading={busy}>
          Generate a new code
        </Button>
      )}
    </div>
  );
}

function userColumns(actionFor: (u: TelegramUser) => ReactNode): Column<TelegramUser>[] {
  return [
    {
      key: 'user',
      header: 'User',
      mobile: 'title',
      cell: (u) => (
        <div>
          <p className="flex flex-wrap items-center gap-1.5 text-text">
            {u.display_name || '—'}
            {u.owner && (
              <Badge tone="accent" icon={<IconShield />} title="The NEBULA owner’s Telegram account">
                Owner · your account
              </Badge>
            )}
          </p>
          <p className="text-xs text-muted">{u.username ? `@${u.username}` : 'no username'}</p>
        </div>
      ),
    },
    { key: 'uid', header: 'Telegram user ID', cell: (u) => <Mono className="text-text">{u.telegram_user_id}</Mono> },
    { key: 'chat', header: 'Chat ID', cell: (u) => <Mono className="text-text">{u.chat_id}</Mono> },
    { key: 'status', header: 'Status', mobile: 'aside', cell: (u) => <StatusPill state={u.status} /> },
    { key: 'when', header: 'When', cell: (u) => <span className="text-xs text-muted">{u.approved_at ? `approved ${relativeTime(u.approved_at)}` : `requested ${relativeTime(u.created_at)}`}</span> },
    { key: 'act', header: <span className="sr-only">Actions</span>, align: 'right', mobile: 'aside', cell: (u) => actionFor(u) },
  ];
}

function VoiceCard() {
  const voice = useApi(() => api.voice.status(), []);
  const { run, isPending } = useAction();
  const [confirm, setConfirm] = useState(false);
  const v = voice.data;
  const apply = async (patch: Parameters<typeof api.voice.update>[0], msg: string) => {
    const r = await run('voice', () => api.voice.update(patch), { success: msg, errorTitle: 'Voice settings not saved' });
    if (r) voice.setData(() => r);
  };
  return (
    <Card
      title="Voice messages"
      icon={<IconMic />}
      subtitle="Voice notes you send to the bot are transcribed to text before the agent sees them."
      actions={
        <Button size="sm" variant="ghost" icon={<IconRefresh />} onClick={voice.reload} loading={voice.loading && !!v}>
          Re-check
        </Button>
      }
    >
      {voice.error && !v ? (
        <ErrorBanner error={voice.error} onRetry={voice.reload} />
      ) : !v ? (
        <LoadingRows rows={3} />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">Active engine:</span>
            {v.backend === 'whisper_cpp' ? (
              <Badge tone="success" icon={<IconCheckCircle />}>
                Local whisper.cpp — audio stays on this Mac
              </Badge>
            ) : v.backend === 'openai' ? (
              <Badge tone="warn" icon={<IconAlert />}>
                OpenAI cloud (you consented)
              </Badge>
            ) : (
              <Badge tone="neutral" icon={<IconXCircle />}>
                Not set up — voice notes are refused
              </Badge>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-border p-4">
              <p className="text-[13px] font-medium text-text">Local transcription (preferred)</p>
              <KeyValue
                className="mt-3"
                items={[
                  ['whisper.cpp', v.local.binary ? <Mono key="b" className="break-all text-text">{v.local.binary}</Mono> : <span key="b" className="text-warn">not found</span>],
                  ['Model', v.local.model ? <Mono key="m" className="break-all text-text">{v.local.model}</Mono> : <span key="m" className="text-warn">no ggml model</span>],
                  ['ffmpeg', v.local.ffmpeg ? 'installed' : <span key="f" className="text-warn">missing (brew install ffmpeg)</span>],
                ]}
              />
            </div>
            <div className="rounded-xl border border-border p-4">
              <p className="text-[13px] font-medium text-text">Cloud fallback (OpenAI)</p>
              <KeyValue
                className="mt-3"
                items={[
                  ['OpenAI API key', v.cloud.provider_connected ? 'connected' : 'not connected'],
                  ['Model', <Mono key="cm" className="text-text">{v.cloud.model}</Mono>],
                  ['Your consent', v.cloud.consent ? 'given' : 'not given'],
                ]}
              />
              <div className="mt-4">
                <Switch
                  checked={v.cloud.consent}
                  loading={isPending('voice')}
                  onChange={(on) => (on ? setConfirm(true) : void apply({ cloud_consent: false }, 'Cloud transcription disabled'))}
                  label="Allow cloud transcription"
                  description="Only used when local transcription is not available."
                />
              </div>
            </div>
          </div>
          {v.setup_hint && (
            <Notice tone="info" title="How to set it up">
              {v.setup_hint}
            </Notice>
          )}
          {v.cloud.consent && (
            <Notice tone="warn">
              With consent on and no local engine, the audio of your voice notes is uploaded to OpenAI (api.openai.com) and billed to your API key. Turn it off to keep audio on this Mac.
            </Notice>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Send voice audio to OpenAI?"
        confirmLabel="Allow cloud transcription"
        destructive={false}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await apply({ cloud_consent: true }, 'Cloud transcription allowed');
          setConfirm(false);
        }}
      >
        <Notice tone="warn" title="Privacy">
          When no local whisper.cpp engine is installed, the <strong>audio recording</strong> of every voice note you send to the bot is uploaded to OpenAI for transcription and billed per minute to
          your OpenAI API key. OpenAI’s data policy applies.
        </Notice>
        <p>Local transcription is always preferred when it is available. You can withdraw consent at any time.</p>
      </ConfirmDialog>
    </Card>
  );
}

export function TelegramPage() {
  const toast = useToast();
  const tokenId = useId();
  const status = useApi(() => api.telegram.status(), []);
  const agents = useApi(() => api.agents.list(), []);
  const { run, isPending } = useAction();
  const [token, setToken] = useState('');
  const [pairing, setPairing] = useState<TelegramPairing | null>(null);
  const [test, setTest] = useState<TelegramTest | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [toRevoke, setToRevoke] = useState<TelegramUser | null>(null);
  const [toOwn, setToOwn] = useState<TelegramUser | null>(null);

  useLiveRefresh(status.reload, (e) => e.type.startsWith('telegram.') || e.type === 'agent.created' || e.type === 'agent.deleted');
  useNebulaEvents((e) => {
    if (e.type === 'telegram.pairing.pending') {
      toast.info('New Telegram pairing request', `User ID ${String(e.payload.telegram_user_id)} · chat ${String(e.payload.chat_id)} — verify and approve below.`);
    }
  });

  const s = status.data;
  const users = s?.users ?? [];
  const pending = users.filter((u) => u.status === 'pending');
  const approved = users.filter((u) => u.status === 'approved');
  const revoked = users.filter((u) => u.status === 'revoked');
  // the owner's own account (M-02): stored explicitly; revoking it leaves no Telegram owner until one is chosen again
  const ownerUser = approved.find((u) => u.owner) ?? null;
  const designated = s?.designated_owner_telegram_user_id ?? null;
  const agentName = (id: string) => agents.data?.find((a) => a.id === id)?.name ?? shortId(id);

  const saveToken = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run('token', () => api.telegram.setToken(token.trim()), {
      success: (res) => `Bot @${res.bot_username ?? '?'} connected; polling started`,
      errorTitle: 'Bot token rejected',
    });
    if (r) {
      setToken('');
      status.setData(() => r);
    }
  };

  const newPairing = async () => {
    const r = await run('pair', () => api.telegram.pairing(), { errorTitle: 'Could not create a pairing code' });
    if (r) setPairing(r);
  };

  const topicCols: Column<TelegramTopic>[] = [
    { key: 'agent', header: 'Agent', mobile: 'title', cell: (t) => <span className="text-text">{agentName(t.agent_id)}</span> },
    { key: 'chat', header: 'Chat ID', cell: (t) => <Mono>{t.telegram_chat_id}</Mono> },
    { key: 'thread', header: 'Thread ID', cell: (t) => <Mono>{t.message_thread_id ?? '—'}</Mono> },
    { key: 'map', header: 'Mapping', mobile: 'aside', cell: (t) => <StatusPill state={null} tone={t.mapping_type === 'command_fallback' ? 'neutral' : 'info'} label={t.mapping_type.replace(/_/g, ' ')} /> },
    { key: 'topic', header: 'Topic', cell: (t) => <span className="text-muted">{t.topic_name ?? '—'}{t.archived ? ' (archived)' : ''}</span> },
  ];

  return (
    <>
      <PageHeader title="Telegram" description="Talk to your agents from your phone through your own Telegram bot (long polling; no public server)." />
      <div className="mb-5">
        <Notice tone="warn" title="Telegram is not end-to-end encrypted">
          Messages between you and your bot pass through Telegram’s servers like normal cloud chats (not Secret Chats). Do not send passwords or other secrets to your agents over Telegram. The bot
          token never leaves this Mac’s Keychain.
        </Notice>
      </div>
      {status.error ? (
        <div className="mb-4">
          <ErrorBanner error={status.error} onRetry={status.reload} />
        </div>
      ) : null}
      {!s ? (
        status.loading ? (
          <div className="rounded-xl border border-border bg-panel p-5">
            <LoadingRows rows={4} label="Loading Telegram status…" />
          </div>
        ) : null
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              title={
                <span className="flex items-center gap-2">
                  Bot{' '}
                  <StatusPill state={null} tone={s.configured ? (s.polling ? 'success' : 'warn') : 'neutral'} label={s.configured ? (s.polling ? 'Polling' : 'Configured, not polling') : 'Not configured'} />
                </span>
              }
              icon={<IconTelegram />}
              actions={
                s.configured ? (
                  <>
                    <Button
                      size="sm"
                      loading={isPending('test')}
                      onClick={async () => {
                        const r = await run('test', () => api.telegram.test(), { success: (res) => `getMe OK: @${res.bot.username ?? '?'}`, errorTitle: 'Telegram test failed' });
                        if (r) {
                          setTest(r);
                          status.reload();
                        }
                      }}
                    >
                      Test
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setConfirmDisconnect(true)}>
                      Disconnect bot
                    </Button>
                  </>
                ) : undefined
              }
            >
              <KeyValue
                items={[
                  ['Bot', s.bot_username ? `@${s.bot_username}` : '—'],
                  ['Bot ID', s.bot_id ? <Mono>{s.bot_id}</Mono> : '—'],
                  ['Topics mode', s.topics_mode === 'private_topics' ? 'Topics in private chat (one topic per agent)' : 'Command fallback (/use <agent>)'],
                  ['Last poll', s.last_poll_at ? `${formatTime(s.last_poll_at)} (${relativeTime(s.last_poll_at)})` : '—'],
                  ['Update offset', String(s.update_offset)],
                ]}
              />
              {s.last_error && (
                <div className="mt-3">
                  <Notice tone="danger" title="Last error">
                    {s.last_error}
                  </Notice>
                </div>
              )}
              {test && (
                <p className="mt-3 text-sm text-muted" aria-live="polite">
                  Test: @{test.bot.username} ({test.bot.first_name}) · topics {test.bot.has_topics_enabled ? 'enabled' : 'not enabled'} · users may
                  {test.bot.allows_users_to_create_topics ? '' : ' not'} create topics
                </p>
              )}
            </Card>

            <Card title={s.configured ? 'Replace bot token' : 'Connect your bot'} icon={<IconKey />}>
              <ol className="mb-4 list-inside list-decimal space-y-1 text-sm text-muted">
                <li>
                  In Telegram, open <strong>@BotFather</strong> and send <Mono>/newbot</Mono>.
                </li>
                <li>
                  Choose a display name and a username ending in <Mono>bot</Mono>.
                </li>
                <li>
                  Copy the token BotFather sends you (looks like <Mono>123456789:AA…</Mono>).
                </li>
                <li>
                  Paste it below. NEBULA verifies it with <Mono>getMe</Mono> and stores it in the Keychain.
                </li>
              </ol>
              <form onSubmit={saveToken} className="space-y-3">
                <Field htmlFor={tokenId} label="Bot token" hint="Never share this token; anyone with it controls your bot.">
                  <Input id={tokenId} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
                </Field>
                <Button type="submit" variant="primary" loading={isPending('token')} disabledReason={token.trim().length < 20 ? 'Paste the full bot token' : null}>
                  Verify & save token
                </Button>
              </form>
            </Card>
          </div>

          <Card
            title="Pair your Telegram account"
            subtitle="Only approved numeric Telegram user IDs + chat IDs can use the bot."
            actions={
              <Button variant="primary" size="sm" onClick={newPairing} loading={isPending('pair')} disabledReason={s.enabled ? null : 'Connect a bot first'}>
                Generate pairing code
              </Button>
            }
          >
            <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_1fr]">
              <div>
                {pairing ? (
                  <PairingBox pairing={pairing} onNew={newPairing} busy={isPending('pair')} />
                ) : (
                  <p className="text-sm text-muted">Generate a one-time code (valid for 5 minutes), send it to your bot, then approve the request here.</p>
                )}
              </div>
              <div className="min-w-0">
                <h3 className="mb-2 text-sm font-semibold text-text">Pending requests ({pending.length})</h3>
                {pending.length === 0 ? (
                  <p className="text-sm text-muted">No pending requests.</p>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-warn">Approve only if the user ID and chat ID match what the bot replied to you in Telegram.</p>
                    <DataTable
                      label="Pending Telegram users"
                      rows={pending}
                      rowKey={(u) => u.id}
                      dense
                      columns={userColumns((u) => (
                        <Button
                          size="sm"
                          variant="primary"
                          loading={isPending(`approve-${u.id}`)}
                          onClick={async () => {
                            const r = await run(`approve-${u.id}`, () => api.telegram.approve(u.pairing_id ?? u.id), {
                              success: `Telegram user ${u.telegram_user_id} approved`,
                              errorTitle: 'Approval failed',
                            });
                            if (r) status.reload();
                          }}
                        >
                          Approve
                        </Button>
                      ))}
                    />
                  </>
                )}
              </div>
            </div>
          </Card>

          <Card title={`Approved users (${approved.length})`}>
            {approved.length === 0 ? (
              <EmptyState compact title="Nobody is paired yet" />
            ) : (
              <>
                <div className="mb-3" data-testid="telegram-owner-status">
                  {ownerUser ? (
                    <p className="text-sm text-muted">
                      Your account: <span className="text-text">{ownerUser.display_name || (ownerUser.username ? `@${ownerUser.username}` : 'no name')}</span> (ID{' '}
                      <Mono className="text-text">{ownerUser.telegram_user_id}</Mono>). Only this account approves agent actions, answers sign-in requests and opens
                      the administration area from Telegram. Everyone else is an operator.
                    </p>
                  ) : (
                    <Notice tone="warn" title="None of these accounts is yours yet">
                      {designated
                        ? `The account you chose as yours (ID ${designated}) is no longer approved, so nobody can approve agent actions or answer sign-in requests from Telegram. `
                        : 'Until you choose your own account, nobody can approve agent actions or answer sign-in requests from Telegram. '}
                      Choose “Make this my account” on your own Telegram account.
                    </Notice>
                  )}
                </div>
                <DataTable
                  label="Approved Telegram users"
                  rows={approved}
                  rowKey={(u) => u.id}
                  dense
                  columns={userColumns((u) => (
                    <div className="flex flex-wrap justify-end gap-2">
                      {!u.owner && (
                        <Button size="sm" icon={<IconShield />} loading={isPending(`owner-${u.id}`)} onClick={() => setToOwn(u)}>
                          Make this my account
                        </Button>
                      )}
                      <Button size="sm" variant="danger" icon={<IconTrash />} onClick={() => setToRevoke(u)}>
                        Revoke
                      </Button>
                    </div>
                  ))}
                />
              </>
            )}
            {revoked.length > 0 && (
              <details className="mt-4">
                <summary className="inline-flex rounded text-sm text-muted hover:text-text focus-ring">Revoked ({revoked.length})</summary>
                <div className="mt-2">
                  <DataTable label="Revoked Telegram users" rows={revoked} rowKey={(u) => u.id} dense columns={userColumns(() => null)} />
                </div>
              </details>
            )}
          </Card>

          <VoiceCard />

          <Card title="Topic mapping" subtitle="Created automatically for every agent in each approved chat." padded={s.topics.length === 0}>
            {s.topics.length === 0 ? (
              <p className="text-sm text-muted">No mappings yet. They appear after a user is approved (one per agent).</p>
            ) : (
              <div className="p-3 sm:p-4">
                <DataTable label="Topic mapping" rows={s.topics} rowKey={(t) => t.id} columns={topicCols} dense />
              </div>
            )}
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect the Telegram bot?"
        confirmLabel="Disconnect bot"
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={async () => {
          const r = await run('disconnect', () => api.telegram.disconnect(), { success: 'Telegram bot disconnected', errorTitle: 'Disconnect failed' });
          if (r) {
            setConfirmDisconnect(false);
            setPairing(null);
            setTest(null);
            status.setData(() => r);
          }
        }}
      >
        <p>Polling stops and the bot token is deleted from the Keychain. Paired users and topic mappings stay in the database; reconnecting the same bot restores them.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={toRevoke !== null}
        title="Revoke this Telegram user?"
        confirmLabel="Revoke access"
        onCancel={() => setToRevoke(null)}
        onConfirm={async () => {
          if (!toRevoke) return;
          const r = await run('revoke', () => api.telegram.revoke(toRevoke.id), { success: `User ${toRevoke.telegram_user_id} revoked` });
          if (r) {
            setToRevoke(null);
            status.setData(() => r);
          }
        }}
      >
        <p>
          Telegram user <Mono>{toRevoke?.telegram_user_id}</Mono> (chat <Mono>{toRevoke?.chat_id}</Mono>) can no longer send tasks or commands. They must pair again to regain access.
        </p>
        {toRevoke?.owner && <p className="mt-2 text-warn">This is your own account: after revoking it, nobody can approve agent actions from Telegram until you choose your account again.</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={toOwn !== null}
        title="Make this your Telegram account?"
        confirmLabel="Make this my account"
        destructive={false}
        onCancel={() => setToOwn(null)}
        onConfirm={async () => {
          if (!toOwn) return;
          const who = toOwn;
          const r = await run(`owner-${who.id}`, () => api.telegram.makeOwner(who.id), {
            success: `Telegram user ${who.telegram_user_id} is now your account`,
            errorTitle: 'Could not change your Telegram account',
          });
          if (r) {
            setToOwn(null);
            status.reload();
          }
        }}
      >
        <p>
          Telegram user <Mono>{toOwn?.telegram_user_id}</Mono>
          {toOwn?.username ? ` (@${toOwn.username})` : ''} becomes the NEBULA owner’s account. From Telegram it can approve agent actions, answer sign-in requests and open the
          administration area. Choose it only if this Telegram account is yours.
        </p>
        {ownerUser && ownerUser.id !== toOwn?.id && (
          <p className="mt-2 text-muted">
            Your current account (ID <Mono>{ownerUser.telegram_user_id}</Mono>) becomes an operator: it keeps chatting with agents, but can no longer approve anything.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
