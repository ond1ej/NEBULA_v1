// The build precompresses dist/ for the host (brotli q11 + gzip 9, files > 1 KB, originals kept).
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { compressDist } from '../../scripts/compress-dist.mjs';

let dir: string | null = null;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('compress-dist', () => {
  it('writes .br and .gz next to every compressible file over 1 KB and keeps the originals', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nebula-dist-'));
    await mkdir(join(dir, 'assets'));
    const big = `console.log(${JSON.stringify('nebula '.repeat(400))});\n`;
    await writeFile(join(dir, 'assets', 'main-abc.js'), big);
    await writeFile(join(dir, 'assets', 'main-abc.css'), `.a{color:red}\n`.repeat(200));
    await writeFile(join(dir, 'index.html'), `<!doctype html>${'<div></div>'.repeat(200)}`);
    await writeFile(join(dir, 'favicon.svg'), '<svg/>'); // < 1 KB: skipped
    await writeFile(join(dir, 'assets', 'font.woff2'), Buffer.alloc(4096)); // not text: skipped
    await writeFile(join(dir, 'assets', 'small.js.br'), 'stale'); // stale sibling of a small file is removed
    await writeFile(join(dir, 'assets', 'small.js'), 'x');

    const rows = await compressDist(dir);
    expect(rows.map((r) => r.file).sort()).toEqual(['assets/main-abc.css', 'assets/main-abc.js', 'index.html']);

    const assets = (await readdir(join(dir, 'assets'))).sort();
    expect(assets).toEqual(['font.woff2', 'main-abc.css', 'main-abc.css.br', 'main-abc.css.gz', 'main-abc.js', 'main-abc.js.br', 'main-abc.js.gz', 'small.js']);
    expect((await readdir(dir)).sort()).toEqual(['assets', 'favicon.svg', 'index.html', 'index.html.br', 'index.html.gz']);

    const js = join(dir, 'assets', 'main-abc.js');
    expect(await readFile(js, 'utf8')).toBe(big);
    expect(brotliDecompressSync(await readFile(`${js}.br`)).toString()).toBe(big);
    expect(gunzipSync(await readFile(`${js}.gz`)).toString()).toBe(big);
    const row = rows.find((r) => r.file === 'assets/main-abc.js');
    expect(row && row.brotli < row.gzip && row.gzip < row.raw).toBe(true);
  });
});
