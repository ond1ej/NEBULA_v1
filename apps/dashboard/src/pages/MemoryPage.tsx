import { useId } from 'react';
import { api } from '../api';
import { IconMemory } from '../components/icons';
import { MemoryManager } from '../components/MemoryManager';
import { StatusPill } from '../components/StatusPill';
import { Avatar, ButtonLink, EmptyState, ErrorBanner, LoadingCards, PageHeader, Select } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { href, navigate } from '../hooks/useHashRoute';

export function MemoryPage({ query }: { query: URLSearchParams }) {
  const selectId = useId();
  const agents = useApi(() => api.agents.list(), []);
  const list = agents.data ?? [];
  const wanted = query.get('agent');
  const agent = list.find((a) => a.id === wanted) ?? list[0] ?? null;

  return (
    <>
      <PageHeader
        title="Memory"
        description="Long-term knowledge of every agent: facts, notes, decisions, owner preferences, task episodes and project knowledge. Stored locally in SQLite."
      />
      {agents.error && !agents.data ? (
        <ErrorBanner error={agents.error} onRetry={agents.reload} />
      ) : !agents.data ? (
        <LoadingCards count={2} className="grid gap-3 md:grid-cols-2" label="Loading agents…" />
      ) : list.length === 0 ? (
        <EmptyState icon={<IconMemory />} title="No agents yet" action={<ButtonLink variant="primary" href={href('/agents/new')}>Create an agent</ButtonLink>}>
          Memory belongs to an agent. Create one first.
        </EmptyState>
      ) : (
        agent && (
          <>
            <div className="mb-5 flex flex-col gap-3 rounded-xl border border-border bg-panel p-3 shadow-card sm:flex-row sm:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={agent.name} id={agent.id} />
                <div className="min-w-0">
                  <label htmlFor={selectId} className="block text-2xs font-medium text-subtle">
                    Agent
                  </label>
                  <p className="truncate text-sm font-medium text-text">{agent.name}</p>
                </div>
                <StatusPill state={agent.state} />
              </div>
              <Select
                id={selectId}
                value={agent.id}
                onChange={(e) => navigate(`/memory?agent=${encodeURIComponent(e.target.value)}`, { replace: true })}
                className="sm:ml-auto sm:w-64"
              >
                {list.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <MemoryManager key={agent.id} agent={agent} onAgentChanged={agents.reload} />
          </>
        )
      )}
    </>
  );
}
