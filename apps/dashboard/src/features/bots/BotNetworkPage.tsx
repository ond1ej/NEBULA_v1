// Telegram Bot Network (#/bots): the main NEBULA bot plus one independent bot per agent (multibot.py).
import { useMemo, useState } from 'react';
import { IconBots, IconExternal, IconKey, IconPlus, IconRefresh, IconSparkle, IconTelegram, IconTrash } from '../../components/icons';
import { ConfirmDialog, Modal } from '../../components/Modal';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorBanner,
  KeyValue,
  LoadingCards,
  Mono,
  Notice,
  PageHeader,
  Stat,
  Switch,
  TextLink,
} from '../../components/ui';
import { useAction, useApi, useNow } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href } from '../../hooks/useHashRoute';
import { formatTime, relativeTime } from '../../lib/format';
import { AddBotWizard, MetadataResults } from './AddBotWizard';
import { botsApi, userLabel, type AgentBot, type AgentBotUser, type BotMetadataResult, type BotNetwork, type BotPairing, type MainBot } from './api';
import { BOT_STATUS_HINT, BotStatusBadge, NotifyLevelSelect, PairingCode, PollingIndicator } from './parts';

const USER_TONE = { approved: 'success', pending: 'warn', revoked: 'neutral' } as const;

function UserStatus({ status }: { status: string }) {
  return (
    <Badge tone={USER_TONE[status as keyof typeof USER_TONE] ?? 'neutral'} dot>
      {status}
    </Badge>
  );
}

function When({ ts }: { ts: number | null | undefined }) {
  return ts ? (
    <time dateTime={new Date(ts * 1000).toISOString()} title={formatTime(ts)}>
      {relativeTime(ts)}
    </time>
  ) : (
    <span className="text-subtle">never</span>
  );
}

// ---------------------------------------------------------------- main bot
function MainBotCard({ main, onChanged }: { main: MainBot; onChanged: () => void }) {
  const configured = Boolean(main.configured);
  const users = main.users ?? [];
  const pendingCount = users.filter((u) => u.status === 'pending').length;
  return (
    <Card
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Main NEBULA bot
          {main.bot_username && <Mono className="text-text">@{main.bot_username}</Mono>}
        </span>
      }
      subtitle="Talks to every agent (topics / agent picker), receives system notifications."
      icon={<IconTelegram />}
      actions={
        <ButtonLink size="sm" href={href('/telegram')} icon={<IconTelegram />}>
          Manage main bot
        </ButtonLink>
      }
    >
      {!configured ? (
        <EmptyState compact title="The main bot is not configured" action={<ButtonLink size="sm" variant="primary" href={href('/telegram')}>Set up Telegram</ButtonLink>}>
          Agent bots work on their own, but approvals for users already paired with the main bot need it.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <KeyValue
            items={[
              ['Polling', <PollingIndicator key="p" polling={main.polling} enabled={main.enabled !== false} />],
              ['Last poll', <When key="lp" ts={main.last_poll_at} />],
              ['Bot ID', main.bot_id ? <Mono key="id">{main.bot_id}</Mono> : '—'],
            ]}
          />
          {main.last_error && (
            <Notice tone="danger" title="Last error">
              <span className="break-words">{main.last_error}</span>
            </Notice>
          )}
          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-text">Paired users</h3>
              {pendingCount > 0 && (
                <TextLink href={href('/telegram')} className="text-xs">
                  {pendingCount} pending — approve on the Telegram page
                </TextLink>
              )}
            </div>
            {users.length === 0 ? (
              <p className="text-sm text-muted">Nobody is paired with the main bot yet.</p>
            ) : (
              <ul className="divide-y divide-border/60 rounded-xl border border-border">
                {users.map((u) => (
                  <li key={u.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={userLabel(u)} id={String(u.telegram_user_id)} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm text-text">{userLabel(u)}</p>
                        <p className="flex flex-wrap items-center gap-1.5 text-2xs text-subtle">
                          <span>ID {u.telegram_user_id}</span>
                          <UserStatus status={u.status} />
                        </p>
                      </div>
                    </div>
                    {u.status === 'approved' && <NotifyLevelSelect userRowId={u.id} value={u.notify_level} userName={userLabel(u)} onSaved={onChanged} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- agent bot
function BotUserRow({ bot, user, onBot }: { bot: AgentBot; user: AgentBotUser; onBot: (b: AgentBot) => void }) {
  const { run, isPending } = useAction();
  const name = userLabel(user);
  const act = async (action: 'approve' | 'revoke') => {
    const r = await run(action, () => (action === 'approve' ? botsApi.approveUser(bot.id, user.id) : botsApi.revokeUser(bot.id, user.id)), {
      success: action === 'approve' ? `${name} approved for @${bot.username ?? 'bot'}` : `${name} can no longer use @${bot.username ?? 'bot'}`,
      errorTitle: action === 'approve' ? 'Could not approve the user' : 'Could not revoke the user',
    });
    if (r) onBot(r);
  };
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={name} id={String(user.telegram_user_id)} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm text-text">{name}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-2xs text-subtle">
            <span>ID {user.telegram_user_id}</span>
            <UserStatus status={user.status} />
            <span>{user.status === 'approved' && user.approved_at ? `since ${relativeTime(user.approved_at)}` : `requested ${relativeTime(user.created_at)}`}</span>
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {user.status === 'approved' && <NotifyLevelSelect userRowId={user.id} value={user.notify_level} userName={name} />}
        {user.status !== 'approved' && (
          <Button size="xs" variant="primary" onClick={() => act('approve')} loading={isPending('approve')} disabled={isPending('revoke')}>
            {user.status === 'revoked' ? 'Re-approve' : 'Approve'}
          </Button>
        )}
        {user.status !== 'revoked' && (
          <Button size="xs" variant="danger" onClick={() => act('revoke')} loading={isPending('revoke')} disabled={isPending('approve')}>
            {user.status === 'pending' ? 'Reject' : 'Revoke'}
          </Button>
        )}
      </div>
    </li>
  );
}

function AgentBotCard({ bot, onBot, onRemoved }: { bot: AgentBot; onBot: (b: AgentBot) => void; onRemoved: (id: string) => void }) {
  const { run, isPending } = useAction();
  const [pairing, setPairing] = useState<BotPairing | null>(null);
  const [meta, setMeta] = useState<BotMetadataResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const handle = bot.username ? `@${bot.username}` : `bot ${bot.bot_id}`;
  const users = [...bot.users].sort((a, b) => (a.status === b.status ? a.created_at - b.created_at : a.status === 'pending' ? -1 : b.status === 'pending' ? 1 : a.status === 'approved' ? -1 : 1));
  const pending = users.filter((u) => u.status === 'pending').length;

  const newPairing = async () => {
    const r = await run('pair', () => botsApi.pairing(bot.id), { errorTitle: 'Could not create a pairing code' });
    if (r) setPairing(r);
  };

  return (
    <Card
      title={
        <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
          {bot.username ? (
            <a href={`https://t.me/${bot.username}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded hover:underline focus-ring">
              {handle}
              <IconExternal className="size-3.5 text-subtle" />
            </a>
          ) : (
            handle
          )}
        </span>
      }
      subtitle={
        <span>
          Bound to{' '}
          <TextLink href={href(`/agents/${bot.agent_id}`)}>{bot.agent_name ?? bot.agent_id.slice(0, 8)}</TextLink>
          {bot.display_name ? ` · “${bot.display_name}”` : ''}
        </span>
      }
      icon={<IconBots />}
      actions={
        <>
          {pending > 0 && <Badge tone="warn">{pending} pending</Badge>}
          <BotStatusBadge status={bot.status} />
        </>
      }
      footer={
        <>
          <Button size="sm" icon={<IconKey />} onClick={newPairing} loading={isPending('pair')} disabledReason={!bot.enabled ? 'Enable the bot first' : null}>
            Pairing code
          </Button>
          <Button
            size="sm"
            icon={<IconRefresh />}
            onClick={async () => {
              const r = await run('reconnect', () => botsApi.reconnect(bot.id), { success: `${handle} reconnected`, errorTitle: 'Reconnect failed' });
              if (r) onBot(r);
            }}
            loading={isPending('reconnect')}
            disabledReason={!bot.enabled ? 'Enable the bot first' : null}
          >
            Reconnect
          </Button>
          <Button
            size="sm"
            icon={<IconSparkle />}
            onClick={async () => {
              const r = await run('configure', () => botsApi.configure(bot.id), { errorTitle: 'Could not apply the metadata' });
              if (r) setMeta(r);
            }}
            loading={isPending('configure')}
            disabledReason={!bot.token_stored ? 'The token is missing' : null}
          >
            Re-apply metadata
          </Button>
          <Button size="sm" variant="danger" icon={<IconTrash />} onClick={() => setConfirmRemove(true)}>
            Remove binding
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Switch
          checked={bot.enabled}
          loading={isPending('enabled')}
          label={bot.enabled ? 'Enabled' : 'Disabled'}
          description={bot.enabled ? 'Polling Telegram and delivering this agent’s notifications.' : 'No polling and no notifications until you enable it again.'}
          onChange={async (v) => {
            const r = await run('enabled', () => botsApi.setEnabled(bot.id, v), { success: v ? `${handle} enabled` : `${handle} disabled`, errorTitle: 'Could not change the bot state' });
            if (r) onBot(r);
          }}
        />
        <KeyValue
          items={[
            ['Polling', <PollingIndicator key="p" polling={bot.polling} enabled={bot.enabled} />],
            ['Last poll', <When key="lp" ts={bot.last_poll_at} />],
            ['Last update', <When key="lu" ts={bot.last_update_at} />],
            ['Token', bot.token_stored ? <span key="t" className="text-muted">Stored in the Keychain (never shown)</span> : <span key="t" className="text-danger">Missing — remove and re-add the bot</span>],
          ]}
        />
        {(bot.status === 'REVOKED' || bot.status === 'ERROR') && <Notice tone="danger">{BOT_STATUS_HINT[bot.status]}</Notice>}
        {bot.last_error && (
          <Notice tone={bot.status === 'ACTIVE' ? 'warn' : 'danger'} title="Last error">
            <span className="break-words">{bot.last_error}</span>
          </Notice>
        )}
        {pairing && <PairingCode pairing={pairing} botUsername={bot.username} onNew={newPairing} busy={isPending('pair')} />}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">Paired users</h3>
          {users.length === 0 ? (
            <p className="text-sm text-muted">Nobody has paired with {handle} yet. Create a pairing code and send it to the bot.</p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-xl border border-border">
              {users.map((u) => (
                <BotUserRow key={u.id} bot={bot} user={u} onBot={onBot} />
              ))}
            </ul>
          )}
        </div>
      </div>

      <Modal open={meta !== null} onClose={() => setMeta(null)} title={`Metadata for ${handle}`} size="sm" footer={<Button onClick={() => setMeta(null)}>Close</Button>}>
        {meta && <MetadataResults meta={meta} />}
      </Modal>
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove the binding for ${handle}?`}
        confirmLabel="Remove binding"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          const r = await run('remove', () => botsApi.remove(bot.id), { errorTitle: 'Could not remove the binding' });
          if (r) {
            setConfirmRemove(false);
            onRemoved(bot.id);
          }
        }}
      >
        <p>
          NEBULA stops polling {handle}, deletes its token from the Keychain and forgets its paired users. <strong>{bot.agent_name ?? 'The agent'}</strong> itself is not affected.
        </p>
        <p>The bot still exists in Telegram — delete it in @BotFather (/deletebot) if you no longer need it.</p>
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------- page
export function BotNetworkPage(_props: Record<string, never>) {
  const net = useApi<BotNetwork>((s) => botsApi.list(s), [], { pollMs: 30_000 });
  const [wizard, setWizard] = useState(false);
  const agents = useApi((s) => botsApi.agents(s), [wizard]);
  useNow(30_000);
  useLiveRefresh(net.reload, (e) => e.type === 'bot.state.changed' || e.type.startsWith('telegram.'), 500);

  const d = net.data;
  const bots = d?.agent_bots ?? [];
  const bound = useMemo(() => new Set(bots.map((b) => b.agent_id)), [bots]);

  const replaceBot = (b: AgentBot) => net.setData((prev) => (prev ? { ...prev, agent_bots: prev.agent_bots.map((x) => (x.id === b.id ? { ...x, ...b } : x)) } : prev));
  const removeBot = (id: string) => {
    net.setData((prev) => (prev ? { ...prev, agent_bots: prev.agent_bots.filter((x) => x.id !== id) } : prev));
    net.reload();
  };

  return (
    <>
      <PageHeader
        title="Telegram Bot Network"
        icon={<IconBots className="size-6 text-accent-soft" />}
        description="One shared gateway, many bot identities: the main NEBULA bot plus an independent bot per agent. Each agent bot routes messages, files and approvals only to its own agent."
        actions={
          <Button variant="primary" icon={<IconPlus />} onClick={() => setWizard(true)}>
            Add agent bot
          </Button>
        }
      />

      {net.error && !d ? (
        <ErrorBanner error={net.error} onRetry={net.reload} title="Could not load the bot network" />
      ) : !d ? (
        <LoadingCards count={3} label="Loading bots…" />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Agent bots" value={d.status.bots} hint={`${bots.filter((b) => b.enabled).length} enabled`} icon={<IconBots />} />
            <Stat label="Polling" value={d.status.polling} hint="Agent bots with a live poll loop" tone={d.status.polling ? 'success' : undefined} />
            <Stat label="Errors" value={d.status.errors} hint="ERROR or REVOKED" tone={d.status.errors ? 'danger' : undefined} />
            <Stat label="Main bot" value={<span className="text-lg">{d.main.configured ? (d.main.polling ? 'Polling' : 'Idle') : 'Not set up'}</span>} hint={d.main.bot_username ? `@${d.main.bot_username}` : '—'} tone={d.main.polling ? 'success' : 'warn'} icon={<IconTelegram />} />
          </div>

          <MainBotCard main={d.main} onChanged={net.reload} />

          <section aria-labelledby="agent-bots-h">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="agent-bots-h" className="text-sm font-semibold text-text">
                  Agent bots
                </h2>
                <p className="mt-0.5 text-xs text-muted">Pairing is per bot. Owners already approved on the main bot are approved automatically when they present a valid code.</p>
              </div>
            </div>
            {bots.length === 0 ? (
              <EmptyState
                icon={<IconBots />}
                title="No agent has its own bot yet"
                action={
                  <Button variant="primary" icon={<IconPlus />} onClick={() => setWizard(true)}>
                    Add agent bot
                  </Button>
                }
              >
                Create a bot in @BotFather and bind it to an agent — then you can chat with that agent directly in Telegram.
              </EmptyState>
            ) : (
              <div className="grid gap-5 xl:grid-cols-2">
                {bots.map((b) => (
                  <AgentBotCard key={b.id} bot={b} onBot={replaceBot} onRemoved={removeBot} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      <AddBotWizard
        open={wizard}
        onClose={() => setWizard(false)}
        agents={agents.data}
        boundAgentIds={bound}
        onAdded={(b) => {
          net.setData((prev) => (prev ? { ...prev, agent_bots: [...prev.agent_bots.filter((x) => x.id !== b.id), b] } : prev));
          net.reload();
        }}
      />
    </>
  );
}
