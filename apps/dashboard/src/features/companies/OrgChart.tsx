// Organisation chart: reporting tree (CEO at the top) of agent cards with role, model, status, lifecycle,
// environment and current activity. Horizontal tree on wide screens, indented tree on phones.
import { IconExternal, IconUser } from '../../components/icons';
import { Drawer } from '../../components/Modal';
import { BUSY_STATES, StatusPill } from '../../components/StatusPill';
import { Avatar, Badge, ButtonLink, EmptyState, KeyValue, Mono, TextLink } from '../../components/ui';
import { href } from '../../hooks/useHashRoute';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { EnvBadge, EnvChain } from '../environment/EnvBadge';
import { buildOrgTree, LIFECYCLE_TEXT, LIFECYCLE_TONE, type TreeNode } from './lib';
import type { OrgNode } from './types';

export function LifecycleBadge({ lifecycle }: { lifecycle: string }) {
  return (
    <Badge tone={LIFECYCLE_TONE[lifecycle] ?? 'neutral'} dot title={LIFECYCLE_TEXT[lifecycle]}>
      {lifecycle}
    </Badge>
  );
}

function NodeCard({ n, selected, onSelect, isRoot }: { n: OrgNode; selected: boolean; onSelect?: (n: OrgNode) => void; isRoot: boolean }) {
  const role = n.title ? `${n.title} · ${n.role}` : n.role;
  const Tag = onSelect ? 'button' : 'div';
  return (
    <Tag
      type={onSelect ? 'button' : undefined}
      onClick={onSelect ? () => onSelect(n) : undefined}
      aria-label={onSelect ? `${n.name}, ${role}, ${n.lifecycle.toLowerCase()}` : undefined}
      aria-pressed={onSelect ? selected : undefined}
      data-agent={n.agent_id}
      className={`block w-[15.5rem] max-w-full rounded-xl border bg-panel p-3 text-left shadow-card transition-colors ${onSelect ? 'hover:border-border-hover focus-ring' : ''} ${
        selected ? 'border-accent/60 bg-accent/[0.06]' : isRoot && n.role_key === 'ceo' ? 'border-accent/35' : 'border-border'
      }`}
    >
      <span className="flex items-start gap-2.5">
        <Avatar name={n.name} id={n.agent_id} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text">{n.name}</span>
          <span className="block truncate text-xs text-accent-soft">{role}</span>
        </span>
      </span>
      <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <StatusPill state={n.status} pulse={BUSY_STATES.has(n.status)} />
        <LifecycleBadge lifecycle={n.lifecycle} />
        <EnvBadge env={n.environment?.env} source={n.environment?.source} chain={n.environment?.chain} interactive={false} />
      </span>
      <span className="mt-2 block truncate font-mono text-[11px] text-subtle">{n.model ?? 'no AI model configured'}</span>
      <span className="mt-1.5 block truncate border-t border-border/70 pt-1.5 text-xs text-muted">
        {n.current_item ? (
          <>
            <span className="text-subtle">{n.current_item.state === 'RUNNING' ? 'Working on' : 'Next'}: </span>
            {n.current_item.title}
          </>
        ) : (
          <span className="text-subtle">No assigned work</span>
        )}
      </span>
    </Tag>
  );
}

function DesktopTree({ t, selectedId, onSelect, depth }: { t: TreeNode<OrgNode>; selectedId: string | null; onSelect?: (n: OrgNode) => void; depth: number }) {
  const kids = t.children;
  return (
    <div className="flex flex-col items-center">
      <NodeCard n={t.node} selected={selectedId === t.node.agent_id} onSelect={onSelect} isRoot={depth === 0} />
      {kids.length > 0 && (
        <>
          <span aria-hidden className="h-5 w-px bg-border-strong" />
          <ul aria-label={`Reports to ${t.node.name}`} className="flex">
            {kids.map((c, i) => (
              <li key={c.node.agent_id} className="relative flex flex-col items-center px-2.5">
                {kids.length > 1 && (
                  <span aria-hidden className="absolute top-0 h-px bg-border-strong" style={{ left: i === 0 ? '50%' : 0, right: i === kids.length - 1 ? '50%' : 0 }} />
                )}
                <span aria-hidden className="h-5 w-px bg-border-strong" />
                <DesktopTree t={c} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function MobileTree({ t, selectedId, onSelect, depth }: { t: TreeNode<OrgNode>; selectedId: string | null; onSelect?: (n: OrgNode) => void; depth: number }) {
  return (
    <li className="relative">
      {depth > 0 && <span aria-hidden className="absolute top-8 -left-3 h-px w-3 bg-border-strong" />}
      <NodeCard n={t.node} selected={selectedId === t.node.agent_id} onSelect={onSelect} isRoot={depth === 0} />
      {t.children.length > 0 && (
        <ul aria-label={`Reports to ${t.node.name}`} className="mt-2 ml-3 space-y-2 border-l border-border-strong pl-3">
          {t.children.map((c) => (
            <MobileTree key={c.node.agent_id} t={c} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgChart({ nodes, selectedId = null, onSelect, label = 'Organisation chart' }: { nodes: OrgNode[]; selectedId?: string | null; onSelect?: (n: OrgNode) => void; label?: string }) {
  const mobile = useIsMobile();
  const tree = buildOrgTree(nodes);
  if (nodes.length === 0)
    return (
      <EmptyState compact icon={<IconUser />} title="No employees yet">
        Assign agents to roles in the Employees tab.
      </EmptyState>
    );
  if (mobile)
    return (
      <ul aria-label={label} className="space-y-3">
        {tree.map((t) => (
          <MobileTree key={t.node.agent_id} t={t} selectedId={selectedId} onSelect={onSelect} depth={0} />
        ))}
      </ul>
    );
  return (
    <div className="overflow-x-auto pb-2">
      <ul aria-label={label} className="mx-auto flex w-max min-w-full justify-center gap-8 px-2 py-1">
        {tree.map((t) => (
          <li key={t.node.agent_id}>
            <DesktopTree t={t} selectedId={selectedId} onSelect={onSelect} depth={0} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OrgMemberDrawer({ node, nodes, onClose }: { node: OrgNode | null; nodes: OrgNode[]; onClose: () => void }) {
  const manager = node?.reports_to ? nodes.find((n) => n.agent_id === node.reports_to) : null;
  const reports = node ? nodes.filter((n) => n.reports_to === node.agent_id) : [];
  return (
    <Drawer
      open={node !== null}
      onClose={onClose}
      title={node?.name ?? ''}
      description={node ? (node.title ? `${node.title} · ${node.role}` : node.role) : undefined}
      footer={
        node ? (
          <>
            <ButtonLink href={href(`/agents/${node.agent_id}/environment`)}>Environment</ButtonLink>
            <ButtonLink variant="primary" href={href(`/agents/${node.agent_id}`)} icon={<IconExternal />}>
              Open agent
            </ButtonLink>
          </>
        ) : undefined
      }
    >
      {node && (
        <div className="space-y-5">
          <KeyValue
            items={[
              ['Role', node.role],
              ['Job title', node.title || '—'],
              ['Reports to', manager ? manager.name : node.role_key === 'ceo' ? 'Owner (you)' : '—'],
              ['Direct reports', reports.length ? reports.map((r) => r.name).join(', ') : 'none'],
              ['AI model', node.model ? <Mono key="m">{node.provider ? `${node.provider} · ` : ''}{node.model}</Mono> : <span className="text-warn">not configured</span>],
              ['Agent status', <StatusPill key="s" state={node.status} />],
              ['Lifecycle', <LifecycleBadge key="l" lifecycle={node.lifecycle} />],
              [
                'Current work',
                node.current_item ? (
                  <span key="c">
                    {node.current_item.title} <StatusPill state={node.current_item.state} />
                  </span>
                ) : (
                  'No assigned work'
                ),
              ],
            ]}
          />
          <div>
            <p className="mb-2 text-xs font-medium text-muted">Execution environment</p>
            <div className="space-y-3">
              <EnvBadge env={node.environment?.env} source={node.environment?.source} chain={node.environment?.chain} size="md" showSource />
              {node.environment?.chain?.length ? <EnvChain chain={node.environment.chain} levels={['company', 'project', 'member', 'assignment']} /> : null}
              <p className="text-xs text-muted">
                Outside a project the project and assignment levels do not apply. Change the employee override in the Employees tab, or{' '}
                <TextLink href={href(`/agents/${node.agent_id}/environment`)}>see the agent’s environment</TextLink>.
              </p>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
