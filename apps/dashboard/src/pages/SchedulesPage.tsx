// Schedules: list + month/week calendar of upcoming fires, editor with friendly timing inputs, detail with run history.
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, errorMessage } from '../api';
import { IconCalendar, IconChevronLeft, IconChevronRight, IconClock, IconEdit, IconList, IconPlay, IconPlus, IconRepeat, IconSchedules, IconTrash } from '../components/icons';
import { DropdownMenu } from '../components/Menu';
import { ConfirmDialog, Drawer } from '../components/Modal';
import { StatusPill } from '../components/StatusPill';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  KeyValue,
  LoadingRows,
  Mono,
  PageHeader,
  SegmentedControl,
  Select,
  Spinner,
  Switch,
  Textarea,
  type Column,
} from '../components/ui';
import { useAction, useApi, useNow } from '../hooks/useApi';
import { useDebounced } from '../hooks/useDebounced';
import { useLiveRefresh } from '../hooks/useEvents';
import { href, navigate } from '../hooks/useHashRoute';
import { formatDuration, formatTime, relativeTime, shortId } from '../lib/format';
import { CRON_PRESETS, describeSchedule, intervalToSeconds, secondsToInterval, WEEKDAYS, type IntervalUnit } from '../lib/schedule';
import { DEFAULT_TZ, epochToZoned, formatInZone, localDayKey, timeZones, zonedToEpoch } from '../lib/tz';
import type { Schedule, ScheduleBody, ScheduleKind, ScheduleRun, ScheduleSpec, ScheduleTarget } from '../types';

// ---------------------------------------------------------------- form model
export interface ScheduleForm {
  name: string;
  target_type: ScheduleTarget;
  target_id: string;
  prompt: string;
  kind: ScheduleKind;
  timezone: string;
  onceDate: string;
  onceTime: string;
  everyN: string;
  everyUnit: IntervalUnit;
  time: string;
  weekdays: number[];
  day: string;
  cron: string;
  misfire_policy: 'skip' | 'run_once' | 'ask';
  overlap_policy: 'skip' | 'queue';
  retry_max: string;
  retry_delay_min: string;
  max_runtime_min: string;
  max_model_calls: string;
  telegram: boolean;
  enabled: boolean;
}

export function defaultForm(now = Date.now() / 1000): ScheduleForm {
  const z = epochToZoned(now + 3600, DEFAULT_TZ);
  return {
    name: '',
    target_type: 'agent',
    target_id: '',
    prompt: '',
    kind: 'daily',
    timezone: DEFAULT_TZ,
    onceDate: z.date,
    onceTime: z.time,
    everyN: '1',
    everyUnit: 'hours',
    time: '09:00',
    weekdays: [1, 2, 3, 4, 5],
    day: '1',
    cron: '0 9 * * 1-5',
    misfire_policy: 'run_once',
    overlap_policy: 'skip',
    retry_max: '0',
    retry_delay_min: '5',
    max_runtime_min: '30',
    max_model_calls: '20',
    telegram: false,
    enabled: true,
  };
}

export function formFromSchedule(s: Schedule): ScheduleForm {
  const f = defaultForm();
  const iv = secondsToInterval(s.spec.every_s ?? 3600);
  const once = s.spec.at ? epochToZoned(s.spec.at, s.timezone) : null;
  return {
    ...f,
    name: s.name,
    target_type: s.target_type,
    target_id: s.target_id,
    prompt: s.prompt,
    kind: s.kind,
    timezone: s.timezone,
    onceDate: once?.date ?? f.onceDate,
    onceTime: once?.time ?? f.onceTime,
    everyN: String(iv.n),
    everyUnit: iv.unit,
    time: s.spec.time ?? f.time,
    weekdays: s.spec.weekdays ?? f.weekdays,
    day: String(s.spec.day ?? 1),
    cron: s.spec.cron ?? f.cron,
    misfire_policy: s.misfire_policy,
    overlap_policy: s.overlap_policy,
    retry_max: String(s.retry_max),
    retry_delay_min: String(Math.round(s.retry_delay_s / 60) || 1),
    max_runtime_min: String(Math.round(s.max_runtime_s / 60)),
    max_model_calls: String(s.max_model_calls),
    telegram: Boolean(s.notify?.telegram),
    enabled: s.enabled,
  };
}

/** Timing spec for POST /schedules and /schedules/preview; null when the inputs are incomplete. */
export function specFromForm(f: ScheduleForm, keep: ScheduleSpec = {}): ScheduleSpec | null {
  switch (f.kind) {
    case 'once': {
      const at = zonedToEpoch(f.onceDate, f.onceTime, f.timezone);
      return at ? { at } : null;
    }
    case 'interval': {
      const n = Number(f.everyN);
      if (!Number.isFinite(n) || n <= 0) return null;
      const every_s = intervalToSeconds(n, f.everyUnit);
      return keep.start_at ? { every_s, start_at: keep.start_at } : { every_s };
    }
    case 'daily':
      return /^\d{1,2}:\d{2}$/.test(f.time) ? { time: f.time } : null;
    case 'weekly':
      return f.weekdays.length && /^\d{1,2}:\d{2}$/.test(f.time) ? { time: f.time, weekdays: [...f.weekdays].sort() } : null;
    case 'monthly': {
      const d = Number(f.day);
      return Number.isInteger(d) && d >= 1 && d <= 31 && /^\d{1,2}:\d{2}$/.test(f.time) ? { time: f.time, day: d } : null;
    }
    case 'cron':
      return f.cron.trim() ? { cron: f.cron.trim() } : null;
    default:
      return null;
  }
}

export function bodyFromForm(f: ScheduleForm, spec: ScheduleSpec): ScheduleBody {
  return {
    name: f.name.trim(),
    target_type: f.target_type,
    target_id: f.target_id,
    prompt: f.prompt.trim(),
    kind: f.kind,
    spec,
    timezone: f.timezone,
    enabled: f.enabled,
    misfire_policy: f.misfire_policy,
    overlap_policy: f.overlap_policy,
    retry_max: Number(f.retry_max),
    retry_delay_s: Math.round(Number(f.retry_delay_min) * 60),
    max_runtime_s: Math.round(Number(f.max_runtime_min) * 60),
    max_model_calls: Number(f.max_model_calls),
    notify: { telegram: f.telegram },
  };
}

function validate(f: ScheduleForm, spec: ScheduleSpec | null): string | null {
  if (!f.name.trim()) return 'Give the schedule a name';
  if (!f.target_id) return `Choose the ${f.target_type}`;
  if (f.target_type !== 'workflow' && !f.prompt.trim()) return 'Write the prompt the target receives';
  if (!spec) return 'Complete the timing';
  if (f.kind === 'interval' && (spec.every_s ?? 0) < 60) return 'The interval must be at least 1 minute';
  const ints: [string, string, number, number][] = [
    ['Retries', f.retry_max, 0, 5],
    ['Retry delay (min)', f.retry_delay_min, 1, 1440],
    ['Max runtime (min)', f.max_runtime_min, 1, 360],
    ['Max model calls', f.max_model_calls, 1, 100],
  ];
  for (const [label, v, lo, hi] of ints) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) return `${label}: ${lo}–${hi}`;
  }
  return null;
}

/** Interval previews of an existing schedule are anchored to its creation time like the host scheduler. */
function previewSpec(s: Schedule): ScheduleSpec {
  return s.kind === 'interval' && !s.spec.start_at ? { ...s.spec, start_at: s.created_at } : s.spec;
}

// ---------------------------------------------------------------- editor
function usePreview(kind: ScheduleKind, spec: ScheduleSpec | null, tz: string, count = 5) {
  const key = JSON.stringify([kind, spec, tz, count]);
  const dKey = useDebounced(key, 400);
  const [state, setState] = useState<{ next: number[] | null; error: string | null; loading: boolean }>({ next: null, error: null, loading: false });
  useEffect(() => {
    const [k, sp, z, c] = JSON.parse(dKey) as [ScheduleKind, ScheduleSpec | null, string, number];
    if (!sp) {
      setState({ next: null, error: null, loading: false });
      return;
    }
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    api.schedules
      .preview({ kind: k, spec: sp, timezone: z, count: c }, ctl.signal)
      .then((r) => setState({ next: r.next, error: null, loading: false }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setState({ next: null, error: errorMessage(e), loading: false });
      });
    return () => ctl.abort();
  }, [dKey]);
  return state;
}

function PreviewList({ next, tz, error, loading }: { next: number[] | null; tz: string; error: string | null; loading: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-input/60 p-3.5" aria-live="polite">
      <p className="mb-2 flex items-center gap-2 text-2xs font-semibold tracking-wider text-subtle uppercase">
        Next runs {loading && <Spinner className="size-3" />}
      </p>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !next ? (
        <p className="text-sm text-muted">Complete the timing to see the next runs.</p>
      ) : next.length === 0 ? (
        <p className="text-sm text-warn">This schedule never fires again (the date is in the past).</p>
      ) : (
        <ol className="space-y-1">
          {next.map((t) => (
            <li key={t} className="flex flex-wrap justify-between gap-x-3 text-[13px]">
              <span className="text-text tabular-nums">{formatInZone(t, tz, { year: 'numeric' })}</span>
              <span className="text-xs text-subtle">{relativeTime(t)}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-2xs text-subtle">Computed by the host in {tz}.</p>
    </div>
  );
}

export function ScheduleEditor({ schedule, onClose, onSaved }: { schedule: Schedule | null; onClose: () => void; onSaved: (s: Schedule) => void }) {
  const ids = { name: useId(), target: useId(), prompt: useId(), tz: useId(), date: useId(), time: useId(), n: useId(), unit: useId(), day: useId(), cron: useId(), preset: useId(), rmax: useId(), rdel: useId(), rt: useId(), mc: useId() };
  const [f, setF] = useState<ScheduleForm>(() => (schedule ? formFromSchedule(schedule) : defaultForm()));
  const set = <K extends keyof ScheduleForm>(k: K, v: ScheduleForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const agents = useApi(() => api.agents.list(), []);
  const teams = useApi(() => api.teams.list(), []);
  const workflows = useApi(() => api.workflows.list(), []);
  const zones = useMemo(() => timeZones(), []);
  const { run, isPending } = useAction();
  const spec = specFromForm(f, schedule?.kind === 'interval' ? schedule.spec : {});
  const preview = usePreview(f.kind, spec, f.timezone);
  const invalid = validate(f, spec) ?? (preview.error ? 'Fix the timing (see the preview)' : null);

  const targets =
    f.target_type === 'agent'
      ? (agents.data ?? []).map((a) => ({ id: a.id, name: a.name }))
      : f.target_type === 'team'
        ? (teams.data ?? []).map((t) => ({ id: t.id, name: t.name }))
        : (workflows.data ?? []).map((w) => ({ id: w.id, name: `${w.name}${w.enabled ? '' : ' (disabled)'}` }));
  const targetsLoading = f.target_type === 'agent' ? !agents.data : f.target_type === 'team' ? !teams.data : !workflows.data;
  const targetsError = f.target_type === 'agent' ? agents.error : f.target_type === 'team' ? teams.error : workflows.error;

  const save = async () => {
    if (!spec) return;
    const body = bodyFromForm(f, spec);
    const r = schedule
      ? await run('save', () => api.schedules.update(schedule.id, body), { success: 'Schedule saved', errorTitle: 'Schedule not saved' })
      : await run('save', () => api.schedules.create(body), { success: `Schedule ${body.name} created`, errorTitle: 'Schedule not created' });
    if (r) onSaved(r);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!isPending('save')}
      width="lg"
      title={schedule ? `Edit ${schedule.name}` : 'New schedule'}
      description="Schedules live in the host database and survive restarts. Each fire runs at most once, with a hard runtime and model-call budget."
      footer={
        <>
          <Button onClick={onClose} disabled={isPending('save')}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={isPending('save')} disabledReason={invalid}>
            {schedule ? 'Save schedule' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <Field htmlFor={ids.name} label="Name" required>
          <Input id={ids.name} value={f.name} maxLength={128} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Morning inbox summary" data-autofocus />
        </Field>

        <section className="space-y-3">
          <h3 className="text-[13px] font-medium text-text">What runs</h3>
          <SegmentedControl<ScheduleTarget>
            label="Target type"
            value={f.target_type}
            onChange={(v) => setF((x) => ({ ...x, target_type: v, target_id: '' }))}
            options={[
              { value: 'agent', label: 'Agent' },
              { value: 'team', label: 'Team' },
              { value: 'workflow', label: 'Workflow' },
            ]}
          />
          <Field htmlFor={ids.target} label={f.target_type === 'agent' ? 'Agent' : f.target_type === 'team' ? 'Team' : 'Workflow'} required error={targetsError ? errorMessage(targetsError) : null}>
            <Select id={ids.target} value={f.target_id} onChange={(e) => set('target_id', e.target.value)} disabled={targetsLoading}>
              <option value="">{targetsLoading ? 'Loading…' : targets.length ? `Choose a ${f.target_type}` : `No ${f.target_type}s yet`}</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              {f.target_id && !targets.some((t) => t.id === f.target_id) && !targetsLoading && <option value={f.target_id}>{shortId(f.target_id)} (not found)</option>}
            </Select>
          </Field>
          <Field
            htmlFor={ids.prompt}
            label={f.target_type === 'workflow' ? 'Prompt (optional)' : 'Prompt'}
            required={f.target_type !== 'workflow'}
            hint={f.target_type === 'workflow' ? 'Passed to the workflow as payload.prompt.' : 'Exactly what the agent or team receives on every run.'}
          >
            <Textarea id={ids.prompt} rows={4} maxLength={20000} value={f.prompt} onChange={(e) => set('prompt', e.target.value)} />
          </Field>
        </section>

        <section className="space-y-3">
          <h3 className="text-[13px] font-medium text-text">When</h3>
          <SegmentedControl<ScheduleKind>
            label="Repeat"
            value={f.kind}
            onChange={(v) => set('kind', v)}
            options={[
              { value: 'once', label: 'Once' },
              { value: 'interval', label: 'Interval' },
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly', label: 'Monthly' },
              { value: 'cron', label: 'Cron' },
            ]}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {f.kind === 'once' && (
              <>
                <Field htmlFor={ids.date} label="Date">
                  <Input id={ids.date} type="date" value={f.onceDate} onChange={(e) => set('onceDate', e.target.value)} />
                </Field>
                <Field htmlFor={ids.time} label="Time">
                  <Input id={ids.time} type="time" value={f.onceTime} onChange={(e) => set('onceTime', e.target.value)} />
                </Field>
              </>
            )}
            {f.kind === 'interval' && (
              <>
                <Field htmlFor={ids.n} label="Every">
                  <Input id={ids.n} type="number" min={1} value={f.everyN} onChange={(e) => set('everyN', e.target.value)} />
                </Field>
                <Field htmlFor={ids.unit} label="Unit" hint="Counted from when the schedule was created.">
                  <Select id={ids.unit} value={f.everyUnit} onChange={(e) => set('everyUnit', e.target.value as IntervalUnit)}>
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </Select>
                </Field>
              </>
            )}
            {(f.kind === 'daily' || f.kind === 'weekly' || f.kind === 'monthly') && (
              <Field htmlFor={ids.time} label="Time of day">
                <Input id={ids.time} type="time" value={f.time} onChange={(e) => set('time', e.target.value)} />
              </Field>
            )}
            {f.kind === 'monthly' && (
              <Field htmlFor={ids.day} label="Day of the month" hint="Months without this day are skipped.">
                <Input id={ids.day} type="number" min={1} max={31} value={f.day} onChange={(e) => set('day', e.target.value)} />
              </Field>
            )}
            {f.kind === 'cron' && (
              <>
                <Field htmlFor={ids.cron} label="Cron expression" hint="minute hour day month weekday (0 = Sunday)">
                  <Input id={ids.cron} value={f.cron} onChange={(e) => set('cron', e.target.value)} className="font-mono" spellCheck={false} />
                </Field>
                <Field htmlFor={ids.preset} label="Start from a preset">
                  <Select id={ids.preset} value="" onChange={(e) => e.target.value && set('cron', e.target.value)}>
                    <option value="">Choose…</option>
                    {CRON_PRESETS.map((p) => (
                      <option key={p.cron} value={p.cron}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            <Field htmlFor={ids.tz} label="Time zone">
              <Select id={ids.tz} value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {!zones.includes(f.timezone) && <option value={f.timezone}>{f.timezone}</option>}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {f.kind === 'weekly' && (
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium text-text">Days</legend>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((w) => {
                  const on = f.weekdays.includes(w.d);
                  return (
                    <button
                      key={w.d}
                      type="button"
                      aria-pressed={on}
                      aria-label={w.long}
                      onClick={() => set('weekdays', on ? f.weekdays.filter((x) => x !== w.d) : [...f.weekdays, w.d])}
                      className={`h-9 min-w-12 rounded-lg border px-2.5 text-[13px] font-medium transition-colors focus-ring touch:h-11 ${
                        on ? 'border-accent/50 bg-accent/15 text-text' : 'border-border text-muted hover:text-text'
                      }`}
                    >
                      {w.short}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          {spec && <p className="text-xs text-muted">{describeSchedule(f.kind, spec, f.timezone)} ({f.timezone})</p>}
          <PreviewList {...preview} tz={f.timezone} />
        </section>

        <details className="group rounded-xl border border-border" open={Boolean(schedule)}>
          <summary className="flex items-center justify-between rounded-xl px-4 py-3 text-[13px] font-medium text-text focus-ring">
            Reliability & limits
            <IconChevronRight className="size-4 text-subtle transition-transform group-open:rotate-90" />
          </summary>
          <div className="space-y-5 border-t border-border px-4 py-4">
            <div className="space-y-2">
              <span className="text-[13px] font-medium text-text">If a run was missed (Mac asleep or off)</span>
              <SegmentedControl
                label="Missed runs"
                value={f.misfire_policy}
                onChange={(v) => set('misfire_policy', v)}
                options={[
                  { value: 'run_once', label: 'Run once' },
                  { value: 'skip', label: 'Skip' },
                  { value: 'ask', label: 'Ask me' },
                ]}
              />
              <p className="text-xs text-muted">
                {f.misfire_policy === 'run_once'
                  ? 'One catch-up run, no matter how many fires were missed.'
                  : f.misfire_policy === 'skip'
                    ? 'Missed fires are recorded as skipped.'
                    : 'You get an approval request (dashboard and Telegram) before a catch-up run.'}
              </p>
            </div>
            <div className="space-y-2">
              <span className="text-[13px] font-medium text-text">If the previous run is still active</span>
              <SegmentedControl
                label="Overlapping runs"
                value={f.overlap_policy}
                onChange={(v) => set('overlap_policy', v)}
                options={[
                  { value: 'skip', label: 'Skip this fire' },
                  { value: 'queue', label: 'Queue it' },
                ]}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor={ids.rmax} label="Retries after a failure" hint="0–5">
                <Input id={ids.rmax} type="number" min={0} max={5} value={f.retry_max} onChange={(e) => set('retry_max', e.target.value)} />
              </Field>
              <Field htmlFor={ids.rdel} label="Retry delay (minutes)">
                <Input id={ids.rdel} type="number" min={1} max={1440} value={f.retry_delay_min} onChange={(e) => set('retry_delay_min', e.target.value)} disabled={f.retry_max === '0'} />
              </Field>
              <Field htmlFor={ids.rt} label="Max runtime (minutes)" hint="The run is cancelled when exceeded (1–360).">
                <Input id={ids.rt} type="number" min={1} max={360} value={f.max_runtime_min} onChange={(e) => set('max_runtime_min', e.target.value)} />
              </Field>
              <Field htmlFor={ids.mc} label="Max model calls" hint="Hard budget per run (1–100).">
                <Input id={ids.mc} type="number" min={1} max={100} value={f.max_model_calls} onChange={(e) => set('max_model_calls', e.target.value)} />
              </Field>
            </div>
            <Switch checked={f.telegram} onChange={(v) => set('telegram', v)} label="Notify me on Telegram" description="Sends the result of each run to your paired Telegram chat." />
            <Switch checked={f.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
          </div>
        </details>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------- calendar
interface Fire {
  t: number;
  s: Schedule;
  past?: ScheduleRun;
}

function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - wd);
  return x;
}

export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = startOfWeek(first);
  const days: Date[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  // drop a trailing week that belongs entirely to the next month
  return days[35].getMonth() !== month ? days.slice(0, 35) : days;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CalendarView({ schedules }: { schedules: Schedule[] }) {
  const today = new Date();
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today));
  const [selected, setSelected] = useState<string>(dayKey(today));
  const enabled = schedules.filter((s) => s.enabled);
  const sig = enabled.map((s) => `${s.id}:${s.updated_at}`).join('|');
  const upcoming = useApi(
    async (signal) => {
      const res = await Promise.all(
        enabled.map((s) =>
          api.schedules
            .preview({ kind: s.kind, spec: previewSpec(s), timezone: s.timezone, count: 20 }, signal)
            .then((r) => r.next.map((t) => ({ t, s })))
            .catch(() => [] as Fire[]),
        ),
      );
      return res.flat();
    },
    [sig],
  );
  const runs = useApi(() => api.schedules.runs(undefined, 300), []);
  const fires = useMemo(() => {
    const byId = new Map(schedules.map((s) => [s.id, s]));
    const past: Fire[] = (runs.data ?? []).flatMap((r) => {
      const s = byId.get(r.schedule_id);
      return s ? [{ t: r.started_at ?? r.scheduled_for, s, past: r }] : [];
    });
    const all = [...past, ...(upcoming.data ?? [])].sort((a, b) => a.t - b.t);
    const map = new Map<string, Fire[]>();
    for (const f of all) {
      const k = localDayKey(f.t);
      map.set(k, [...(map.get(k) ?? []), f]);
    }
    return map;
  }, [upcoming.data, runs.data, schedules]);

  const days = mode === 'month' ? monthGrid(cursor.getFullYear(), cursor.getMonth()) : Array.from({ length: 7 }, (_, i) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i));
  const title =
    mode === 'month'
      ? cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : `${days[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const shift = (d: number) => {
    if (mode === 'month') setCursor((c) => new Date(c.getFullYear(), c.getMonth() + d, 1));
    else setWeekStart((w) => new Date(w.getFullYear(), w.getMonth(), w.getDate() + 7 * d));
  };
  const selFires = fires.get(selected) ?? [];
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const time = (t: number) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-base font-semibold text-text capitalize">{title}</h2>
        <SegmentedControl
          label="Calendar range"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'month', label: 'Month' },
            { value: 'week', label: 'Week' },
          ]}
        />
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Previous" icon={<IconChevronLeft />} onClick={() => shift(-1)}>
            <span className="sr-only">Previous</span>
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
              setWeekStart(startOfWeek(today));
              setSelected(dayKey(today));
            }}
          >
            Today
          </Button>
          <Button size="sm" variant="ghost" aria-label="Next" icon={<IconChevronRight />} onClick={() => shift(1)}>
            <span className="sr-only">Next</span>
          </Button>
        </div>
      </div>
      {upcoming.error ? <ErrorBanner error={upcoming.error} onRetry={upcoming.reload} /> : null}
      <div className="overflow-hidden rounded-xl border border-border bg-panel shadow-card">
        <div className="grid grid-cols-7 border-b border-border text-center text-2xs font-medium tracking-wider text-subtle uppercase">
          {WEEKDAYS.map((w) => (
            <div key={w.d} className="py-2">
              <span className="sm:hidden">{w.short[0]}</span>
              <span className="hidden sm:inline">{w.short}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7" role="grid" aria-label={title}>
          {days.map((d) => {
            const k = dayKey(d);
            const list = fires.get(k) ?? [];
            const out = mode === 'month' && d.getMonth() !== cursor.getMonth();
            const isToday = k === dayKey(today);
            const sel = k === selected;
            return (
              <button
                key={k}
                type="button"
                role="gridcell"
                aria-selected={sel}
                aria-label={`${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}: ${list.length} run(s)`}
                onClick={() => setSelected(k)}
                className={`relative flex flex-col items-stretch gap-1 border-r border-b border-border/70 p-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-soft sm:p-2 [&:nth-child(7n)]:border-r-0 ${
                  mode === 'month' ? 'min-h-14 sm:min-h-24' : 'min-h-40'
                } ${sel ? 'bg-accent/[0.08]' : 'hover:bg-white/[0.02]'} ${out ? 'opacity-40' : ''}`}
              >
                <span className={`grid size-6 place-items-center rounded-full text-xs tabular-nums ${isToday ? 'bg-accent font-semibold text-white' : 'text-muted'}`}>{d.getDate()}</span>
                {/* phone: dots */}
                <span className="flex flex-wrap gap-0.5 sm:hidden" aria-hidden>
                  {list.slice(0, 4).map((f, i) => (
                    <span key={i} className={`size-1.5 rounded-full ${f.past ? (f.past.state === 'FAILED' ? 'bg-danger' : 'bg-subtle') : 'bg-accent-soft'}`} />
                  ))}
                </span>
                {/* larger screens: chips */}
                <span className="hidden flex-col gap-0.5 sm:flex" aria-hidden>
                  {list.slice(0, mode === 'month' ? 3 : 8).map((f, i) => (
                    <span
                      key={i}
                      className={`truncate rounded px-1 py-px text-[10.5px] leading-4 ${
                        f.past ? (f.past.state === 'FAILED' ? 'bg-danger/10 text-danger' : 'bg-white/[0.04] text-subtle') : 'bg-accent/15 text-accent-soft'
                      }`}
                    >
                      {time(f.t)} {f.s.name}
                    </span>
                  ))}
                  {list.length > (mode === 'month' ? 3 : 8) && <span className="px-1 text-[10px] text-subtle">+{list.length - (mode === 'month' ? 3 : 8)} more</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-subtle">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-accent-soft" /> upcoming (next 20 per schedule)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-subtle" /> past run
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-danger" /> failed run
        </span>
        <span>Times in your time zone ({tzName}).</span>
        {upcoming.loading && <Spinner className="size-3" />}
      </div>
      <Card title={new Date(`${selected}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} padded={false}>
        {selFires.length === 0 ? (
          <p className="px-5 py-5 text-sm text-muted">Nothing scheduled on this day.</p>
        ) : (
          <ul>
            {selFires.map((f, i) => (
              <li key={i} className="border-b border-border/60 last:border-0">
                <a href={href(`/schedules/${f.s.id}`)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-soft sm:px-5">
                  <span className="w-14 shrink-0 text-sm text-text tabular-nums">{time(f.t)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{f.s.name}</span>
                  {f.past ? <StatusPill state={f.past.state} /> : <Badge tone="accent">upcoming</Badge>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- list page
function useScheduleActions(onChanged: () => void) {
  const { run, isPending } = useAction();
  const toggle = async (s: Schedule, enabled: boolean) => {
    const r = await run(`en-${s.id}`, () => api.schedules.update(s.id, { enabled }), { success: `${s.name} ${enabled ? 'enabled' : 'paused'}`, errorTitle: 'Schedule not changed' });
    if (r) onChanged();
  };
  const runNow = async (s: Schedule) => {
    const r = await run(`run-${s.id}`, () => api.schedules.runNow(s.id), { success: `${s.name} started`, errorTitle: 'Run not started' });
    if (r) onChanged();
  };
  return { toggle, runNow, isPending };
}

export function SchedulesPage({ query }: { query: URLSearchParams }) {
  const schedules = useApi(() => api.schedules.list(), []);
  const view = query.get('view') === 'calendar' ? 'calendar' : 'list';
  const [editing, setEditing] = useState<Schedule | 'new' | null>(query.get('new') ? 'new' : null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const { run } = useAction();
  const acts = useScheduleActions(schedules.reload);
  useNow(30_000);
  useLiveRefresh(schedules.reload, (e) => e.type.startsWith('schedule.run.'), 800);
  useEffect(() => {
    if (query.get('new')) navigate(view === 'calendar' ? '/schedules?view=calendar' : '/schedules', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const list = schedules.data ?? [];

  const columns: Column<Schedule>[] = [
    {
      key: 'name',
      header: 'Schedule',
      mobile: 'title',
      cell: (s) => (
        <div className="min-w-0">
          <a href={href(`/schedules/${s.id}`)} className="rounded font-medium text-text hover:underline focus-ring" onClick={(e) => e.stopPropagation()}>
            {s.name}
          </a>
          <p className="mt-0.5 truncate text-xs text-subtle">
            {s.target_type} · {s.target_name ?? shortId(s.target_id)}
          </p>
        </div>
      ),
    },
    { key: 'when', header: 'When', mobile: 'subtitle', cell: (s) => <span className="text-muted">{describeSchedule(s.kind, s.spec, s.timezone)}</span> },
    {
      key: 'next',
      header: 'Next run',
      cell: (s) =>
        s.enabled && s.next_run_at ? (
          <span title={formatTime(s.next_run_at)} className="text-text">
            {relativeTime(s.next_run_at)}
          </span>
        ) : (
          <span className="text-subtle">{s.enabled ? 'not scheduled' : 'paused'}</span>
        ),
    },
    {
      key: 'last',
      header: 'Last run',
      cell: (s) =>
        s.last_run ? (
          <span className="inline-flex items-center gap-2">
            <StatusPill state={s.last_run.state} pulse={s.last_run.state === 'RUNNING'} />
            <span className="text-xs text-subtle">{relativeTime(s.last_run.created_at)}</span>
          </span>
        ) : (
          <span className="text-subtle">never</span>
        ),
    },
    {
      key: 'enabled',
      header: 'Enabled',
      mobile: 'aside',
      cell: (s) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
          <Switch hideLabel label={`${s.name} enabled`} checked={s.enabled} loading={acts.isPending(`en-${s.id}`)} onChange={(v) => void acts.toggle(s, v)} />
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      mobile: 'aside',
      cell: (s) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation" className="inline-flex">
          <DropdownMenu
            label={`Actions for ${s.name}`}
            items={[
              { label: 'Run now', icon: <IconPlay />, onSelect: () => void acts.runNow(s) },
              { label: 'Edit…', icon: <IconEdit />, onSelect: () => setEditing(s) },
              { label: 'Delete…', icon: <IconTrash />, danger: true, separatorBefore: true, onSelect: () => setDeleting(s) },
            ]}
          />
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Run agents, teams and workflows at fixed times. Missed runs, overlaps, retries and budgets follow the rules you set."
        actions={
          <>
            <SegmentedControl
              label="View"
              value={view}
              onChange={(v) => navigate(v === 'calendar' ? '/schedules?view=calendar' : '/schedules', { replace: true })}
              options={[
                { value: 'list', label: 'List', icon: <IconList /> },
                { value: 'calendar', label: 'Calendar', icon: <IconCalendar /> },
              ]}
            />
            <Button variant="primary" icon={<IconPlus />} onClick={() => setEditing('new')}>
              New schedule
            </Button>
          </>
        }
      />
      {schedules.error ? (
        <div className="mb-4">
          <ErrorBanner error={schedules.error} onRetry={schedules.reload} />
        </div>
      ) : null}
      {!schedules.data && schedules.loading ? (
        <div className="rounded-xl border border-border bg-panel p-5">
          <LoadingRows rows={5} label="Loading schedules…" />
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<IconSchedules />}
          title="No schedules yet"
          action={
            <Button variant="primary" icon={<IconPlus />} onClick={() => setEditing('new')}>
              Create a schedule
            </Button>
          }
        >
          For example: every weekday at 08:30 ask an agent to summarise new mail, or run a team’s weekly report on Monday morning.
        </EmptyState>
      ) : view === 'calendar' ? (
        <CalendarView schedules={list} />
      ) : (
        <DataTable label="Schedules" columns={columns} rows={list} rowKey={(s) => s.id} onRowClick={(s) => navigate(`/schedules/${s.id}`)} rowLabel={(s) => `Open ${s.name}`} minWidth={820} />
      )}
      {editing && (
        <ScheduleEditor
          schedule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            schedules.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? 'schedule'}?`}
        confirmLabel="Delete schedule"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const r = await run('del', () => api.schedules.remove(deleting.id), { success: `${deleting.name} deleted`, errorTitle: 'Schedule not deleted' });
          if (r) {
            setDeleting(null);
            schedules.reload();
          }
        }}
      >
        <p>The schedule and its run history are removed. Tasks it already started keep running.</p>
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------- detail page
function targetLink(r: ScheduleRun, s: Schedule): string | null {
  const t = r.target_ref ?? {};
  if (t.task_id && s.target_type === 'agent') return href(`/agents/${s.target_id}/tasks?task=${t.task_id}`);
  if (t.team_run_id) return href(`/teams/${s.target_id}/runs/${t.team_run_id}`);
  if (t.workflow_run_id) return href('/workflows');
  return null;
}

export function ScheduleDetailPage({ scheduleId }: { scheduleId: string }) {
  const d = useApi(() => api.schedules.get(scheduleId), [scheduleId]);
  const s = d.data;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { run } = useAction();
  const acts = useScheduleActions(d.reload);
  const next = useApi(
    (signal) => (s ? api.schedules.preview({ kind: s.kind, spec: previewSpec(s), timezone: s.timezone, count: 10 }, signal) : Promise.resolve({ next: [] as number[] })),
    [s?.id, s?.updated_at],
  );
  useNow(30_000);
  useLiveRefresh(d.reload, (e) => e.type.startsWith('schedule.run.') && e.payload.schedule_id === scheduleId, 500);

  if (!s) {
    if (d.error instanceof ApiError && d.error.status === 404)
      return (
        <EmptyState title="Schedule not found" action={<ButtonLink href={href('/schedules')}>Back to schedules</ButtonLink>}>
          It may have been deleted.
        </EmptyState>
      );
    return d.error ? (
      <ErrorBanner error={d.error} onRetry={d.reload} />
    ) : (
      <div className="rounded-xl border border-border bg-panel p-5">
        <LoadingRows label="Loading schedule…" />
      </div>
    );
  }

  const runCols: Column<ScheduleRun>[] = [
    { key: 'state', header: 'Result', mobile: 'aside', cell: (r) => <StatusPill state={r.state} pulse={r.state === 'RUNNING'} /> },
    {
      key: 'when',
      header: 'Scheduled for',
      mobile: 'title',
      cell: (r) => (
        <span className="text-text" title={formatTime(r.scheduled_for)}>
          {formatTime(r.scheduled_for)}
        </span>
      ),
    },
    { key: 'trigger', header: 'Trigger', mobile: 'subtitle', cell: (r) => `${r.trigger}${r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}` },
    { key: 'dur', header: 'Duration', cell: (r) => (r.started_at && r.finished_at ? formatDuration(r.finished_at - r.started_at) : r.started_at ? 'running' : '—') },
    { key: 'detail', header: 'Detail', className: 'max-w-[360px]', cell: (r) => <span className="line-clamp-2 text-xs text-muted">{r.detail || '—'}</span> },
    {
      key: 'link',
      header: <span className="sr-only">Target</span>,
      cell: (r) => {
        const l = targetLink(r, s);
        return l ? (
          <a href={l} className="rounded text-xs text-accent-soft hover:underline focus-ring">
            Open
          </a>
        ) : null;
      },
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Schedules', href: href('/schedules') }, { label: s.name }]}
        title={s.name}
        meta={
          <>
            <Badge tone={s.enabled ? 'success' : 'neutral'} dot>
              {s.enabled ? 'enabled' : 'paused'}
            </Badge>
            <Badge icon={s.kind === 'once' ? <IconClock /> : <IconRepeat />}>{describeSchedule(s.kind, s.spec, s.timezone)}</Badge>
            <Badge>{s.timezone}</Badge>
          </>
        }
        actions={
          <>
            <Switch label="Enabled" checked={s.enabled} loading={acts.isPending(`en-${s.id}`)} onChange={(v) => void acts.toggle(s, v)} />
            <Button icon={<IconEdit />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="danger" icon={<IconTrash />} onClick={() => setDeleting(true)}>
              Delete
            </Button>
            <Button variant="primary" icon={<IconPlay />} loading={acts.isPending(`run-${s.id}`)} onClick={() => void acts.runNow(s)}>
              Run now
            </Button>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Configuration" className="lg:col-span-2">
          <KeyValue
            items={[
              [
                'Target',
                <span key="t">
                  {s.target_type} ·{' '}
                  <a
                    className="rounded text-accent-soft hover:underline focus-ring"
                    href={s.target_type === 'agent' ? href(`/agents/${s.target_id}`) : s.target_type === 'team' ? href(`/teams/${s.target_id}`) : href('/workflows')}
                  >
                    {s.target_name ?? shortId(s.target_id)}
                  </a>
                </span>,
              ],
              ['Prompt', s.prompt ? <span key="p" className="whitespace-pre-wrap">{s.prompt}</span> : '—'],
              ['Timing', `${describeSchedule(s.kind, s.spec, s.timezone)} (${s.timezone})`],
              ...(s.kind === 'cron' ? ([['Cron', <Mono key="c">{s.spec.cron}</Mono>]] as [string, ReactNode][]) : []),
              ['Missed runs', s.misfire_policy === 'run_once' ? 'one catch-up run' : s.misfire_policy === 'skip' ? 'skipped' : 'ask me first'],
              ['Overlap', s.overlap_policy === 'skip' ? 'skip while the previous run is active' : 'queue'],
              ['Retries', s.retry_max ? `${s.retry_max} × after ${formatDuration(s.retry_delay_s)}` : 'none'],
              ['Budget', `${s.max_model_calls} model calls · ${formatDuration(s.max_runtime_s)} max runtime`],
              ['Telegram', s.notify?.telegram ? 'result is sent to Telegram' : 'off'],
              ['Last run', s.last_run_at ? formatTime(s.last_run_at) : 'never'],
            ]}
          />
        </Card>
        <Card title="Upcoming" icon={<IconCalendar />}>
          {!s.enabled ? (
            <p className="text-sm text-muted">Paused — enable the schedule to run it again.</p>
          ) : next.error ? (
            <ErrorBanner error={next.error} onRetry={next.reload} />
          ) : !next.data ? (
            <LoadingRows rows={4} />
          ) : next.data.next.length === 0 ? (
            <p className="text-sm text-muted">No future run.</p>
          ) : (
            <ol className="space-y-1.5">
              {next.data.next.map((t) => (
                <li key={t} className="flex flex-wrap justify-between gap-x-3 text-[13px]">
                  <span className="text-text tabular-nums">{formatInZone(t, s.timezone)}</span>
                  <span className="text-xs text-subtle">{relativeTime(t)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
      <h2 className="mt-8 mb-3 text-sm font-semibold text-text">Run history</h2>
      {s.runs.length === 0 ? (
        <EmptyState compact title="No runs yet">Use “Run now” to test the schedule without waiting.</EmptyState>
      ) : (
        <DataTable label="Run history" columns={runCols} rows={s.runs} rowKey={(r) => r.id} minWidth={760} dense />
      )}
      {editing && (
        <ScheduleEditor
          schedule={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            d.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        title={`Delete ${s.name}?`}
        confirmLabel="Delete schedule"
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          const r = await run('del', () => api.schedules.remove(s.id), { success: `${s.name} deleted`, errorTitle: 'Schedule not deleted' });
          if (r) navigate('/schedules');
        }}
      >
        <p>The schedule and its run history are removed. Tasks it already started keep running.</p>
      </ConfirmDialog>
    </>
  );
}
