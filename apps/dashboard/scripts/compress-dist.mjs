#!/usr/bin/env node
// Precompresses the built Dashboard / Mini App so the host can serve `Content-Encoding: br` or `gzip` without
// compressing on every request: writes `<file>.br` (brotli, quality 11) and `<file>.gz` (gzip, level 9) next to every
// .js, .css, .svg, .html and .json file in dist/ that is larger than 1 KB. The original files are kept.
//
// Usage: node scripts/compress-dist.mjs [distDir]   (default: ./dist, run after `vite build`)
// Node built-ins only (node:zlib).
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

export const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.html', '.json']);
export const MIN_BYTES = 1024;

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Compresses one buffer the way the host expects (exported for tests). */
export async function compressBuffer(buf) {
  const [br, gzBuf] = await Promise.all([
    brotli(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }),
    gz(buf, { level: 9 }),
  ]);
  return { br, gz: gzBuf };
}

/**
 * Writes the .br/.gz siblings for every eligible file in `distDir`; removes stale siblings of files that are now too
 * small. Returns one row per compressed file.
 */
export async function compressDist(distDir) {
  const root = resolve(distDir);
  const rows = [];
  const files = [];
  for await (const f of walk(root)) files.push(f);
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!COMPRESSIBLE.has(ext)) continue;
    const { size } = await stat(file);
    if (size <= MIN_BYTES) {
      for (const sib of [`${file}.br`, `${file}.gz`]) await unlink(sib).catch(() => undefined);
      continue;
    }
    const buf = await readFile(file);
    const out = await compressBuffer(buf);
    await Promise.all([writeFile(`${file}.br`, out.br), writeFile(`${file}.gz`, out.gz)]);
    rows.push({ file: relative(root, file), raw: buf.length, gzip: out.gz.length, brotli: out.br.length });
  }
  return rows;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dist = process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
  const started = Date.now();
  compressDist(dist)
    .then((rows) => {
      const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
      const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
      console.log(
        `compress-dist: ${rows.length} files · raw ${kb(sum('raw'))} → gzip ${kb(sum('gzip'))} · brotli ${kb(sum('brotli'))} (${Date.now() - started} ms)`,
      );
    })
    .catch((e) => {
      console.error('compress-dist failed:', e);
      process.exitCode = 1;
    });
}
