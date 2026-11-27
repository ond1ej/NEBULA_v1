// Parameter editor specification per block type, plus local checks that mirror
// workflows._check_params / cron.next_run / schedules._validate (the server remains the authority).
import { MAX_LOOP, REQUIRED } from './graph';
import type { Params } from './types';

export type FieldKind =
  | 'text'
  | 'template'
  | 'number'
  | 'select'
  | 'bool'
  | 'agent'
  | 'team'
  | 'root'
  | 'cases'
  | 'schedule';

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  /** For agent / root pickers: an empty value is allowed and means "any". */
  emptyLabel?: string;
  /** Rows for template textareas. */
  rows?: number;
  visible?: (p: Params) => boolean;
}

export const OPS: { value: string; label: string }[] = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains (case-insensitive)' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'gt', label: 'is greater than (number)' },
  { value: 'lt', label: 'is less than (number)' },
  { value: 'exists', label: 'is not empty' },
  { value: 'empty', label: 'is empty' },
  { value: 'matches', label: 'matches regular expression' },
];

const NO_RIGHT = new Set(['exists', 'empty']);

export const SCHEDULE_KINDS: { value: string; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'interval', label: 'Every N minutes' },
  { value: 'once', label: 'Once' },
  { value: 'cron', label: 'Cron expression' },
];

export const MISFIRE: { value: string; label: string }[] = [
  { value: 'run_once', label: 'Run once when NEBULA is back' },
  { value: 'skip', label: 'Skip missed runs' },
  { value: 'ask', label: 'Ask me first' },
];

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const TEMPLATE_HINT =
  'Templates: {{trigger.text}} (trigger payload), {{nodes.<id>.summary}} (an earlier block), {{last.summary}} / {{last.text}} (previous action), {{loop.item}} (inside a loop body).';

const agentField = (hint?: string): FieldSpec => ({ key: 'agent_id', label: 'Agent', kind: 'agent', hint });
const prompt = (label = 'Prompt'): FieldSpec => ({ key: 'prompt', label, kind: 'template', rows: 5 });
const modelCalls: FieldSpec = {
  key: 'max_model_calls',
  label: 'Max model calls',
  kind: 'number',
  min: 1,
  max: 50,
  hint: 'Hard limit for this step (1–50).',
};
const runtime: FieldSpec = {
  key: 'max_runtime_s',
  label: 'Max runtime (seconds)',
  kind: 'number',
  min: 60,
  max: 21600,
  step: 60,
  placeholder: '1800',
  hint: 'The agent task is cancelled when it runs longer (default 1800 s).',
};

export const BLOCK_FIELDS: Record<string, FieldSpec[]> = {
  'trigger.manual': [],
  'trigger.schedule': [{ key: 'kind', label: 'Schedule', kind: 'schedule' }],
  'trigger.telegram_message': [
    {
      key: 'command',
      label: 'Command',
      kind: 'text',
      placeholder: 'report',
      hint: 'Started with “/wf <command> …” in Telegram; the rest of the message is {{trigger.text}}.',
    },
  ],
  'trigger.task_completed': [
    { key: 'agent_id', label: 'Agent', kind: 'agent', emptyLabel: 'Any agent' },
    {
      key: 'state',
      label: 'Task outcome',
      kind: 'select',
      options: [
        { value: 'COMPLETED', label: 'Completed' },
        { value: 'FAILED', label: 'Failed' },
        { value: 'any', label: 'Completed or failed' },
      ],
      hint: 'Payload: {{trigger.task_id}}, {{trigger.agent_id}}, {{trigger.state}}, {{trigger.summary}}.',
    },
  ],
  'trigger.file_created': [
    { key: 'root', label: 'Location', kind: 'root', emptyLabel: 'Any location' },
    {
      key: 'path_prefix',
      label: 'Path starts with',
      kind: 'text',
      placeholder: 'reports/',
      hint: 'Payload: {{trigger.root}}, {{trigger.path}}, {{trigger.size}}. Files written by workflows never trigger.',
    },
  ],
  'action.run_agent': [agentField(), prompt(), modelCalls, runtime],
  'action.run_team': [{ key: 'team_id', label: 'Team', kind: 'team' }, prompt()],
  'action.read_file': [
    { key: 'root', label: 'Location', kind: 'root' },
    { key: 'path', label: 'Path', kind: 'text', placeholder: 'notes/input.txt', hint: 'Relative to the location; templates allowed.' },
  ],
  'action.write_file': [
    { key: 'root', label: 'Location', kind: 'root' },
    { key: 'path', label: 'Path', kind: 'text', placeholder: 'reports/{{trigger.text}}.md' },
    { key: 'content', label: 'Content', kind: 'template', rows: 6 },
  ],
  'action.browser_task': [
    agentField(),
    { key: 'url', label: 'URL', kind: 'text', placeholder: 'https://' },
    { key: 'instructions', label: 'Instructions', kind: 'template', rows: 5 },
    modelCalls,
    runtime,
  ],
  'action.generate_report': [
    { key: 'title', label: 'Title', kind: 'text', hint: 'Available in the template as {{title}}.' },
    { key: 'template', label: 'Report template (Markdown)', kind: 'template', rows: 8 },
    { key: 'save_root', label: 'Save to location', kind: 'root', emptyLabel: 'Do not save a file' },
    {
      key: 'save_path',
      label: 'Save as',
      kind: 'text',
      placeholder: 'reports/daily.md',
      visible: (p) => !!p.save_root,
    },
  ],
  'action.send_telegram': [
    { key: 'text', label: 'Message', kind: 'template', rows: 5, hint: 'Sent to every approved Telegram chat (max 3900 characters).' },
    { key: 'attach_last_file', label: 'Attach the file produced by the previous block', kind: 'bool' },
  ],
  'action.create_task': [agentField('Queues a task and continues immediately (does not wait for it).'), prompt()],
  'action.execute_command': [
    agentField('Runs in the agent’s workspace only after you approve the exact command.'),
    { key: 'command', label: 'Shell command', kind: 'template', rows: 3 },
    { key: 'timeout', label: 'Timeout (seconds)', kind: 'number', min: 1, max: 3600, placeholder: '120' },
  ],
  'logic.condition': [
    { key: 'left', label: 'Value', kind: 'template', rows: 2 },
    { key: 'op', label: 'Comparison', kind: 'select', options: OPS },
    { key: 'right', label: 'Compare with', kind: 'template', rows: 2, visible: (p) => !NO_RIGHT.has(String(p.op ?? '')) },
  ],
  'logic.branch': [
    { key: 'value', label: 'Value', kind: 'template', rows: 2, hint: 'Compared exactly (trimmed) with each case.' },
    { key: 'cases', label: 'Cases', kind: 'cases', hint: '1–10 cases; each case is an output. No match → “default”.' },
  ],
  'logic.delay': [{ key: 'seconds', label: 'Wait (seconds)', kind: 'number', min: 0, max: 86400, hint: '0–86400 s (24 h).' }],
  'logic.retry': [
    { key: 'max_attempts', label: 'Max attempts', kind: 'number', min: 1, max: 5 },
    { key: 'delay_s', label: 'Delay between attempts (seconds)', kind: 'number', min: 0, max: 3600 },
  ],
  'logic.loop': [
    {
      key: 'items',
      label: 'Items',
      kind: 'template',
      rows: 3,
      hint: 'A JSON list or one item per line; each item is {{loop.item}} in the body. Leave empty to repeat “Count” times.',
    },
    { key: 'count', label: 'Count (when no items)', kind: 'number', min: 1, max: MAX_LOOP },
    { key: 'max_iterations', label: 'Max iterations', kind: 'number', min: 1, max: MAX_LOOP, hint: `Hard limit 1–${MAX_LOOP}.` },
  ],
  'logic.parallel': [],
  'logic.wait_approval': [
    { key: 'summary', label: 'Question shown to you', kind: 'template', rows: 3, hint: 'Approve or deny in the dashboard or Telegram (expires after 24 h).' },
  ],
};

export const BLOCK_NOTES: Record<string, string> = {
  'trigger.manual': 'Started with “Run”. An optional JSON payload is available as {{trigger.<key>}}.',
  'trigger.schedule': 'Starts the workflow on a schedule while the workflow is enabled.',
  'trigger.telegram_message': 'Starts when an approved Telegram chat sends /wf <command>.',
  'trigger.task_completed': 'Starts when an agent task finishes.',
  'trigger.file_created': 'Starts when a file is written to a workspace, team folder or the Mac exchange folder.',
  'action.run_agent': 'Gives an agent a task and waits for the result.',
  'action.run_team': 'Runs a team on a task and waits for the result.',
  'action.read_file': 'Reads a text file (max 2 MiB) into {{last.text}}.',
  'action.write_file': 'Writes text to a file.',
  'action.browser_task': 'An agent opens a page in its browser and follows the instructions.',
  'action.generate_report': 'Renders a Markdown report from a template, optionally saved as a file.',
  'action.send_telegram': 'Sends a message to your approved Telegram chats.',
  'action.create_task': 'Queues an agent task without waiting.',
  'action.execute_command': 'Runs a shell command in an agent workspace after your explicit approval.',
  'logic.condition': 'Continues on “true” or “false”.',
  'logic.branch': 'Continues on the output whose case equals the value.',
  'logic.delay': 'Waits, then continues.',
  'logic.retry': 'Retries the one action it is connected to when it fails.',
  'logic.loop': 'Runs the blocks connected to “each item” once per item, then continues on “done”.',
  'logic.parallel': 'Starts all connected blocks at the same time (max 4 at once).',
  'logic.wait_approval': 'Pauses until you approve (“next”) or deny (“denied”).',
};

export function fieldsFor(type: string): FieldSpec[] {
  return BLOCK_FIELDS[type] ?? [];
}

// ---------------------------------------------------------------- schedule helpers
export function defaultSpec(kind: string, now = Date.now()): Record<string, unknown> {
  switch (kind) {
    case 'weekly':
      return { time: '08:00', weekdays: [1] };
    case 'monthly':
      return { time: '08:00', day: 1 };
    case 'interval':
      return { every_s: 3600 };
    case 'once':
      return { at: Math.ceil(now / 1000 / 3600) * 3600 + 3600 };
    case 'cron':
      return { cron: '0 8 * * 1-5' };
    default:
      return { time: '08:00' };
  }
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** Mirrors cron.next_run validation. A one-time date in the past is allowed: that trigger has already fired and
 *  the backend simply schedules nothing for it (pick a new date to run it again). */
export function checkSchedule(p: Params, nowMs = Date.now()): string | null {
  const kind = String(p.kind ?? '');
  const spec = (p.spec && typeof p.spec === 'object' ? p.spec : {}) as Record<string, unknown>;
  const tz = String(p.timezone ?? '').trim();
  if (!SCHEDULE_KINDS.some((k) => k.value === kind)) return 'Choose a schedule type.';
  if (['daily', 'weekly', 'monthly'].includes(kind)) {
    const m = HHMM.exec(String(spec.time ?? ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return 'Time must be HH:MM.';
  }
  if (kind === 'weekly') {
    const wd = spec.weekdays;
    if (!Array.isArray(wd) || wd.length === 0) return 'Pick at least one weekday.';
    if (!wd.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return 'Weekdays must be 0 (Sunday) … 6.';
  }
  if (kind === 'monthly') {
    const d = Number(spec.day);
    if (!Number.isInteger(d) || d < 1 || d > 31) return 'Day must be 1–31.';
  }
  if (kind === 'interval' && !(Number(spec.every_s) >= 60)) return 'The interval must be at least 1 minute.';
  if (kind === 'once') {
    const at = Number(spec.at);
    if (!Number.isFinite(at) || at <= 0) return 'Pick a date and time.';
    void nowMs;
  }
  if (kind === 'cron') {
    const c = String(spec.cron ?? '').trim();
    if (!c.startsWith('@') && c.split(/\s+/).length !== 5) return 'A cron expression needs 5 fields: minute hour day month weekday.';
  }
  if (!tz) return 'Time zone is required.';
  const mp = p.misfire_policy;
  if (mp !== undefined && !MISFIRE.some((m) => m.value === mp)) return 'Choose what happens with missed runs.';
  return null;
}

// ---------------------------------------------------------------- local checks
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Field-level problems for the inspector, keyed by param name. */
export function checkParams(type: string, p: Params, nowMs = Date.now()): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const k of REQUIRED[type] ?? []) if (isEmpty(p[k])) errs[k] = 'Required';
  for (const f of fieldsFor(type)) {
    if (f.kind !== 'number' || errs[f.key]) continue;
    const v = p[f.key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) errs[f.key] = 'Must be a number';
    else if (f.min !== undefined && n < f.min) errs[f.key] = `Minimum ${f.min}`;
    else if (f.max !== undefined && n > f.max) errs[f.key] = `Maximum ${f.max}`;
  }
  if (type === 'trigger.telegram_message' && !errs.command && !/^[a-z0-9_]{1,32}$/.test(String(p.command ?? '')))
    errs.command = 'Use 1–32 characters: a–z, 0–9 and _';
  if (type === 'logic.condition' && !errs.op && !OPS.some((o) => o.value === p.op)) errs.op = 'Choose a comparison';
  if (type === 'logic.branch' && !errs.cases) {
    const cases = Array.isArray(p.cases) ? p.cases.map(String) : [];
    if (cases.length < 1 || cases.length > 10) errs.cases = 'List 1–10 cases';
    else if (cases.some((c) => !c.trim())) errs.cases = 'Cases cannot be empty';
    else if (new Set(cases).size !== cases.length) errs.cases = 'Cases must be unique';
    else if (cases.some((c) => c === 'default' || c === 'error')) errs.cases = '“default” and “error” are reserved';
  }
  if (type === 'trigger.schedule') {
    const s = checkSchedule(p, nowMs);
    if (s) errs.kind = s;
  }
  if (type === 'action.generate_report' && p.save_root && isEmpty(p.save_path)) errs.save_path = 'Required when saving';
  if (type === 'action.browser_task' && !errs.url) {
    const u = String(p.url ?? '').trim();
    if (!u.includes('{{') && !/^https?:\/\/[^\s/]+\S*$/.test(u)) errs.url = 'Enter a full http(s) URL';
  }
  return errs;
}

/** Coerces a number input value: '' removes the param (server default applies). */
export function numberParam(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------- datetime-local <-> unix seconds
export function toLocalInput(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(s: string): number | undefined {
  if (!s) return undefined;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? Math.round(t / 1000) : undefined;
}
