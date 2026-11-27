// Route #/files[?root=<root id>&path=<folder>]: choose a location (agent workspace, team folder,
// Mac exchange folder), then browse it with the FileManager.
import { useId } from 'react';
import { EmptyState, ErrorBanner, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { href, navigate, useHashRoute } from '../../hooks/useHashRoute';
import { filesApi } from './api';
import { FileManager } from './FileManager';
import { RootIcon } from './icons';
import { ROOT_PATH } from './paths';
import type { FileRoot } from './types';

const GROUPS: { type: string; title: string; hint: string }[] = [
  { type: 'agent', title: 'Agent workspaces', hint: 'Each agent’s home workspace in the VM.' },
  { type: 'team', title: 'Team folders', hint: 'Shared directories of teams.' },
  { type: 'exchange', title: 'Mac', hint: 'A dedicated folder on the Mac for files you exchange with agents.' },
];

export function filesHref(root: string, path = ROOT_PATH): string {
  const qs = new URLSearchParams({ root });
  if (path && path !== ROOT_PATH) qs.set('path', path);
  return href(`/files?${qs.toString()}`);
}

function RootLink({ r, active }: { r: FileRoot; active: boolean }) {
  return (
    <a
      href={filesHref(r.id)}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-11 items-center gap-2.5 rounded-md px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-accent lg:min-h-9 ${
        active ? 'bg-accent/15 font-medium text-text' : 'text-muted hover:bg-panel-2 hover:text-text'
      }`}
    >
      <RootIcon type={r.type} className={`size-4 shrink-0 ${active ? 'text-accent-soft' : ''}`} />
      <span className="min-w-0 flex-1 truncate">{r.label.replace(/^Team · /, '')}</span>
      {r.status && r.status !== 'READY' && r.status !== 'IDLE' && r.status !== 'ACTIVE' && (
        <span className="shrink-0 text-[10.5px] text-subtle lowercase">{r.status.replace(/_/g, ' ')}</span>
      )}
    </a>
  );
}

export function FilesPage() {
  const route = useHashRoute();
  const selectId = useId();
  const roots = useApi((s) => filesApi.roots(s), []);
  const rootParam = route.query.get('root');
  const pathParam = route.query.get('path') ?? ROOT_PATH;
  const list = roots.data ?? [];
  const current = list.find((r) => r.id === rootParam) ?? null;

  const header = (
    <PageHeader
      title="Files"
      description="Browse, upload, preview and edit files in agent workspaces, team folders and the Mac exchange folder. Agents never see your Mac’s files — only what you put into the exchange folder through NEBULA."
    />
  );

  if (roots.error && !roots.data)
    return (
      <>
        {header}
        <ErrorBanner error={roots.error} onRetry={roots.reload} title="Could not load file locations" />
      </>
    );
  if (!roots.data) return (
    <>
      {header}
      <Spinner label="Loading file locations…" />
    </>
  );

  const chooser = (
    <nav aria-label="File locations" className="flex flex-col gap-4">
      {GROUPS.map((g) => {
        const items = list.filter((r) => r.type === g.type);
        if (items.length === 0) return null;
        return (
          <section key={g.type} aria-label={g.title}>
            <h2 className="mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">{g.title}</h2>
            <ul className="flex flex-col gap-0.5">
              {items.map((r) => (
                <li key={r.id}>
                  <RootLink r={r} active={r.id === current?.id} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );

  if (!current) {
    return (
      <>
        {header}
        {rootParam && (
          <div className="mb-4">
            <ErrorBanner error={new Error(`The location “${rootParam}” does not exist (anymore).`)} title="Unknown location" />
          </div>
        )}
        {list.length === 0 ? (
          <EmptyState title="No file locations yet">Create an agent to get a workspace.</EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {GROUPS.map((g) => {
              const items = list.filter((r) => r.type === g.type);
              if (items.length === 0) return null;
              return (
                <section key={g.type} className="rounded-xl border border-border bg-panel p-4" aria-label={g.title}>
                  <h2 className="text-sm font-semibold text-text">{g.title}</h2>
                  <p className="mt-0.5 mb-3 text-xs text-muted">{g.hint}</p>
                  <ul className="flex flex-col gap-0.5">
                    {items.map((r) => (
                      <li key={r.id}>
                        <RootLink r={r} active={false} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {header}
      <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-6">
        <aside className="hidden lg:block">{chooser}</aside>
        <div className="mb-3 lg:hidden">
          <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-text">
            Location
          </label>
          <Select
            id={selectId}
            value={current.id}
            onChange={(e) => navigate(filesHref(e.target.value))}
            className="min-h-11"
          >
            {GROUPS.map((g) => {
              const items = list.filter((r) => r.type === g.type);
              return items.length ? (
                <optgroup key={g.type} label={g.title}>
                  {items.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </Select>
        </div>
        <div className="min-w-0">
          <FileManager
            key={current.id}
            root={current.id}
            initialPath={pathParam}
            onLocationChange={(r, p) => {
              const target = filesHref(r, p);
              if (window.location.hash !== target) navigate(target, { replace: true });
            }}
          />
        </div>
      </div>
    </>
  );
}
