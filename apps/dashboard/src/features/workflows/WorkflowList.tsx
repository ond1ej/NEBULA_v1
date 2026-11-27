// Workflow list: last run, enable/disable, duplicate, export, import, delete.
import { useRef, useState, type ChangeEvent } from 'react';
import { ConfirmDialog } from '../../components/Modal';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import { Button, EmptyState, ErrorBanner, PageHeader, Spinner } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { useLiveRefresh } from '../../hooks/useEvents';
import { href, navigate } from '../../hooks/useHashRoute';
import { downloadBlob, formatTime, relativeTime } from '../../lib/format';
import { workflowsApi } from './api';
import { ACTIVE_RUN_STATES } from './graph';
import { IconCopy, IconDownload, IconPlus, IconTrash, IconUpload } from './icons';
import { Switch } from './Switch';
import type { WorkflowListItem } from './types';

const prettyTrigger = (t: string) => {
  const s = (t.split('.').pop() ?? t).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'workflow'
  );
}

export function WorkflowList() {
  const toast = useToast();
  const list = useApi((s) => workflowsApi.list(s), []);
  useLiveRefresh(list.reload, (ev) => ev.type.startsWith('workflow.'), 600);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowListItem | null>(null);

  const mark = (id: string, what: string | null) =>
    setBusy((b) => {
      const n = { ...b };
      if (what) n[id] = what;
      else delete n[id];
      return n;
    });

  const setEnabled = async (w: WorkflowListItem, v: boolean) => {
    mark(w.id, 'enabled');
    try {
      const r = await workflowsApi.setEnabled(w.id, v);
      list.setData((xs) => xs?.map((x) => (x.id === w.id ? { ...x, enabled: r.enabled } : x)) ?? xs);
      toast.success(r.enabled ? `“${w.name}” enabled` : `“${w.name}” disabled`);
    } catch (e) {
      toast.error(e, 'Could not change the workflow state');
    } finally {
      mark(w.id, null);
    }
  };

  const duplicate = async (w: WorkflowListItem) => {
    mark(w.id, 'duplicate');
    try {
      const r = await workflowsApi.duplicate(w.id);
      toast.success('Workflow duplicated', `“${r.name}” was created disabled.`);
      list.reload();
    } catch (e) {
      toast.error(e, 'Could not duplicate');
    } finally {
      mark(w.id, null);
    }
  };

  const exportOne = async (w: WorkflowListItem) => {
    mark(w.id, 'export');
    try {
      const doc = await workflowsApi.exportDoc(w.id);
      downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), `${slugify(w.name)}.nebula-workflow.json`);
    } catch (e) {
      toast.error(e, 'Could not export');
    } finally {
      mark(w.id, null);
    }
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error(new Error('The file is larger than 5 MB — not a workflow export.'), 'Import failed');
      return;
    }
    setImporting(true);
    try {
      let doc: unknown;
      try {
        doc = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not valid JSON.`);
      }
      const w = await workflowsApi.importDoc(doc);
      toast.success('Workflow imported', `“${w.name}” was created disabled — review it, then enable it.`);
      navigate(`/workflows/${encodeURIComponent(w.id)}`);
    } catch (err) {
      toast.error(err, 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const items = list.data ?? [];
  return (
    <>
      <PageHeader
        title="Workflows"
        description="Visual automations executed by NEBULA: triggers start them, actions run agents, teams, files and Telegram, logic blocks branch, loop, wait and ask for approval."
        actions={
          <>
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onImportFile} aria-hidden tabIndex={-1} />
            <Button onClick={() => fileRef.current?.click()} loading={importing} className="max-sm:min-h-11">
              <IconUpload /> Import
            </Button>
            <a
              href={href('/workflows/new')}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium whitespace-nowrap text-white hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:h-11"
            >
              <IconPlus /> New workflow
            </a>
          </>
        }
      />
      {list.error ? (
        <div className="mb-4">
          <ErrorBanner error={list.error} onRetry={list.reload} title="Could not load workflows" />
        </div>
      ) : null}
      {!list.data && list.loading ? (
        <Spinner label="Loading workflows…" />
      ) : list.data && items.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          action={
            <a className="text-sm font-medium text-accent-soft underline" href={href('/workflows/new')}>
              Create your first workflow
            </a>
          }
        >
          Build one on the canvas, or import a <code>.json</code> export.
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {items.map((w) => {
            const last = w.last_run;
            const b = busy[w.id];
            return (
              <li key={w.id} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-panel p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={href(`/workflows/${encodeURIComponent(w.id)}`)}
                      className="block truncate text-base font-semibold text-text hover:text-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {w.name}
                    </a>
                    {w.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{w.description}</p>}
                  </div>
                  <Switch checked={w.enabled} onChange={(v) => void setEnabled(w, v)} busy={b === 'enabled'} label={`${w.enabled ? 'Disable' : 'Enable'} ${w.name}`} />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {(w.trigger_types ?? []).map((t) => (
                    <span key={t} className="rounded bg-info/10 px-1.5 py-0.5 text-info">
                      {prettyTrigger(t)}
                    </span>
                  ))}
                  <span className="text-subtle">
                    v{w.version} · {w.definition?.nodes?.length ?? 0} blocks · {w.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  {last ? (
                    <a
                      href={href(`/workflows/${encodeURIComponent(w.id)}?run=${encodeURIComponent(last.id)}`)}
                      className="inline-flex items-center gap-2 rounded hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                      title={formatTime(last.created_at)}
                    >
                      <span>Last run</span>
                      <StatusPill state={last.state} pulse={ACTIVE_RUN_STATES.has(last.state)} />
                      <span>{relativeTime(last.created_at)}</span>
                    </a>
                  ) : (
                    <span>Never run</span>
                  )}
                </div>
                <div className="mt-auto flex flex-wrap gap-2 border-t border-border/70 pt-3">
                  <a
                    href={href(`/workflows/${encodeURIComponent(w.id)}`)}
                    className="inline-flex h-8 items-center rounded-md border border-border bg-panel-2 px-3 text-xs font-medium text-text hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-accent max-sm:h-11"
                  >
                    Open editor
                  </a>
                  <Button size="sm" onClick={() => void duplicate(w)} loading={b === 'duplicate'} aria-label={`Duplicate ${w.name}`} className="max-sm:min-h-11">
                    <IconCopy /> Duplicate
                  </Button>
                  <Button size="sm" onClick={() => void exportOne(w)} loading={b === 'export'} aria-label={`Export ${w.name}`} className="max-sm:min-h-11">
                    <IconDownload /> Export
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(w)} aria-label={`Delete ${w.name}`} className="text-danger hover:text-danger max-sm:min-h-11">
                    <IconTrash /> Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete workflow?"
        confirmLabel="Delete workflow"
        busyText="Deleting…"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          const w = confirmDelete;
          if (!w) return;
          try {
            await workflowsApi.remove(w.id);
            toast.success(`“${w.name}” deleted`);
            list.setData((xs) => xs?.filter((x) => x.id !== w.id) ?? xs);
            setConfirmDelete(null);
          } catch (e) {
            toast.error(e, 'Could not delete');
          }
        }}
      >
        <p>
          “<strong>{confirmDelete?.name}</strong>” and its run history are deleted permanently. Running runs are cancelled and its schedules are removed.
          This cannot be undone — export it first if you may need it again.
        </p>
      </ConfirmDialog>
    </>
  );
}
