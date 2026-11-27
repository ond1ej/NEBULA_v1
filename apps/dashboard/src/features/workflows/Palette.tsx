// Block palette: tap / Enter adds a block in the middle of the canvas; dragging a block (mouse, pen or a
// horizontal touch drag) drops it where the pointer is released.
import { useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Input } from '../../components/ui';
import { BLOCK_NOTES } from './params';
import { IconBolt, IconBranch, IconPlayCircle } from './icons';
import type { CatalogBlock } from './types';

const GROUPS: { id: string; title: string; Icon: typeof IconBolt; cls: string }[] = [
  { id: 'Triggers', title: 'Triggers', Icon: IconBolt, cls: 'bg-info/15 text-info' },
  { id: 'Actions', title: 'Actions', Icon: IconPlayCircle, cls: 'bg-accent/15 text-accent-soft' },
  { id: 'Logic', title: 'Logic', Icon: IconBranch, cls: 'bg-warn/15 text-warn' },
];

export function Palette({
  blocks,
  onAdd,
  onDrop,
  disabledReason,
}: {
  blocks: CatalogBlock[];
  /** Tap / click / Enter: add at the canvas centre. */
  onAdd: (block: CatalogBlock) => void;
  /** Drag released at a client point; return true when it landed on the canvas. */
  onDrop: (block: CatalogBlock, clientX: number, clientY: number) => boolean;
  disabledReason?: string | null;
}) {
  const searchId = useId();
  const [q, setQ] = useState('');
  const [ghost, setGhost] = useState<{ block: CatalogBlock; x: number; y: number } | null>(null);
  const drag = useRef<{ block: CatalogBlock; pointerId: number; sx: number; sy: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return blocks;
    return blocks.filter((b) => b.label.toLowerCase().includes(s) || b.type.toLowerCase().includes(s));
  }, [blocks, q]);

  const down = (b: CatalogBlock) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabledReason || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag.current = { block: b, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, active: false };
    suppressClick.current = false;
    // Mouse / pen: capture now so a fast drag still reports its moves and release here. Touch pointers are
    // captured implicitly by the browser (and must stay free to scroll the list vertically).
    if (e.pointerType !== 'touch') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
      d.active = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    setGhost({ block: d.block, x: e.clientX, y: e.clientY });
  };
  const up = (e: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.pointerId !== e.pointerId) return;
    setGhost(null);
    if (d.active) {
      suppressClick.current = true;
      if (!cancelled) onDrop(d.block, e.clientX, e.clientY);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="select-text">
        <label htmlFor={searchId} className="sr-only">
          Filter blocks
        </label>
        <Input id={searchId} type="search" placeholder="Filter blocks…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {disabledReason && <p className="text-xs text-warn">{disabledReason}</p>}
      <p className="text-xs text-subtle">Drag onto the canvas, or tap to add.</p>
      {GROUPS.map((g) => {
        const items = filtered.filter((b) => b.group === g.id);
        if (items.length === 0) return null;
        return (
          <section key={g.id} aria-label={g.title} className="select-none">
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">{g.title}</h3>
            <ul className="flex flex-col gap-1">
              {items.map((b) => (
                <li key={b.type}>
                  <button
                    type="button"
                    disabled={!!disabledReason}
                    onPointerDown={down(b)}
                    onPointerMove={move}
                    onPointerUp={(e) => up(e)}
                    onPointerCancel={(e) => up(e, true)}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      onAdd(b);
                    }}
                    title={BLOCK_NOTES[b.type]}
                    aria-label={`Add ${b.label} block`}
                    aria-describedby={`${searchId}-${b.type}`}
                    className="flex min-h-11 w-full touch-pan-y items-center gap-2.5 rounded-md border border-transparent px-2 py-1.5 text-left text-sm text-text hover:border-border hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${g.cls}`}>
                      <g.Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{b.label}</span>
                      <span id={`${searchId}-${b.type}`} className="block truncate text-[11px] text-subtle">
                        {BLOCK_NOTES[b.type] ?? b.type}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {filtered.length === 0 && <p className="text-sm text-muted">No block matches “{q}”.</p>}
      {ghost &&
        createPortal(
          <div
            aria-hidden
            className="pointer-events-none fixed z-[120] flex items-center gap-2 rounded-lg border border-accent/60 bg-panel-2 px-3 py-2 text-sm font-medium text-text shadow-pop"
            style={{ left: ghost.x + 8, top: ghost.y + 8 }}
          >
            {ghost.block.label}
          </div>,
          document.body,
        )}
    </div>
  );
}
