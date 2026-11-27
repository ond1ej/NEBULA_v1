// The Mini App compiles its own Tailwind stylesheet from an explicit source list (src/mini/mini.css). Every shared
// component it renders must be on that list, or its utility classes would be missing in the Mini App.
// The administration area (src/mini/admin/, V3.3) reuses the Dashboard's pages with its own lazily loaded stylesheet
// (src/mini/admin/admin.css): modules reachable only through it are checked against that file instead.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ADMIN_DIR = join(SRC, 'mini/admin');

function resolveImport(from: string, spec: string): string | null {
  const base = join(dirname(from), spec);
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return normalize(p);
  }
  return null;
}

/** Modules loaded at runtime from `entry` (static and dynamic imports; `import type` excluded), not entering `stopAt`. */
function modulesFrom(entry: string, stopAt: string | null = null): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    const code = readFileSync(f, 'utf8');
    const specs = [
      ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
      ...[...code.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const s of specs) {
      const r = resolveImport(f, s);
      if (!r || !/\.tsx?$/.test(r) || r.includes('.test.')) continue;
      if (stopAt && r.startsWith(`${stopAt}/`)) continue;
      queue.push(r);
    }
  }
  return seen;
}

function sourcesOf(cssFile: string): string[] {
  const css = readFileSync(cssFile, 'utf8');
  return [...css.matchAll(/@source\s+'([^']+)'/g)].map((m) => normalize(join(dirname(cssFile), m[1])));
}

const coveredBy = (sources: string[]) => (file: string) => sources.some((s) => file === s || file.startsWith(s.endsWith('/') ? s : `${s}/`));

describe('Mini App stylesheet sources', () => {
  it('lists every shared component the Mini App renders', () => {
    const sources = sourcesOf(join(SRC, 'mini/mini.css'));
    expect(sources.length).toBeGreaterThan(3);
    const covered = coveredBy(sources);
    const components = [...modulesFrom(join(SRC, 'mini/main.tsx'), ADMIN_DIR)].filter((f) => f.endsWith('.tsx') && !f.startsWith(join(SRC, 'mini') + '/'));
    const missing = components.filter((f) => !covered(f)).map((f) => relative(SRC, f));
    expect(components.length).toBeGreaterThan(3);
    expect(missing).toEqual([]);
    // the Mini App does not pull in the Dashboard stylesheet
    expect(readFileSync(join(SRC, 'mini/main.tsx'), 'utf8')).not.toContain('index.css');
  });

  it('the administration area covers every page it reuses with its own scoped, lazily loaded stylesheet', () => {
    const adminCss = join(ADMIN_DIR, 'admin.css');
    const covered = coveredBy(sourcesOf(adminCss));
    const reached = [...modulesFrom(join(ADMIN_DIR, 'AdminArea.tsx'))].filter((f) => f.endsWith('.tsx'));
    // it really reuses the Dashboard's pages
    expect(reached.some((f) => f.endsWith('pages/AgentsPage.tsx'))).toBe(true);
    expect(reached.some((f) => f.endsWith('features/remote/RemoteAccessPage.tsx'))).toBe(true);
    expect(reached.filter((f) => !covered(f)).map((f) => relative(SRC, f))).toEqual([]);
    const css = readFileSync(adminCss, 'utf8');
    // every utility is scoped to <html data-nb-admin> (set only while the area is shown) and no preflight is re-emitted
    expect(css).toMatch(/\[data-nb-admin\]\s*\{\s*@tailwind utilities/);
    expect(css).not.toMatch(/@import\s+'tailwindcss'\s*(source|;)/);
    expect(css).toContain("@import '../tokens.css'");
    // only the admin chunk imports it; the Mini App's initial modules never do
    expect(readFileSync(join(ADMIN_DIR, 'AdminArea.tsx'), 'utf8')).toContain("import './admin.css'");
    const initial = [...modulesFrom(join(SRC, 'mini/main.tsx'), ADMIN_DIR)];
    expect(initial.filter((f) => readFileSync(f, 'utf8').includes('admin.css'))).toEqual([]);
  });

  it('both stylesheets share the Mini App tokens (no theme conflict when admin.css loads)', () => {
    const mini = readFileSync(join(SRC, 'mini/mini.css'), 'utf8');
    expect(mini).toContain("@import './tokens.css'");
    expect(mini).not.toMatch(/@theme\s*\{/); // the tokens live only in tokens.css
    const tokens = readFileSync(join(SRC, 'mini/tokens.css'), 'utf8');
    expect(tokens).toMatch(/@theme\s*\{/);
    expect(tokens).toContain(":root[data-theme='light']");
  });
});
