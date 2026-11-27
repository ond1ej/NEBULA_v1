import { describe, expect, it, vi } from 'vitest';
import { xhrError } from './api';
import { detectDelimiter, parseCsv } from './csv';
import {
  baseName,
  breadcrumbs,
  copyName,
  displayPath,
  extOf,
  fileKind,
  isInside,
  isTextLike,
  joinPath,
  normalizePath,
  parentPath,
  sortEntries,
  validateName,
  versionPath,
  versionTimestamp,
} from './paths';
import { nextQueued, uploadsReducer, type UploadItem } from './uploads';
import type { FileEntry } from './types';

describe('paths', () => {
  it('normalises and joins relative paths', () => {
    expect(normalizePath('')).toBe('.');
    expect(normalizePath('/')).toBe('.');
    expect(normalizePath('./a//b/')).toBe('a/b');
    expect(joinPath('.', 'x.txt')).toBe('x.txt');
    expect(joinPath('a/b', 'c')).toBe('a/b/c');
    expect(joinPath('a', '.')).toBe('a');
  });

  it('parent / base names', () => {
    expect(parentPath('.')).toBe('.');
    expect(parentPath('a')).toBe('.');
    expect(parentPath('a/b/c.txt')).toBe('a/b');
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(baseName('.')).toBe('');
    expect(displayPath('.')).toBe('/');
    expect(displayPath('a/b')).toBe('/a/b');
  });

  it('builds breadcrumbs', () => {
    expect(breadcrumbs('.', 'Ada')).toEqual([{ label: 'Ada', path: '.' }]);
    expect(breadcrumbs('docs/2026/q1', 'Ada')).toEqual([
      { label: 'Ada', path: '.' },
      { label: 'docs', path: 'docs' },
      { label: '2026', path: 'docs/2026' },
      { label: 'q1', path: 'docs/2026/q1' },
    ]);
  });

  it('validates names like the server confinement', () => {
    expect(validateName('')).toMatch(/Enter/);
    expect(validateName('..')).toMatch(/not allowed/);
    expect(validateName('a/b')).toMatch(/“\/”/);
    expect(validateName('.nebula_versions')).toMatch(/reserved/);
    expect(validateName('x'.repeat(256))).toMatch(/too long/);
    expect(validateName('Report 2026.pdf')).toBeNull();
  });

  it('suggests copy names', () => {
    expect(copyName('report.txt', ['report.txt'])).toBe('report copy.txt');
    expect(copyName('report.txt', ['report copy.txt'])).toBe('report copy 2.txt');
    expect(copyName('Makefile', [])).toBe('Makefile copy');
    expect(copyName('.bashrc', [])).toBe('.bashrc copy');
  });

  it('detects moving a folder into itself', () => {
    expect(isInside('a/b', 'a')).toBe(true);
    expect(isInside('a', 'a')).toBe(true);
    expect(isInside('ab', 'a')).toBe(false);
    expect(isInside('x', '.')).toBe(true);
  });

  it('locates stored versions (.nebula_versions/<parent>/<name>.<ts>)', () => {
    expect(versionPath('notes.txt', 'notes.txt.1731700000')).toBe('.nebula_versions/notes.txt.1731700000');
    expect(versionPath('a/b/notes.txt', 'notes.txt.1731700000')).toBe('.nebula_versions/a/b/notes.txt.1731700000');
    expect(versionTimestamp('notes.txt.1731700000')).toBe(1731700000);
    expect(versionTimestamp('notes.txt')).toBeNull();
  });

  it('classifies files', () => {
    expect(extOf('a/b/Photo.JPG')).toBe('jpg');
    expect(extOf('.env')).toBe('');
    expect(fileKind({ name: 'x', type: 'dir' })).toBe('folder');
    expect(fileKind({ name: 'x.png', type: 'file' })).toBe('image');
    expect(fileKind({ name: 'x.csv', type: 'file' })).toBe('table');
    expect(fileKind({ name: 'x.py', type: 'file' })).toBe('code');
    expect(fileKind({ name: 'README', type: 'file' })).toBe('text');
    expect(fileKind({ name: 'l', type: 'symlink' })).toBe('symlink');
    expect(isTextLike({ name: 'a.md', type: 'file' })).toBe(true);
    expect(isTextLike({ name: 'a.tsv', type: 'file' })).toBe(true);
    expect(isTextLike({ name: 'a.xlsx', type: 'file' })).toBe(false);
  });

  it('sorts folders first', () => {
    const e = (name: string, type: string, size = 0, mtime = 0): FileEntry => ({ name, path: name, type, size, mtime });
    const list = [e('b.txt', 'file', 5, 3), e('Z', 'dir'), e('a10.txt', 'file', 1, 9), e('a2.txt', 'file', 9, 1), e('a', 'dir')];
    expect(sortEntries(list, 'name', 'asc').map((x) => x.name)).toEqual(['a', 'Z', 'a2.txt', 'a10.txt', 'b.txt']);
    expect(sortEntries(list, 'size', 'desc').map((x) => x.name)).toEqual(['Z', 'a', 'a2.txt', 'b.txt', 'a10.txt']);
    expect(sortEntries(list, 'mtime', 'asc').slice(2).map((x) => x.name)).toEqual(['a2.txt', 'b.txt', 'a10.txt']);
  });
});

describe('CSV', () => {
  it('parses quotes, escaped quotes, embedded newlines and CRLF', () => {
    const r = parseCsv('name,note\r\n"Doe, Jane","said ""hi""\nthen left"\r\nBob,\n');
    expect(r.rows).toEqual([
      ['name', 'note'],
      ['Doe, Jane', 'said "hi"\nthen left'],
      ['Bob', ''],
    ]);
    expect(r.columns).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('handles a missing final newline, BOM and ragged rows', () => {
    expect(parseCsv('﻿a;b\n1;2;3', ';')).toEqual({ rows: [['a', 'b'], ['1', '2', '3']], truncated: false, columns: 3 });
    expect(parseCsv('').rows).toEqual([]);
  });

  it('limits rows', () => {
    const r = parseCsv('1\n2\n3\n4\n', ',', 2);
    expect(r.rows).toEqual([['1'], ['2']]);
    expect(r.truncated).toBe(true);
  });

  it('detects the delimiter', () => {
    expect(detectDelimiter('x.tsv', 'a,b')).toBe('\t');
    expect(detectDelimiter('x.csv', 'jméno;částka;datum\n')).toBe(';');
    expect(detectDelimiter('x.csv', 'a,b;c,d')).toBe(',');
    expect(detectDelimiter('x.csv', 'a\tb\tc')).toBe('\t');
  });
});

describe('uploads queue', () => {
  const item = (id: number, status: UploadItem['status'] = 'queued'): UploadItem => ({
    id,
    name: `f${id}`,
    size: 10,
    root: 'exchange',
    path: `f${id}`,
    status,
    loaded: 0,
    overwrite: false,
    error: null,
    retryable: true,
  });

  it('uploads one file at a time in order', () => {
    let s = uploadsReducer([], { type: 'add', items: [item(1), item(2)] });
    expect(nextQueued(s)?.id).toBe(1);
    s = uploadsReducer(s, { type: 'start', id: 1 });
    expect(nextQueued(s)).toBeUndefined();
    s = uploadsReducer(s, { type: 'progress', id: 1, loaded: 5 });
    s = uploadsReducer(s, { type: 'done', id: 1 });
    expect(s[0]).toMatchObject({ status: 'done', loaded: 10 });
    expect(nextQueued(s)?.id).toBe(2);
  });

  it('a 409 asks first; replacing re-queues with overwrite', () => {
    let s = uploadsReducer([item(1, 'uploading')], { type: 'exists', id: 1 });
    expect(s[0].status).toBe('exists');
    expect(nextQueued(s)).toBeUndefined();
    s = uploadsReducer(s, { type: 'overwrite', id: 1 });
    expect(s[0]).toMatchObject({ status: 'queued', overwrite: true });
  });

  it('clears finished items and keeps failed ones', () => {
    const s = uploadsReducer([item(1, 'done'), item(2, 'cancelled'), item(3, 'error'), item(4)], { type: 'clear' });
    expect(s.map((x) => x.id)).toEqual([3, 4]);
  });

  it('turns XHR error bodies into ApiErrors', () => {
    const e = xhrError(409, JSON.stringify({ error: { code: 'exists', message: 'a.txt already exists' }, request_id: 'r1' }), null);
    expect(e).toMatchObject({ status: 409, code: 'exists', message: 'a.txt already exists', requestId: 'r1' });
    expect(xhrError(502, '<html>Bad gateway</html>', 'h')).toMatchObject({ status: 502, code: 'http_502', requestId: 'h' });
  });
});

describe('downloads', () => {
  it('surfaces host errors instead of saving an error page', async () => {
    const { installFetch, apiError } = await import('../../test/fetchMock');
    const { downloadFile } = await import('./download');
    const { calls } = installFetch({ 'GET /api/v1/files/download': () => apiError(500, 'internal_error', 'UnicodeEncodeError') });
    await expect(downloadFile('agent:a1', 'zpráva-řeč.txt', 'zpráva-řeč.txt', 10)).rejects.toMatchObject({ status: 500, code: 'internal_error' });
    expect(calls[0].url).toContain('root=agent%3Aa1');
    vi.unstubAllGlobals();
  });
});
