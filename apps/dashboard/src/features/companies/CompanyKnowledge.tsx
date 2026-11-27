// Knowledge tab: company memory (requirements, decisions, docs, reports, knowledge) — list, search, add, delete.
import { useId, useState } from 'react';
import { IconMemory, IconPlus, IconSearch, IconTrash } from '../../components/icons';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, IconButton, Input, LoadingRows, SegmentedControl, Select, Textarea } from '../../components/ui';
import { useAction, useApi } from '../../hooks/useApi';
import { useDebounced } from '../../hooks/useDebounced';
import { formatTime, relativeTime } from '../../lib/format';
import { companiesApi } from './api';
import { KNOWLEDGE_KINDS } from './lib';
import type { CompanyDetail, Knowledge, KnowledgeKind } from './types';

const KIND_TONE: Record<string, 'accent' | 'info' | 'success' | 'warn' | 'neutral'> = {
  requirement: 'info',
  decision: 'warn',
  doc: 'neutral',
  report: 'success',
  knowledge: 'accent',
};

function AddKnowledgeDialog({ co, onClose, onAdded }: { co: CompanyDetail; onClose: () => void; onAdded: () => void }) {
  const ids = { kind: useId(), title: useId(), content: useId(), project: useId() };
  const toast = useToast();
  const [kind, setKind] = useState<KnowledgeKind>('requirement');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [project, setProject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const invalid = !title.trim() ? 'Give the entry a title' : !content.trim() ? 'Write the content' : null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await companiesApi.addKnowledge(co.id, { kind, title: title.trim(), content: content.trim(), project_id: project || null });
      toast.success('Saved to company knowledge');
      onAdded();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!busy}
      title="Add to company knowledge"
      description="Employees see relevant entries (requirements, decisions, docs, knowledge) as data in their work items. Never store secrets here."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabledReason={invalid} onClick={() => void save()}>
            Save entry
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field htmlFor={ids.kind} label="Kind">
            <Select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as KnowledgeKind)}>
              {KNOWLEDGE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field htmlFor={ids.project} label="Project" hint="Empty = applies to the whole company.">
            <Select id={ids.project} value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Whole company</option>
              {co.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field htmlFor={ids.title} label="Title" required>
          <Input id={ids.title} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} data-autofocus />
        </Field>
        <Field htmlFor={ids.content} label="Content" required aside={`${content.length} / 20000`}>
          <Textarea id={ids.content} rows={8} maxLength={20000} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
        {error ? <ErrorBanner error={error} title="Not saved" /> : null}
      </div>
    </Modal>
  );
}

function Entry({ k, projectName, onDelete }: { k: Knowledge; projectName: string | null; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const long = k.content.length > 280 || k.content.split('\n').length > 4;
  return (
    <li className="rounded-xl border border-border bg-panel-2 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={KIND_TONE[k.kind] ?? 'neutral'}>{k.kind}</Badge>
            {projectName && <Badge>{projectName}</Badge>}
          </div>
          <h3 className="mt-1.5 text-sm font-semibold break-words text-text">{k.title}</h3>
        </div>
        <IconButton size="sm" label={`Delete ${k.title}`} icon={<IconTrash />} onClick={onDelete} />
      </div>
      <p className={`mt-1.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-muted ${open ? '' : 'line-clamp-4'}`}>{k.content}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
        <span>{k.author.startsWith('system') ? 'written by NEBULA' : `by ${k.author}`}</span>
        <time title={formatTime(k.created_at)}>{relativeTime(k.created_at)}</time>
        {long && (
          <button type="button" className="rounded text-accent-soft hover:underline focus-ring" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
    </li>
  );
}

export function CompanyKnowledge({ co, version }: { co: CompanyDetail; version: number }) {
  const searchId = useId();
  const [kind, setKind] = useState('all');
  const [project, setProject] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const list = useApi((s) => companiesApi.knowledge(co.id, { kind: kind === 'all' ? undefined : kind, project_id: project || undefined, q: dq || undefined }, s), [co.id, kind, project, dq, version]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Knowledge | null>(null);
  const { run } = useAction();
  const pname = (id: string | null) => (id ? (co.projects.find((p) => p.id === id)?.name ?? 'deleted project') : null);
  const rows = list.data ?? [];
  return (
    <Card
      title="Company knowledge"
      icon={<IconMemory />}
      subtitle="Shared memory of the company: requirements, decisions, docs and run reports."
      actions={
        <Button size="sm" variant="primary" icon={<IconPlus />} onClick={() => setAdding(true)}>
          Add entry
        </Button>
      }
    >
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end">
        <SegmentedControl
          label="Knowledge kind"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[{ value: 'all', label: 'All' }, ...KNOWLEDGE_KINDS.map((k) => ({ value: k.value, label: k.label }))]}
        />
        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              Search knowledge
            </label>
            <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
            <Input id={searchId} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles and content" className="pl-9" />
          </div>
          <Select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {co.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (+ company-wide)
              </option>
            ))}
          </Select>
        </div>
      </div>
      {list.error ? (
        <ErrorBanner error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <LoadingRows label="Loading knowledge…" />
      ) : rows.length === 0 ? (
        <EmptyState compact icon={<IconMemory />} title={dq || kind !== 'all' || project ? 'Nothing matches' : 'No knowledge yet'}>
          Requirements and decisions you add here guide every employee. Run reports are added automatically.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2" aria-label="Knowledge entries">
          {rows.map((k) => (
            <Entry key={k.id} k={k} projectName={pname(k.project_id)} onDelete={() => setDeleting(k)} />
          ))}
        </ul>
      )}
      {adding && (
        <AddKnowledgeDialog
          co={co}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            list.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.title ?? ''}”?`}
        confirmLabel="Delete entry"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const r = await run('del', () => companiesApi.deleteKnowledge(co.id, deleting.id), { success: 'Entry deleted', errorTitle: 'Entry not deleted' });
          if (r) {
            list.setData((xs) => (xs ? xs.filter((x) => x.id !== deleting.id) : xs));
            setDeleting(null);
          }
        }}
      >
        <p>Employees will no longer see this entry. This cannot be undone.</p>
      </ConfirmDialog>
    </Card>
  );
}
