// A small, safe Markdown renderer for chat messages. It builds React elements only (never raw HTML): paragraphs,
// headings, bold / italic / strikethrough, inline code, fenced code blocks with a copy button, lists, quotes, rules
// and links. Links are rendered only for http(s) URLs, always with rel="noopener noreferrer" target="_blank".
import { memo, useState, type ReactNode } from 'react';
import { openExternal, isInTelegram, haptic } from '../telegram';
import { IcCheck, IcCopy } from '../icons';

/** The URL when it is a plain http(s) link, else null (javascript:, data:, relative … are refused). */
export function safeHref(raw: string): string | null {
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.stopPropagation();
        if (isInTelegram()) {
          e.preventDefault();
          openExternal(href);
        }
      }}
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------- inline
// code | [text](url) | bare URL | **bold** | __bold__ | ~~strike~~ | *italic* | _italic_   (no look-behind: older iOS)
const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([^*\n]*?[^\s*])\*|_(?=[^\s_])([^_\n]*?[^\s_])_/g;

const WORD = /[\p{L}\p{N}]/u;

export function renderInline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const k = `${key}.${n++}`;
    // `_x_` inside snake_case words stays literal
    if (m[10] !== undefined && ((start > 0 && WORD.test(text[start - 1])) || WORD.test(text[re.lastIndex] ?? ''))) continue;
    if (start > last) out.push(text.slice(last, start));
    if (m[2] !== undefined) {
      out.push(
        <code key={k} className="nb-inline">
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined) {
      const href = safeHref(m[4]);
      out.push(href ? <Link key={k} href={href}>{renderInline(m[3], k)}</Link> : <span key={k}>{renderInline(m[3], k)}</span>);
    } else if (m[5] !== undefined) {
      const href = safeHref(m[5]);
      out.push(href ? <Link key={k} href={href}>{m[5]}</Link> : m[5]);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      out.push(<strong key={k} className="font-semibold">{renderInline(m[6] ?? m[7], k)}</strong>);
    } else if (m[8] !== undefined) {
      out.push(<del key={k}>{renderInline(m[8], k)}</del>);
    } else if (m[9] !== undefined || m[10] !== undefined) {
      out.push(<em key={k}>{renderInline(m[9] ?? m[10], k)}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Inline text with single newlines kept as line breaks. */
function lines(text: string, key: string): ReactNode[] {
  const parts = text.split('\n');
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (i) out.push(<br key={`${key}.br${i}`} />);
    out.push(...renderInline(p, `${key}.${i}`));
  });
  return out;
}

// ---------------------------------------------------------------- blocks
export type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: 1 | 2 | 3; text: string }
  | { t: 'code'; lang: string; code: string }
  | { t: 'ul' | 'ol'; items: string[]; start: number }
  | { t: 'quote'; text: string }
  | { t: 'hr' };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const UL = /^\s{0,3}[-*+]\s+(.*)$/;
const OL = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;

const isBlockStart = (l: string) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || UL.test(l) || OL.test(l);

export function parseBlocks(src: string): Block[] {
  const ls = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < ls.length) {
    const l = ls[i];
    if (!l.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(l);
    if (fence) {
      const close = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < ls.length && !(ls[i].trim().startsWith(close[0].repeat(3)) && ls[i].trim().replace(/[`~]/g, '') === '')) {
        body.push(ls[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of text)
      blocks.push({ t: 'code', lang: fence[2] ?? '', code: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(l);
    if (h) {
      blocks.push({ t: 'h', level: Math.min(3, h[1].length) as 1 | 2 | 3, text: h[2] });
      i += 1;
      continue;
    }
    if (HR.test(l)) {
      blocks.push({ t: 'hr' });
      i += 1;
      continue;
    }
    if (QUOTE.test(l)) {
      const body: string[] = [];
      while (i < ls.length && QUOTE.test(ls[i])) {
        body.push((QUOTE.exec(ls[i]) as RegExpExecArray)[1]);
        i += 1;
      }
      blocks.push({ t: 'quote', text: body.join('\n') });
      continue;
    }
    const ul = UL.exec(l);
    const ol = OL.exec(l);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: string[] = [];
      const start = ol ? Number(ol[1]) : 1;
      while (i < ls.length) {
        const cur = ls[i];
        const m = ordered ? OL.exec(cur) : UL.exec(cur);
        if (m) {
          items.push(ordered ? m[2] : m[1]);
          i += 1;
        } else if (cur.trim() && /^\s{2,}\S/.test(cur) && items.length) {
          items[items.length - 1] += `\n${cur.trim()}`; // continuation line
          i += 1;
        } else break;
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', items, start });
      continue;
    }
    const para: string[] = [];
    while (i < ls.length && ls[i].trim() && !(para.length && isBlockStart(ls[i]))) {
      para.push(ls[i]);
      i += 1;
    }
    blocks.push({ t: 'p', text: para.join('\n') });
  }
  return blocks;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="nb-code overflow-hidden rounded-xl text-[13px] leading-relaxed text-text">
      <div className="flex items-center justify-between gap-2 border-b border-border py-0.5 pr-0.5 pl-3">
        <span className="truncate font-mono text-caption text-subtle">{lang || 'code'}</span>
        <button
          type="button"
          onClick={async (e) => {
            e.stopPropagation();
            if (await copyText(code)) {
              haptic('selection');
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }
          }}
          className="nb-press flex min-h-9 items-center gap-1 rounded-lg px-2 text-caption font-medium text-muted focus-ring [&>svg]:size-4"
          aria-label={copied ? 'Code copied' : 'Copy code'}
        >
          {copied ? <IcCheck /> : <IcCopy />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono whitespace-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`nb-md ${className}`}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case 'code':
            return <CodeBlock key={k} lang={b.lang} code={b.code} />;
          case 'h':
            return b.level === 1 ? <h1 key={k}>{renderInline(b.text, k)}</h1> : b.level === 2 ? <h2 key={k}>{renderInline(b.text, k)}</h2> : <h3 key={k}>{renderInline(b.text, k)}</h3>;
          case 'hr':
            return <hr key={k} />;
          case 'quote':
            return <blockquote key={k}>{lines(b.text, k)}</blockquote>;
          case 'ul':
            return (
              <ul key={k}>
                {b.items.map((it, j) => (
                  <li key={j}>{lines(it, `${k}.${j}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={k} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{lines(it, `${k}.${j}`)}</li>
                ))}
              </ol>
            );
          default:
            return <p key={k}>{lines(b.text, k)}</p>;
        }
      })}
    </div>
  );
});
