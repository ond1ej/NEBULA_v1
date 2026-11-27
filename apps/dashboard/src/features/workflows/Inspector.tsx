// Side panel that edits the selected block (label, typed params, connections) or connection.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Field, Input, Select, Spinner, Textarea } from '../../components/ui';
import { formatTime } from '../../lib/format';
import { workflowsApi } from './api';
import {
  canConnect,
  edgeKey,
  handleLabel,
  handleOf,
  isTrigger,
  loopBody,
  renameHandle,
  updateNode,
  upstreamOf,
  visibleHandles,
} from './graph';
import { IconCopy, IconTrash } from './icons';
import {
  BLOCK_NOTES,
  checkParams,
  checkSchedule,
  defaultSpec,
  fieldsFor,
  fromLocalInput,
  MISFIRE,
  numberParam,
  SCHEDULE_KINDS,
  TEMPLATE_HINT,
  toLocalInput,
  WEEKDAYS,
  type FieldSpec,
} from './params';
import type { AgentOption, Params, RootOption, TeamOption, WfDefinition, WfNode } from './types';
import type { Selection } from './Canvas';

export interface PickerState<T> {
  data: T[] | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export interface PickerOptions {
  agents: PickerState<AgentOption>;
  teams: PickerState<TeamOption>;
  roots: PickerState<RootOption>;
}

export function Inspector({
  def,
  selection,
  labelOf,
  options,
  onChange,
  onDelete,
  onDuplicate,
  onSelect,
  serverError,
}: {
  def: WfDefinition;
  selection: Selection;
  labelOf: (type: string) => string;
  options: PickerOptions;
  onChange: (def: WfDefinition) => void;
  onDelete: () => void;
  onDuplicate: (id: string) => void;
  onSelect: (s: Selection) => void;
  serverError: string | null;
}) {
  if (!selection) return <NothingSelected def={def} />;
  if (selection.kind === 'edge') {
    const e = def.edges.find((x) => edgeKey(x) === selection.id);
    if (!e) return <NothingSelected def={def} />;
    const src = def.nodes.find((n) => n.id === e.source);
    const dst = def.nodes.find((n) => n.id === e.target);
    return (
      <div className="flex flex-col gap-4 p-4">
        <div>
          <p className="text-[11px] font-semibold tracking-wide text-subtle uppercase">Connection</p>
          <p className="mt-1 text-sm text-text">
            <button type="button" className="font-medium text-accent-soft hover:underline" onClick={() => onSelect({ kind: 'node', id: e.source })}>
              {src?.label || e.source}
            </button>{' '}
            <span className="text-muted">({handleLabel(handleOf(e))})</span> →{' '}
            <button type="button" className="font-medium text-accent-soft hover:underline" onClick={() => onSelect({ kind: 'node', id: e.target })}>
              {dst?.label || e.target}
            </button>
          </p>
        </div>
        <Button variant="danger" onClick={onDelete} className="max-sm:min-h-11">
          <IconTrash /> Delete connection
        </Button>
        <p className="text-xs text-subtle">Tip: select a connection on the canvas and press Delete.</p>
      </div>
    );
  }
  const node = def.nodes.find((n) => n.id === selection.id);
  if (!node) return <NothingSelected def={def} />;
  return (
    <NodeInspector
      key={node.id}
      def={def}
      node={node}
      labelOf={labelOf}
      options={options}
      onChange={onChange}
      onDelete={onDelete}
      onDuplicate={() => onDuplicate(node.id)}
      onSelect={onSelect}
      serverError={serverError}
    />
  );
}

function NothingSelected({ def }: { def: WfDefinition }) {
  return (
    <div className="flex flex-col gap-3 p-4 text-sm text-muted">
      <p className="text-text">Select a block or connection to edit it.</p>
      <ul className="list-disc space-y-1 pl-5 text-xs">
        <li>Drag a block from the palette onto the canvas (or tap it to add it in the middle).</li>
        <li>Drag from an output port (right side of a block) onto another block to connect them — or tap the port, then tap the target block.</li>
        <li>Drag the empty canvas to pan; pinch, ⌘/Ctrl + scroll or the +/– buttons zoom.</li>
        <li>
          <kbd className="rounded border border-border px-1 font-mono">Delete</kbd> removes the selection,{' '}
          <kbd className="rounded border border-border px-1 font-mono">⌘/Ctrl Z</kbd> undoes,{' '}
          <kbd className="rounded border border-border px-1 font-mono">⌘/Ctrl S</kbd> saves.
        </li>
      </ul>
      <p className="text-xs text-subtle">
        {def.nodes.length} block(s), {def.edges.length} connection(s).
      </p>
    </div>
  );
}

function NodeInspector({
  def,
  node,
  labelOf,
  options,
  onChange,
  onDelete,
  onDuplicate,
  onSelect,
  serverError,
}: {
  def: WfDefinition;
  node: WfNode;
  labelOf: (type: string) => string;
  options: PickerOptions;
  onChange: (def: WfDefinition) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onSelect: (s: Selection) => void;
  serverError: string | null;
}) {
  const uid = useId();
  const errs = useMemo(() => checkParams(node.type, node.params), [node.type, node.params]);
  const inLoop = useMemo(
    () => def.nodes.some((n) => n.type === 'logic.loop' && loopBody(n.id, def.edges).has(node.id)),
    [def, node.id],
  );
  const upstream = useMemo(() => upstreamOf(def, node.id), [def, node.id]);
  const setParams = (params: Params) => onChange(updateNode(def, node.id, { params }));
  const setParam = (key: string, value: unknown) => {
    const next = { ...node.params };
    if (value === undefined) delete next[key];
    else next[key] = value;
    setParams(next);
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <p className="text-[11px] font-semibold tracking-wide text-subtle uppercase">{labelOf(node.type)}</p>
        <p className="mt-0.5 font-mono text-xs break-all text-muted select-all">id: {node.id}</p>
        {BLOCK_NOTES[node.type] && <p className="mt-1.5 text-xs text-muted">{BLOCK_NOTES[node.type]}</p>}
      </div>
      {serverError && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {serverError}
        </p>
      )}
      <Field label="Label" htmlFor={`${uid}-label`} hint="Shown on the canvas.">
        <Input
          id={`${uid}-label`}
          value={node.label ?? ''}
          maxLength={80}
          placeholder={labelOf(node.type)}
          onChange={(e) => onChange(updateNode(def, node.id, { label: e.target.value }))}
        />
      </Field>
      {fieldsFor(node.type)
        .filter((f) => !f.visible || f.visible(node.params))
        .map((f) => (
          <ParamField
            key={f.key}
            id={`${uid}-${f.key}`}
            spec={f}
            node={node}
            error={errs[f.key]}
            options={options}
            chips={templateChips(upstream, inLoop)}
            onParam={setParam}
            onParams={setParams}
            onRenameCase={(from, to, params) => onChange(updateNode(renameHandle(def, node.id, from, to), node.id, { params }))}
          />
        ))}
      <Connections def={def} node={node} onChange={onChange} onSelect={onSelect} />
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button onClick={onDuplicate} className="max-sm:min-h-11">
          <IconCopy /> Duplicate
        </Button>
        <Button variant="danger" onClick={onDelete} className="max-sm:min-h-11">
          <IconTrash /> Delete block
        </Button>
      </div>
    </div>
  );
}

function templateChips(upstream: string[], inLoop: boolean): string[] {
  const chips = ['{{last.summary}}', '{{last.text}}', '{{trigger.text}}'];
  if (inLoop) chips.push('{{loop.item}}', '{{loop.index}}');
  for (const id of upstream.slice(-6)) chips.push(`{{nodes.${id}.summary}}`);
  return chips;
}

function ParamField({
  id,
  spec,
  node,
  error,
  options,
  chips,
  onParam,
  onParams,
  onRenameCase,
}: {
  id: string;
  spec: FieldSpec;
  node: WfNode;
  error?: string;
  options: PickerOptions;
  chips: string[];
  onParam: (key: string, value: unknown) => void;
  onParams: (p: Params) => void;
  onRenameCase: (from: string, to: string, params: Params) => void;
}) {
  const v = node.params[spec.key];
  switch (spec.kind) {
    case 'text':
      return (
        <Field label={spec.label} htmlFor={id} hint={spec.hint} error={error}>
          <Input
            id={id}
            value={v === undefined || v === null ? '' : String(v)}
            placeholder={spec.placeholder}
            aria-invalid={!!error || undefined}
            onChange={(e) => onParam(spec.key, e.target.value)}
          />
        </Field>
      );
    case 'template':
      return <TemplateField id={id} spec={spec} value={v === undefined || v === null ? '' : String(v)} error={error} chips={chips} onChange={(s) => onParam(spec.key, s)} />;
    case 'number':
      return (
        <Field label={spec.label} htmlFor={id} hint={spec.hint} error={error}>
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={spec.min}
            max={spec.max}
            step={spec.step ?? 1}
            placeholder={spec.placeholder}
            value={typeof v === 'number' || typeof v === 'string' ? String(v) : ''}
            aria-invalid={!!error || undefined}
            onChange={(e) => onParam(spec.key, numberParam(e.target.value))}
          />
        </Field>
      );
    case 'select':
      return (
        <Field label={spec.label} htmlFor={id} hint={spec.hint} error={error}>
          <Select id={id} value={v === undefined || v === null ? '' : String(v)} onChange={(e) => onParam(spec.key, e.target.value)}>
            {!spec.options?.some((o) => o.value === v) && <option value="">Choose…</option>}
            {spec.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    case 'bool':
      return <Checkbox label={spec.label} checked={v === true} onChange={(b) => onParam(spec.key, b)} description={spec.hint} />;
    case 'agent':
      return (
        <PickerField
          id={id}
          spec={spec}
          value={typeof v === 'string' ? v : ''}
          error={error}
          state={options.agents}
          noun="agent"
          optionLabel={(a: AgentOption) => (a.state ? `${a.name} (${a.state.toLowerCase()})` : a.name)}
          onChange={(s) => onParam(spec.key, s)}
        />
      );
    case 'team':
      return (
        <PickerField
          id={id}
          spec={spec}
          value={typeof v === 'string' ? v : ''}
          error={error}
          state={options.teams}
          noun="team"
          optionLabel={(t: TeamOption) => t.name}
          onChange={(s) => onParam(spec.key, s)}
        />
      );
    case 'root':
      return (
        <PickerField
          id={id}
          spec={spec}
          value={typeof v === 'string' ? v : ''}
          error={error}
          state={options.roots}
          noun="location"
          optionLabel={(r: RootOption) => r.label}
          onChange={(s) => onParam(spec.key, s)}
        />
      );
    case 'cases':
      return <CasesField id={id} spec={spec} node={node} error={error} onParams={onParams} onRenameCase={onRenameCase} />;
    case 'schedule':
      return <ScheduleField id={id} params={node.params} error={error} onParams={onParams} />;
    default:
      return null;
  }
}

function TemplateField({
  id,
  spec,
  value,
  error,
  chips,
  onChange,
}: {
  id: string;
  spec: FieldSpec;
  value: string;
  error?: string;
  chips: string[];
  onChange: (s: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  useEffect(() => {
    if (caret.current === null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  const insert = (chip: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    caret.current = start + chip.length;
    onChange(value.slice(0, start) + chip + value.slice(end));
  };
  return (
    <Field label={spec.label} htmlFor={id} error={error} hint={spec.hint ?? TEMPLATE_HINT}>
      <Textarea
        ref={ref}
        id={id}
        rows={spec.rows ?? 3}
        value={value}
        placeholder={spec.placeholder}
        aria-invalid={!!error || undefined}
        className="font-mono text-[12.5px]"
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex flex-wrap gap-1" role="group" aria-label={`Insert a template variable into ${spec.label}`}>
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => insert(c)}
            className="min-h-8 rounded border border-border bg-panel-2 px-1.5 font-mono text-[10.5px] text-muted hover:border-accent/60 hover:text-text focus-visible:outline-2 focus-visible:outline-accent max-sm:min-h-11"
          >
            {c}
          </button>
        ))}
      </div>
    </Field>
  );
}

function PickerField<T extends { id: string }>({
  id,
  spec,
  value,
  error,
  state,
  noun,
  optionLabel,
  onChange,
}: {
  id: string;
  spec: FieldSpec;
  value: string;
  error?: string;
  state: PickerState<T>;
  noun: string;
  optionLabel: (t: T) => string;
  onChange: (v: string) => void;
}) {
  if (state.error && !state.data) {
    return (
      <Field
        label={spec.label}
        htmlFor={id}
        error={error}
        hint={
          <span>
            Could not load the {noun} list.{' '}
            <button type="button" className="text-accent-soft underline" onClick={state.reload}>
              Retry
            </button>{' '}
            — or enter the id.
          </span>
        }
      >
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" />
      </Field>
    );
  }
  const items = state.data ?? [];
  const known = items.some((x) => x.id === value);
  return (
    <Field label={spec.label} htmlFor={id} hint={spec.hint} error={error}>
      <Select id={id} value={value} disabled={!state.data && state.loading} aria-invalid={!!error || undefined} onChange={(e) => onChange(e.target.value)}>
        {!state.data && state.loading ? (
          <option value={value}>Loading…</option>
        ) : (
          <>
            <option value="">{spec.emptyLabel ?? `Choose ${noun}…`}</option>
            {value && !known && <option value={value}>Unknown {noun} ({value.slice(0, 12)})</option>}
            {items.map((x) => (
              <option key={x.id} value={x.id}>
                {optionLabel(x)}
              </option>
            ))}
          </>
        )}
      </Select>
      {state.data && items.length === 0 && <p className="text-xs text-warn">No {noun}s exist yet.</p>}
    </Field>
  );
}

function CasesField({
  id,
  spec,
  node,
  error,
  onParams,
  onRenameCase,
}: {
  id: string;
  spec: FieldSpec;
  node: WfNode;
  error?: string;
  onParams: (p: Params) => void;
  onRenameCase: (from: string, to: string, params: Params) => void;
}) {
  const cases = Array.isArray(node.params.cases) ? node.params.cases.map(String) : [];
  const set = (next: string[]) => onParams({ ...node.params, cases: next });
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium text-text">{spec.label}</legend>
      {cases.map((c, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <label htmlFor={`${id}-${i}`} className="sr-only">
            Case {i + 1}
          </label>
          <Input
            id={`${id}-${i}`}
            value={c}
            className="font-mono"
            onChange={(e) => {
              const next = [...cases];
              next[i] = e.target.value;
              onRenameCase(c, e.target.value, { ...node.params, cases: next });
            }}
          />
          <button
            type="button"
            aria-label={`Remove case ${c || i + 1}`}
            disabled={cases.length <= 1}
            onClick={() => set(cases.filter((_, j) => j !== i))}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-danger focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 max-sm:size-11"
          >
            <IconTrash />
          </button>
        </div>
      ))}
      <div>
        <Button size="sm" disabled={cases.length >= 10} onClick={() => set([...cases, `case_${cases.length + 1}`])} className="max-sm:min-h-11">
          Add case
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : (
        spec.hint && <p className="text-xs text-muted">{spec.hint}</p>
      )}
    </fieldset>
  );
}

function timeZones(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  try {
    return f ? f('timeZone') : [];
  } catch {
    return [];
  }
}

function ScheduleField({ id, params, error, onParams }: { id: string; params: Params; error?: string; onParams: (p: Params) => void }) {
  const kind = String(params.kind ?? 'daily');
  const spec = (params.spec && typeof params.spec === 'object' ? params.spec : {}) as Record<string, unknown>;
  const tz = String(params.timezone ?? '');
  const setSpec = (patch: Record<string, unknown>) => onParams({ ...params, spec: { ...spec, ...patch } });
  const zones = useMemo(timeZones, []);
  const [preview, setPreview] = useState<{ next?: number[]; error?: string; loading?: boolean }>({});
  const localErr = checkSchedule(params);

  useEffect(() => {
    if (localErr) {
      setPreview({});
      return;
    }
    const ctl = new AbortController();
    setPreview((p) => ({ ...p, loading: true }));
    const t = setTimeout(() => {
      workflowsApi
        .schedulePreview(kind, spec, tz, ctl.signal)
        .then((r) => setPreview({ next: r.next }))
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return;
          setPreview({ error: e instanceof Error ? e.message : String(e) });
        });
    }, 500);
    return () => {
      ctl.abort();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, JSON.stringify(spec), tz, localErr]);

  const weekdays = Array.isArray(spec.weekdays) ? (spec.weekdays as number[]) : [];
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium text-text">Schedule</legend>
      <Field label="Repeats" htmlFor={`${id}-kind`}>
        <Select id={`${id}-kind`} value={kind} onChange={(e) => onParams({ ...params, kind: e.target.value, spec: defaultSpec(e.target.value) })}>
          {SCHEDULE_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>
      {(kind === 'daily' || kind === 'weekly' || kind === 'monthly') && (
        <Field label="Time" htmlFor={`${id}-time`}>
          <Input id={`${id}-time`} type="time" value={String(spec.time ?? '')} onChange={(e) => setSpec({ time: e.target.value })} />
        </Field>
      )}
      {kind === 'weekly' && (
        <div role="group" aria-label="Weekdays" className="flex flex-wrap gap-1">
          {WEEKDAYS.map((d, i) => {
            const on = weekdays.includes(i);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => setSpec({ weekdays: on ? weekdays.filter((x) => x !== i) : [...weekdays, i].sort() })}
                className={`h-9 min-w-11 rounded-md border px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-accent max-sm:h-11 ${
                  on ? 'border-accent bg-accent/20 text-text' : 'border-border text-muted hover:text-text'
                }`}
              >
                {d}
              </button>
            );
          })}
        </div>
      )}
      {kind === 'monthly' && (
        <Field label="Day of month" htmlFor={`${id}-day`}>
          <Input id={`${id}-day`} type="number" min={1} max={31} value={String(spec.day ?? '')} onChange={(e) => setSpec({ day: numberParam(e.target.value) })} />
        </Field>
      )}
      {kind === 'interval' && (
        <Field label="Every (minutes)" htmlFor={`${id}-every`} hint="Minimum 1 minute.">
          <Input
            id={`${id}-every`}
            type="number"
            min={1}
            value={Number.isFinite(Number(spec.every_s)) ? String(Math.round(Number(spec.every_s) / 60)) : ''}
            onChange={(e) => {
              const m = numberParam(e.target.value);
              setSpec({ every_s: m === undefined ? undefined : Math.round(m * 60) });
            }}
          />
        </Field>
      )}
      {kind === 'once' && (
        <Field label="Date and time" htmlFor={`${id}-at`} hint="In this browser’s time zone.">
          <Input
            id={`${id}-at`}
            type="datetime-local"
            value={toLocalInput(Number(spec.at))}
            onChange={(e) => setSpec({ at: fromLocalInput(e.target.value) })}
          />
        </Field>
      )}
      {kind === 'cron' && (
        <Field label="Cron expression" htmlFor={`${id}-cron`} hint="minute hour day month weekday, e.g. 0 8 * * 1-5 (weekdays at 08:00).">
          <Input id={`${id}-cron`} className="font-mono" value={String(spec.cron ?? '')} onChange={(e) => setSpec({ cron: e.target.value })} />
        </Field>
      )}
      <Field label="Time zone" htmlFor={`${id}-tz`}>
        <Input
          id={`${id}-tz`}
          list={zones.length ? `${id}-tzlist` : undefined}
          value={tz}
          placeholder="Europe/Prague"
          onChange={(e) => onParams({ ...params, timezone: e.target.value })}
        />
      </Field>
      {zones.length > 0 && (
        <datalist id={`${id}-tzlist`}>
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      )}
      <Field label="Missed runs (NEBULA offline)" htmlFor={`${id}-misfire`}>
        <Select
          id={`${id}-misfire`}
          value={String(params.misfire_policy ?? 'run_once')}
          onChange={(e) => onParams({ ...params, misfire_policy: e.target.value })}
        >
          {MISFIRE.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <div aria-live="polite" className="text-xs">
        {error ? (
          <p className="text-danger" role="alert">
            {error}
          </p>
        ) : preview.error ? (
          <p className="text-danger">{preview.error}</p>
        ) : preview.next ? (
          preview.next.length ? (
            <div className="text-muted">
              <p className="font-medium text-text">Next runs</p>
              <ul className="mt-0.5 space-y-0.5 font-mono text-[11px]">
                {preview.next.map((t) => (
                  <li key={t}>{formatTime(t)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-warn">This schedule never fires again.</p>
          )
        ) : preview.loading ? (
          <Spinner className="size-3" label="Calculating next runs…" />
        ) : null}
      </div>
      <p className="text-xs text-subtle">Schedules run only while the workflow is enabled.</p>
    </fieldset>
  );
}

function Connections({
  def,
  node,
  onChange,
  onSelect,
}: {
  def: WfDefinition;
  node: WfNode;
  onChange: (def: WfDefinition) => void;
  onSelect: (s: Selection) => void;
}) {
  const uid = useId();
  const handles = visibleHandles(node, def.edges);
  const [handle, setHandle] = useState(handles[0] ?? 'out');
  const [target, setTarget] = useState('');
  const out = def.edges.filter((e) => e.source === node.id);
  const inc = def.edges.filter((e) => e.target === node.id);
  const nameOf = (id: string) => def.nodes.find((n) => n.id === id)?.label || id;
  const h = handles.includes(handle) ? handle : (handles[0] ?? 'out');
  const candidates = def.nodes.filter((n) => n.id !== node.id && !isTrigger(n.type));
  const check = target ? canConnect(def, node.id, h, target) : null;

  return (
    <section aria-labelledby={`${uid}-h`} className="flex flex-col gap-2 border-t border-border pt-4">
      <h3 id={`${uid}-h`} className="text-sm font-medium text-text">
        Connections
      </h3>
      {out.length === 0 && inc.length === 0 && <p className="text-xs text-muted">Not connected yet.</p>}
      {inc.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Incoming connections">
          {inc.map((e) => (
            <li key={edgeKey(e)} className="flex items-center gap-1.5 text-muted">
              <span aria-hidden>←</span>
              <button type="button" className="truncate text-text hover:underline" onClick={() => onSelect({ kind: 'node', id: e.source })}>
                {nameOf(e.source)}
              </button>
              <span>({handleLabel(handleOf(e))})</span>
            </li>
          ))}
        </ul>
      )}
      {out.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Outgoing connections">
          {out.map((e) => (
            <li key={edgeKey(e)} className="flex items-center gap-1.5 text-muted">
              <span className="shrink-0 rounded bg-panel-3 px-1.5 py-0.5 font-mono text-[10.5px]">{handleLabel(handleOf(e))}</span>
              <span aria-hidden>→</span>
              <button type="button" className="min-w-0 flex-1 truncate text-left text-text hover:underline" onClick={() => onSelect({ kind: 'node', id: e.target })}>
                {nameOf(e.target)}
              </button>
              <button
                type="button"
                aria-label={`Remove connection ${handleLabel(handleOf(e))} to ${nameOf(e.target)}`}
                onClick={() => onChange({ ...def, edges: def.edges.filter((x) => edgeKey(x) !== edgeKey(e)) })}
                className="flex size-8 shrink-0 items-center justify-center rounded text-subtle hover:bg-panel-2 hover:text-danger focus-visible:outline-2 focus-visible:outline-accent max-sm:size-11"
              >
                <IconTrash className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && handles.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-panel-2/50 p-2">
          <p className="text-xs font-medium text-muted">Add a connection</p>
          <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-1.5">
            <label htmlFor={`${uid}-hd`} className="sr-only">
              Output
            </label>
            <Select id={`${uid}-hd`} value={h} onChange={(e) => setHandle(e.target.value)}>
              {handles.map((x) => (
                <option key={x} value={x}>
                  {handleLabel(x)}
                </option>
              ))}
            </Select>
            <label htmlFor={`${uid}-tg`} className="sr-only">
              Target block
            </label>
            <Select id={`${uid}-tg`} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Target block…</option>
              {candidates.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label || n.id}
                </option>
              ))}
            </Select>
          </div>
          {check && !check.ok && <p className="text-xs text-danger">{check.reason}</p>}
          <div>
            <Button
              size="sm"
              disabled={!target || !check?.ok}
              onClick={() => {
                const c = canConnect(def, node.id, h, target);
                if (!c.ok) return;
                onChange({ ...def, edges: [...def.edges, { id: `${node.id}-${h}-${target}`, source: node.id, target, handle: h }] });
                setTarget('');
              }}
              className="max-sm:min-h-11"
            >
              Connect
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
