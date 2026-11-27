// Visual workflow editor: palette + canvas + inspector, live validation, save, run and run view.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import { Button, ErrorBanner, Field, Notice, Spinner, Textarea } from '../../components/ui';
import { errorMessage } from '../../api';
import { useApi } from '../../hooks/useApi';
import { href, navigate } from '../../hooks/useHashRoute';
import { shortId } from '../../lib/format';
import { pickerApi, workflowsApi } from './api';
import { WorkflowCanvas, type CanvasHandle, type Selection } from './Canvas';
import {
  ACTIVE_RUN_STATES,
  addEdge,
  createNode,
  emptyDefinition,
  MAX_NODES,
  moveNode,
  newNodeId,
  nodeIdsInError,
  NODE_W,
  normalizeDefinition,
  parsePayload,
  removeEdge,
  removeNode,
  stepStates,
  takenEdges,
  toApiDefinition,
} from './graph';
import { initHistory, pushHistory, redo, undo, type History } from './history';
import { IconAlert, IconBack, IconBlocks, IconCheck, IconEdit, IconHistory, IconPlay, IconRedo, IconSave, IconUndo } from './icons';
import { Inspector } from './Inspector';
import { Palette } from './Palette';
import { checkParams } from './params';
import { RunDetail, RunsList } from './RunPanel';
import { Sheet, useWideLayout } from './Sheet';
import { Switch } from './Switch';
import type { CatalogBlock, RunSummary, WfDefinition, Workflow } from './types';
import { useWorkflowRun } from './useRun';

interface Saved {
  def: WfDefinition;
  name: string;
  description: string;
  version: number;
}

type Validation = { status: 'idle' | 'checking' | 'valid' | 'invalid' | 'error'; message: string | null };

const prettyType = (t: string) => {
  const s = (t.split('.').pop() ?? t).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable="true"]');

export function WorkflowEditor({ workflowId, runId }: { workflowId: string; runId: string | null }) {
  const toast = useToast();
  const isNew = workflowId === 'new';
  const wide = useWideLayout();
  const canvasRef = useRef<CanvasHandle>(null);
  const nameId = useId();
  const descId = useId();

  const catalog = useApi((s) => workflowsApi.catalog(s), []);
  const wf = useApi<Workflow | null>((s) => (isNew ? Promise.resolve(null) : workflowsApi.get(workflowId, s)), [workflowId]);
  const agents = useApi((s) => pickerApi.agents(s), []);
  const teams = useApi((s) => pickerApi.teams(s), []);
  const roots = useApi((s) => pickerApi.roots(s), []);
  const runs = useApi<RunSummary[]>((s) => (isNew ? Promise.resolve([]) : workflowsApi.runs(workflowId, 30, s)), [workflowId]);
  const inRun = !!runId && !isNew;
  const live = useWorkflowRun(inRun ? runId : null);

  const [hist, setHist] = useState<History<WfDefinition> | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [selection, setSelection] = useState<Selection>(null);
  const [runNode, setRunNode] = useState<string | null>(null);
  const [validation, setValidation] = useState<Validation>({ status: 'idle', message: null });
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [panel, setPanel] = useState<'palette' | 'side' | null>(null);
  const [tab, setTab] = useState<'block' | 'runs'>(runId ? 'runs' : 'block');
  const [runDialog, setRunDialog] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // ------------------------------------------------------------ load
  useEffect(() => {
    if (hist) return;
    if (isNew) {
      const d = emptyDefinition();
      setHist(initHistory(d));
      setSaved({ def: d, name: '', description: '', version: 0 });
      setName('Untitled workflow');
    } else if (wf.data) {
      const d = normalizeDefinition(wf.data.definition);
      setHist(initHistory(d));
      setSaved({ def: d, name: wf.data.name, description: wf.data.description, version: wf.data.version });
      setName(wf.data.name);
      setDescription(wf.data.description);
      setEnabled(wf.data.enabled);
    }
  }, [isNew, wf.data, hist]);

  useEffect(() => {
    if (runId) setTab('runs');
    setRunNode(null);
  }, [runId]);

  const def = hist?.present ?? null;
  const defJson = useMemo(() => (def ? JSON.stringify(toApiDefinition(def)) : ''), [def]);
  const savedJson = useMemo(() => (saved ? JSON.stringify(toApiDefinition(saved.def)) : ''), [saved]);
  const dirty = !!saved && (isNew || defJson !== savedJson || name !== saved.name || description !== saved.description);

  const blockByType = useMemo(() => new Map((catalog.data?.blocks ?? []).map((b) => [b.type, b])), [catalog.data]);
  const labelOf = useCallback((t: string) => blockByType.get(t)?.label ?? prettyType(t), [blockByType]);
  const maxNodes = catalog.data?.limits.max_nodes ?? MAX_NODES;

  // ------------------------------------------------------------ live validation (debounced)
  useEffect(() => {
    if (!defJson || inRun) return;
    setValidation((v) => ({ status: 'checking', message: v.message }));
    const ctl = new AbortController();
    const t = setTimeout(() => {
      workflowsApi
        .validate(JSON.parse(defJson) as WfDefinition, ctl.signal)
        .then((r) => {
          if (!ctl.signal.aborted) setValidation(r.valid ? { status: 'valid', message: null } : { status: 'invalid', message: r.error ?? 'Invalid workflow' });
        })
        .catch((e: unknown) => {
          if (!ctl.signal.aborted) setValidation({ status: 'error', message: errorMessage(e) });
        });
    }, 600);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [defJson, inRun]);

  const errorNodes = useMemo(
    () => new Set(validation.status === 'invalid' && def ? nodeIdsInError(validation.message, def.nodes.map((n) => n.id)) : []),
    [validation, def],
  );
  const warnNodes = useMemo(
    () => new Set((def?.nodes ?? []).filter((n) => Object.keys(checkParams(n.type, n.params)).length > 0).map((n) => n.id)),
    [def],
  );

  // ------------------------------------------------------------ edits
  const apply = useCallback((fn: (d: WfDefinition) => WfDefinition) => setHist((h) => (h ? pushHistory(h, fn(h.present)) : h)), []);

  const addBlock = (block: CatalogBlock, at?: { x: number; y: number }) => {
    if (!def) return;
    if (def.nodes.length >= maxNodes) {
      toast.error(new Error(`A workflow can have at most ${maxNodes} blocks.`), 'Block not added');
      return;
    }
    let p = at ?? canvasRef.current?.centerWorld() ?? { x: 80, y: 80 };
    // A tapped block (no drop point) must not land on top of another one: move it down until it is free.
    const overlaps = (q: { x: number; y: number }) =>
      def.nodes.some((n) => n.position && Math.abs(n.position.x - q.x) < NODE_W + 16 && Math.abs(n.position.y - q.y) < 110);
    for (let i = 0; !at && i < 30 && overlaps(p); i += 1) p = { x: p.x, y: p.y + 120 };
    for (let i = 0; at && i < 20 && def.nodes.some((n) => n.position && Math.abs(n.position.x - p.x) < 24 && Math.abs(n.position.y - p.y) < 24); i += 1)
      p = { x: p.x + 30, y: p.y + 30 };
    const node = createNode(block, { x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 }, def.nodes.map((n) => n.id));
    apply((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelection({ kind: 'node', id: node.id });
    setTab('block');
    setPanel(null);
  };

  const deleteSelection = () => {
    if (!selection) return;
    if (selection.kind === 'node') apply((d) => removeNode(d, selection.id));
    else apply((d) => removeEdge(d, selection.id));
    setSelection(null);
  };

  const duplicate = (id: string) => {
    if (!def) return;
    const n = def.nodes.find((x) => x.id === id);
    if (!n) return;
    if (def.nodes.length >= maxNodes) {
      toast.error(new Error(`A workflow can have at most ${maxNodes} blocks.`), 'Block not duplicated');
      return;
    }
    const copy = {
      ...(JSON.parse(JSON.stringify(n)) as typeof n),
      id: newNodeId(n.type, def.nodes.map((x) => x.id)),
      label: n.label ? `${n.label} (copy)`.slice(0, 80) : n.label,
      position: { x: (n.position?.x ?? 0) + 40, y: (n.position?.y ?? 0) + 40 },
    };
    apply((d) => ({ ...d, nodes: [...d.nodes, copy] }));
    setSelection({ kind: 'node', id: copy.id });
  };

  const connect = (source: string, handle: string, target: string): string | null => {
    if (!def) return 'Not loaded yet.';
    const r = addEdge(def, source, handle, target);
    if (r.error) return r.error;
    apply(() => r.def);
    return null;
  };

  // ------------------------------------------------------------ save / run / enable
  const save = async (): Promise<Workflow | null> => {
    if (!def || saving) return null;
    const n = name.trim();
    if (!n) {
      toast.error(new Error('Give the workflow a name first.'), 'Cannot save');
      return null;
    }
    setSaving(true);
    try {
      const defChanged = defJson !== savedJson;
      const w = isNew
        ? await workflowsApi.create({ name: n, description, definition: toApiDefinition(def), enabled })
        : await workflowsApi.update(workflowId, { name: n, description, ...(defChanged ? { definition: toApiDefinition(def) } : {}) });
      setSaved({ def, name: w.name, description: w.description, version: w.version });
      setName(w.name);
      setDescription(w.description);
      setEnabled(w.enabled);
      toast.success(`Saved · version ${w.version}`);
      if (isNew) navigate(`/workflows/${encodeURIComponent(w.id)}`, { replace: true });
      return w;
    } catch (e) {
      toast.error(e, 'Could not save the workflow');
      return null;
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const startRun = async (payload: Record<string, unknown>): Promise<boolean> => {
    let id = workflowId;
    if (isNew || dirty) {
      const w = await save();
      if (!w) return false;
      id = w.id;
    }
    try {
      const r = await workflowsApi.run(id, payload);
      toast.success('Run started');
      navigate(`/workflows/${encodeURIComponent(id)}?run=${encodeURIComponent(r.id)}`);
      runs.reload();
      return true;
    } catch (e) {
      toast.error(e, 'Could not start the run');
      return false;
    }
  };

  const toggleEnabled = async (v: boolean) => {
    if (isNew) {
      setEnabled(v);
      return;
    }
    setToggling(true);
    try {
      const w = await workflowsApi.setEnabled(workflowId, v);
      setEnabled(w.enabled);
      toast.success(w.enabled ? 'Workflow enabled' : 'Workflow disabled', w.enabled ? 'Its triggers are active.' : 'Triggers no longer start it; manual runs still work.');
    } catch (e) {
      toast.error(e, 'Could not change the workflow state');
    } finally {
      setToggling(false);
    }
  };

  // ------------------------------------------------------------ keyboard shortcuts / unload guard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || inRun) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        void saveRef.current();
      } else if ((k === 'z' || k === 'y') && !isEditable(e.target)) {
        e.preventDefault();
        setHist((h) => (h ? (k === 'y' || e.shiftKey ? redo(h) : undo(h)) : h));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inRun]);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  // keep the run history fresh while something is running
  const runsActive = !!runs.data?.some((r) => ACTIVE_RUN_STATES.has(r.state));
  const reloadRuns = runs.reload;
  useEffect(() => {
    if (!runsActive && !live.active) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') reloadRuns();
    }, 5000);
    return () => clearInterval(t);
  }, [runsActive, live.active, reloadRuns]);
  const liveState = live.run?.state;
  useEffect(() => {
    if (liveState) reloadRuns();
  }, [liveState, reloadRuns]);

  // ------------------------------------------------------------ run view data
  const runDef = useMemo(() => (live.run ? normalizeDefinition(live.run.definition) : null), [live.run]);
  const runStates = useMemo(() => (live.run ? stepStates(live.run.steps) : undefined), [live.run]);
  const taken = useMemo(() => (runDef && runStates ? takenEdges(runDef, runStates) : undefined), [runDef, runStates]);

  // ------------------------------------------------------------ render
  if (!isNew && wf.error && !wf.data) {
    return (
      <div className="flex flex-col gap-4">
        <a href={href('/workflows')} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-text">
          <IconBack /> Workflows
        </a>
        <ErrorBanner error={wf.error} onRetry={wf.reload} title="Could not load the workflow" />
      </div>
    );
  }
  if (!def || !saved) return <Spinner label="Loading workflow…" />;

  const viewDef = inRun ? runDef : def;
  const canvasSelection: Selection = inRun ? (runNode ? { kind: 'node', id: runNode } : null) : selection;
  const fitKey = inRun ? (runDef ? `run:${runId}` : 'run-loading') : `edit:${workflowId}`;
  const selectedNodeError =
    selection?.kind === 'node' && errorNodes.has(selection.id) ? validation.message : null;
  const hasSelection = !!selection;
  const catalogBlocks = catalog.data?.blocks ?? [];
  const hasManual = def.nodes.some((n) => n.type === 'trigger.manual');

  const sideContent = inRun ? (
    <RunDetail
      run={live.run}
      loading={live.loading}
      error={live.error}
      onReload={live.reload}
      def={runDef}
      currentVersion={isNew ? null : saved.version}
      selectedNode={runNode}
      onSelectNode={setRunNode}
      onBack={() => navigate(`/workflows/${encodeURIComponent(workflowId)}`)}
    />
  ) : (
    <>
      <div role="tablist" aria-label="Side panel" className="flex gap-1 border-b border-border px-3 pt-2">
        {(['block', 'runs'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px min-h-10 border-b-2 px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent max-sm:min-h-11 ${
              tab === t ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'
            }`}
          >
            {t === 'block' ? 'Block' : 'Runs'}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'block' ? (
          <Inspector
            def={def}
            selection={selection}
            labelOf={labelOf}
            options={{ agents, teams, roots }}
            onChange={(next) => apply(() => next)}
            onDelete={deleteSelection}
            onDuplicate={duplicate}
            onSelect={setSelection}
            serverError={selectedNodeError}
          />
        ) : isNew ? (
          <p className="p-4 text-sm text-muted">Save the workflow to run it and see its runs here.</p>
        ) : (
          <RunsList
            runs={runs.data}
            loading={runs.loading}
            error={runs.error}
            onReload={runs.reload}
            activeRunId={runId}
            onOpen={(id) => navigate(`/workflows/${encodeURIComponent(workflowId)}?run=${encodeURIComponent(id)}`)}
          />
        )}
      </div>
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* ---------------------------------------------------------- header */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <a
            href={href('/workflows')}
            onClick={(e) => {
              if (dirty) {
                e.preventDefault();
                setLeaving(true);
              }
            }}
            className="inline-flex min-h-9 items-center gap-1 rounded-md pr-2 text-sm text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent max-sm:min-h-11"
          >
            <IconBack /> Workflows
          </a>
          <div className="min-w-0 flex-1 basis-56">
            <label htmlFor={nameId} className="sr-only">
              Workflow name
            </label>
            <input
              id={nameId}
              value={name}
              maxLength={128}
              disabled={inRun}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-lg font-semibold text-text hover:border-border focus:border-accent focus:outline-none disabled:opacity-80"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-panel-3 px-1.5 py-0.5 font-mono text-muted">{isNew ? 'not saved' : `v${saved.version}`}</span>
            {dirty && !isNew && <span className="font-medium text-warn">Unsaved changes</span>}
            {!inRun && <ValidationChip v={validation} />}
          </div>
        </div>
        {!inRun && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-64">
              <label htmlFor={descId} className="sr-only">
                Description
              </label>
              <input
                id={descId}
                value={description}
                maxLength={2000}
                placeholder="Description (optional)"
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text placeholder:text-subtle focus:border-accent focus:outline-none max-sm:min-h-11"
              />
            </div>
            <Switch checked={enabled} onChange={toggleEnabled} busy={toggling} label="Enabled" showLabel />
            <div className="flex items-center gap-1">
              <IconButton label="Undo (⌘/Ctrl Z)" disabled={!hist?.past.length} onClick={() => setHist((h) => (h ? undo(h) : h))}>
                <IconUndo />
              </IconButton>
              <IconButton label="Redo (⇧⌘Z / Ctrl Y)" disabled={!hist?.future.length} onClick={() => setHist((h) => (h ? redo(h) : h))}>
                <IconRedo />
              </IconButton>
            </div>
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty} className="max-sm:min-h-11">
              <IconSave /> Save
            </Button>
            <Button onClick={() => setRunDialog(true)} className="max-sm:min-h-11">
              <IconPlay /> Run
            </Button>
          </div>
        )}
        {!inRun && validation.status === 'invalid' && validation.message && (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-text">
            <IconAlert className="mt-0.5 size-4 shrink-0 text-danger" />
            <span className="min-w-0 break-words">{validation.message}</span>
          </p>
        )}
        {!inRun && validation.status === 'error' && validation.message && (
          <p role="alert" className="text-xs text-warn">
            Live validation is unavailable: {validation.message}
          </p>
        )}
        {inRun && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-sm">
            <IconHistory className="size-4 shrink-0 text-info" />
            <span className="text-text">
              Run <span className="font-mono">{shortId(runId)}</span>
            </span>
            {live.run && <StatusPill state={live.run.state} pulse={live.active} />}
            <span className="text-xs text-muted">
              {live.run ? `Snapshot of version ${live.run.workflow_version} — read-only` : 'Loading…'}
              {live.active ? ' · updating live' : ''}
            </span>
            <span className="flex-1" />
            <Button size="sm" onClick={() => navigate(`/workflows/${encodeURIComponent(workflowId)}`)} className="max-sm:min-h-11">
              <IconEdit /> Back to editor
            </Button>
          </div>
        )}
      </div>

      {catalog.error && !catalog.data ? <ErrorBanner error={catalog.error} onRetry={catalog.reload} title="Could not load the block catalog" /> : null}

      {/* ---------------------------------------------------------- mobile toolbar */}
      <div className="flex flex-wrap gap-2 lg:hidden">
        {!inRun && (
          <Button onClick={() => setPanel('palette')} className="min-h-11">
            <IconBlocks /> Add block
          </Button>
        )}
        {!inRun && (
          <Button
            onClick={() => {
              setTab('block');
              setPanel('side');
            }}
            disabledReason={hasSelection ? null : 'Select a block or connection first'}
            className="min-h-11"
          >
            <IconEdit /> Edit
          </Button>
        )}
        {!inRun && hasSelection && (
          <Button variant="danger" onClick={deleteSelection} className="min-h-11">
            Delete
          </Button>
        )}
        <Button
          onClick={() => {
            setTab('runs');
            setPanel('side');
          }}
          className="min-h-11"
        >
          <IconHistory /> {inRun ? 'Run details' : 'Runs'}
        </Button>
      </div>

      {/* ---------------------------------------------------------- body */}
      <div
        className={`lg:grid lg:h-[calc(100dvh-15rem)] lg:min-h-[520px] lg:gap-3 ${
          inRun ? 'lg:grid-cols-[minmax(0,1fr)_360px]' : 'lg:grid-cols-[232px_minmax(0,1fr)_340px]'
        }`}
      >
        {!inRun && (
          <Sheet open={panel === 'palette'} onClose={() => setPanel(null)} title="Blocks">
            {catalog.data ? (
              <Palette
                blocks={catalogBlocks}
                onAdd={(b) => addBlock(b)}
                onDrop={(b, x, y) => {
                  const w = canvasRef.current?.clientToWorld(x, y);
                  if (!w) return false;
                  addBlock(b, { x: w.x - NODE_W / 2, y: w.y - 24 });
                  return true;
                }}
                disabledReason={def.nodes.length >= maxNodes ? `Limit of ${maxNodes} blocks reached.` : null}
              />
            ) : catalog.loading ? (
              <div className="p-3">
                <Spinner label="Loading blocks…" />
              </div>
            ) : (
              <p className="p-3 text-sm text-muted">The block catalog is unavailable.</p>
            )}
          </Sheet>
        )}

        <div className="relative h-[62dvh] min-h-[340px] overflow-hidden rounded-xl border border-border lg:h-full lg:min-h-0">
          {viewDef ? (
            <WorkflowCanvas
              ref={canvasRef}
              def={viewDef}
              labelOf={labelOf}
              selection={canvasSelection}
              onSelect={(s) => {
                if (inRun) setRunNode(s?.kind === 'node' ? s.id : null);
                else setSelection(s);
              }}
              readOnly={inRun}
              onMoveNode={(id, pos) => apply((d) => moveNode(d, id, pos))}
              onConnect={connect}
              onDelete={deleteSelection}
              onOpen={() => {
                setTab(inRun ? 'runs' : 'block');
                if (!wide) setPanel('side');
              }}
              runStates={inRun ? runStates : undefined}
              taken={inRun ? taken : undefined}
              errorNodes={inRun ? undefined : errorNodes}
              warnNodes={inRun ? undefined : warnNodes}
              fitKey={fitKey}
              label={inRun ? 'Workflow run (read-only)' : 'Workflow canvas'}
            />
          ) : live.error ? (
            <div className="p-4">
              <ErrorBanner error={live.error} onRetry={live.reload} title="Could not load the run" />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Loading run…" />
            </div>
          )}
        </div>

        <Sheet
          open={panel === 'side'}
          onClose={() => setPanel(null)}
          title={inRun ? 'Run details' : 'Inspector'}
        >
          {sideContent}
        </Sheet>
      </div>

      <RunDialog
        open={runDialog}
        onClose={() => setRunDialog(false)}
        onRun={startRun}
        dirty={dirty}
        isNew={isNew}
        enabled={enabled}
        hasManual={hasManual}
      />
      <ConfirmDialog
        open={leaving}
        title="Discard unsaved changes?"
        confirmLabel="Discard and leave"
        onCancel={() => setLeaving(false)}
        onConfirm={() => {
          setLeaving(false);
          navigate('/workflows');
        }}
      >
        <p>Your changes to “{name || 'this workflow'}” have not been saved.</p>
      </ConfirmDialog>
    </div>
  );
}

function ValidationChip({ v }: { v: Validation }) {
  if (v.status === 'checking' || v.status === 'idle')
    return (
      <span className="inline-flex items-center gap-1 text-muted" role="status">
        <Spinner className="size-3" /> Checking…
      </span>
    );
  if (v.status === 'valid')
    return (
      <span className="inline-flex items-center gap-1 text-success" role="status">
        <IconCheck className="size-3.5" /> Valid
      </span>
    );
  if (v.status === 'invalid')
    return (
      <span className="inline-flex items-center gap-1 text-danger" role="status">
        <IconAlert className="size-3.5" /> Invalid
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-warn" role="status">
      <IconAlert className="size-3.5" /> Not checked
    </span>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-md border border-border text-muted hover:bg-panel-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 max-sm:size-11"
    >
      {children}
    </button>
  );
}

function RunDialog({
  open,
  onClose,
  onRun,
  dirty,
  isNew,
  enabled,
  hasManual,
}: {
  open: boolean;
  onClose: () => void;
  onRun: (payload: Record<string, unknown>) => Promise<boolean>;
  dirty: boolean;
  isNew: boolean;
  enabled: boolean;
  hasManual: boolean;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = parsePayload(text);
  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);
  const go = async () => {
    if (!parsed.ok) return;
    setBusy(true);
    const ok = await onRun(parsed.value);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      title="Run workflow"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void go()} loading={busy} disabledReason={parsed.ok ? null : 'Fix the payload JSON first'}>
            <IconPlay /> {isNew || dirty ? 'Save and run' : 'Run now'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {(isNew || dirty) && (
          <Notice tone="warn" title="Unsaved changes">
            The workflow is saved first; the run uses the new version.
          </Notice>
        )}
        {!hasManual && <Notice>This workflow has no Manual trigger: the first trigger block starts the run.</Notice>}
        {!enabled && <Notice>The workflow is disabled — manual runs still work.</Notice>}
        <Field
          label="Payload (optional JSON object)"
          htmlFor={id}
          hint="Each key is available in templates as {{trigger.<key>}}, e.g. {{trigger.text}}."
          error={parsed.ok ? undefined : parsed.error}
        >
          <Textarea
            id={id}
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'{\n  "text": "hello"\n}'}
            className="font-mono text-[12.5px]"
            spellCheck={false}
          />
        </Field>
      </div>
    </Modal>
  );
}
