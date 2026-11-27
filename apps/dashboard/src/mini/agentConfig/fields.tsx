// Form controls of the agent creator / settings in the Mini App style: inset grouped rows, 44 px targets, native
// selects (the platform picker on phones), iOS-like switches and radio rows.
import { useId, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { IcCheck, IcChevron } from '../icons';
import { cx } from '../uiKit';

export const inputClass = 'nb-input block w-full min-w-0 rounded-xl bg-text/8 px-3 text-body text-text placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-50';

/** Label, control, and one line of error / warning / hint (wired to the control with aria-describedby). */
export function FieldShell({
  id,
  label,
  required,
  hint,
  error,
  warning,
  aside,
  children,
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  warning?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-5 items-baseline justify-between gap-2 px-1">
        <label htmlFor={id} className="text-footnote font-medium text-muted">
          {label}
          {required && (
            <span aria-hidden className="ml-0.5 text-danger">
              *
            </span>
          )}
        </label>
        {aside && <span className="text-caption text-subtle tabular-nums">{aside}</span>}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="px-1 text-footnote text-danger">
          {error}
        </p>
      ) : warning ? (
        <p id={`${id}-warning`} className="px-1 text-footnote text-warn">
          {warning}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="px-1 text-footnote text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const describedBy = (id: string, error?: string | null, warning?: ReactNode, hint?: ReactNode) =>
  error ? `${id}-error` : warning ? `${id}-warning` : hint ? `${id}-hint` : undefined;

export function TextInput({ invalid, className = '', ...rest }: { invalid?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return <input aria-invalid={invalid || undefined} className={cx(inputClass, 'min-h-11', className)} {...rest} />;
}

export function TextArea({ invalid, className = '', ...rest }: { invalid?: boolean } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea aria-invalid={invalid || undefined} className={cx(inputClass, 'min-h-22 resize-y py-2.5 leading-relaxed', className)} {...rest} />;
}

export function SelectInput({ invalid, className = '', children, ...rest }: { invalid?: boolean } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select aria-invalid={invalid || undefined} className={cx(inputClass, 'nb-select min-h-11 cursor-pointer appearance-none', className)} {...rest}>
      {children}
    </select>
  );
}

/** iOS-style on/off switch (role="switch"); its label lives in the row. */
export function MiniSwitch({ checked, onChange, disabled, labelledBy, describedBy: desc, id }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; labelledBy: string; describedBy?: string; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={desc}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'nb-press relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full transition-colors duration-200 focus-ring disabled:cursor-not-allowed disabled:opacity-45',
        checked ? 'bg-accent-fill' : 'bg-text/15',
      )}
    >
      <span aria-hidden className={cx('block size-[27px] rounded-full bg-white shadow-card transition-transform duration-200', checked ? 'translate-x-[22px]' : 'translate-x-[2px]')} />
    </button>
  );
}

/** One switch row of an inset list: label, description, an optional badge / note. */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  badge,
  note,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  badge?: ReactNode;
  note?: ReactNode;
}) {
  const id = useId();
  return (
    <li className="group/row flex min-h-12 items-center pl-4">
      <span className="flex min-w-0 flex-1 items-center gap-3 self-stretch border-b border-border py-2.5 pr-3 group-last/row:border-b-0">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span id={`${id}-l`} className={cx('text-body text-text', disabled && 'opacity-50')}>
              {label}
            </span>
            {badge}
          </span>
          {description && (
            <span id={`${id}-d`} className="mt-0.5 block text-footnote text-muted">
              {description}
            </span>
          )}
          {note && <span className="mt-0.5 block text-footnote text-warn">{note}</span>}
        </span>
        <MiniSwitch checked={checked} onChange={onChange} disabled={disabled} labelledBy={`${id}-l`} describedBy={description ? `${id}-d` : undefined} />
      </span>
    </li>
  );
}

export interface RadioOption<T extends string> {
  id: T;
  label: ReactNode;
  description?: ReactNode;
  /** Shown when disabled: why it cannot be chosen. */
  reason?: ReactNode;
  disabled?: boolean;
  trailing?: ReactNode;
}

/** Inset list of radio rows (role="radiogroup"), the Mini App's Appearance pattern. */
export function RadioList<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  invalid,
  describedBy: desc,
  testId,
}: {
  label: string;
  value: T | '';
  options: RadioOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  testId?: string;
}) {
  return (
    <ul role="radiogroup" aria-label={label} aria-invalid={invalid || undefined} aria-describedby={desc} data-testid={testId} className={cx('overflow-hidden rounded-card bg-panel', invalid && 'shadow-[0_0_0_1.5px_var(--color-danger)]')}>
      {options.map((o) => {
        const on = value === o.id;
        const off = disabled || Boolean(o.disabled);
        return (
          <li key={o.id} className="group/row">
            <button
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={off || undefined}
              disabled={off}
              onClick={() => !off && onChange(o.id)}
              className={cx('nb-row flex min-h-12 w-full items-center gap-3 pl-4 text-left focus-ring', off && 'cursor-not-allowed')}
            >
              <span className="flex min-w-0 flex-1 items-center gap-3 self-stretch border-b border-border py-2.5 pr-4 group-last/row:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className={cx('block text-body text-text', off && !on && 'opacity-50')}>{o.label}</span>
                  {o.description && <span className="mt-0.5 block text-footnote text-muted">{o.description}</span>}
                  {off && o.reason && <span className="mt-0.5 block text-footnote text-warn">{o.reason}</span>}
                </span>
                {o.trailing}
                <span aria-hidden className={cx('grid size-6 shrink-0 place-items-center rounded-full border-2', on ? 'border-accent bg-accent' : 'border-subtle', off && !on && 'opacity-40')}>
                  {on && <span className="size-2 rounded-full bg-white" />}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Multi-select rows (role="checkbox"). */
export function CheckRow({ label, description, checked, onChange, disabled, reason }: { label: string; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; reason?: ReactNode }) {
  return (
    <li className="group/row">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('nb-row flex min-h-12 w-full items-center gap-3 pl-4 text-left focus-ring', disabled && 'cursor-not-allowed')}
      >
        <span className="flex min-w-0 flex-1 items-center gap-3 self-stretch border-b border-border py-2.5 pr-4 group-last/row:border-b-0">
          <span className="min-w-0 flex-1">
            <span className={cx('block text-body text-text', disabled && 'opacity-50')}>{label}</span>
            {description && <span className="mt-0.5 block text-footnote text-muted">{description}</span>}
            {disabled && reason && <span className="mt-0.5 block text-footnote text-warn">{reason}</span>}
          </span>
          <span aria-hidden className={cx('grid size-6 shrink-0 place-items-center rounded-full border-2 text-white [&>svg]:size-4', checked ? 'border-accent bg-accent' : 'border-subtle', disabled && 'opacity-40')}>
            {checked && <IcCheck strokeWidth={2.4} />}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Section header that expands / collapses its content (the content stays mounted: nothing typed is lost). */
export function Disclosure({ title, open, onToggle, children, id }: { title: string; open: boolean; onToggle: () => void; children: ReactNode; id: string }) {
  return (
    <section className="mb-6">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="nb-row flex min-h-12 w-full items-center gap-3 rounded-card bg-panel px-4 text-left focus-ring"
      >
        <span className="flex-1 text-body font-medium text-text">{title}</span>
        <IcChevron aria-hidden className={cx('size-4 text-subtle transition-transform duration-200', open && 'rotate-90')} />
      </button>
      <div id={id} hidden={!open} className="mt-3">
        {children}
      </div>
    </section>
  );
}
