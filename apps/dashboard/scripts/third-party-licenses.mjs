// Third-party license notices that must ship with the built Dashboard (build output: dist/licenses/).
//
// esbuild strips noVNC's ordinary header comments from the bundle, so the files below are emitted next to it instead:
// noVNC (MPL-2.0, unmodified, with the source link MPL-2.0 section 3.2 asks for), the pako (MIT) and DES (BSD-style)
// code inside it, and the licenses of the other runtime libraries that end up in the bundle (React, ReactDOM, Scheduler).
// Everything is read from the installed packages, so the notices always match the versions that were bundled.
//
// Used by vite.config.ts (emitted into the build, served by the dev server) and by src/test/thirdPartyLicenses.test.ts.
// Node built-ins only.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the unmodified noVNC source of a given version lives. */
export const novncSourceUrl = (version) => `https://github.com/novnc/noVNC/tree/v${version}`;

/** The leading block comment of a source file ("Ported from ... Full attribution follows"), verbatim. */
export function leadingComment(source) {
  const start = source.indexOf('/*');
  const end = source.indexOf('*/', start + 2);
  if (start !== 0 || end < 0) throw new Error('expected the file to start with a block comment');
  return source.slice(0, end + 2);
}

/** Real directory of an installed package (pnpm links it into a store; a package sits next to its siblings there). */
function packageDir(projectDir, name) {
  return realpathSync(join(projectDir, 'node_modules', name));
}

/**
 * Returns `{ "licenses/<file>": text }` for every notice file. `projectDir` is the dashboard directory (the one whose
 * node_modules holds the dependencies).
 */
export function collectLicenseFiles(projectDir) {
  const read = (...p) => readFileSync(join(...p), 'utf8');
  const meta = (dir) => JSON.parse(read(dir, 'package.json'));

  const novnc = packageDir(projectDir, '@novnc/novnc');
  const react = packageDir(projectDir, 'react');
  const reactDom = packageDir(projectDir, 'react-dom');
  const scheduler = join(dirname(reactDom), 'scheduler');
  const novncMeta = meta(novnc);
  const files = {};

  files['licenses/novnc-LICENSE.txt'] = read(novnc, 'LICENSE.txt');
  files['licenses/novnc-LICENSE.MPL-2.0.txt'] = read(novnc, 'docs', 'LICENSE.MPL-2.0');
  files['licenses/novnc-pako-LICENSE.txt'] = read(novnc, 'vendor', 'pako', 'LICENSE');
  files['licenses/novnc-des-NOTICE.txt'] = `${leadingComment(read(novnc, 'core', 'crypto', 'des.js'))}\n`;
  for (const [file, dir] of [
    ['react-LICENSE.txt', react],
    ['react-dom-LICENSE.txt', reactDom],
    ['scheduler-LICENSE.txt', scheduler],
  ]) {
    files[`licenses/${file}`] = read(dir, 'LICENSE');
  }

  const reactMeta = meta(react);
  const reactDomMeta = meta(reactDom);
  const schedulerMeta = meta(scheduler);
  files['licenses/THIRD_PARTY_NOTICES.txt'] = `NEBULA Dashboard - third-party notices
=====================================

NEBULA itself is released under the MIT License. The Dashboard bundle contains the following third-party code.

noVNC ${novncMeta.version} - MPL-2.0
------------------------------------
Used for the Live Desktop view. The noVNC package is included UNMODIFIED; its core library files are licensed under
the Mozilla Public License 2.0, which only covers noVNC's own files, not NEBULA's code.

  Source code of the exact version bundled:  ${novncSourceUrl(novncMeta.version)}
  Project:                                   https://github.com/novnc/noVNC
  Copyright (C) 2022 The noVNC authors (see the AUTHORS file in the source).

You may obtain the Source Code Form of noVNC at the address above (Mozilla Public License 2.0, section 3.2).

  licenses/novnc-LICENSE.txt           noVNC's own license statement (lists which files carry which license)
  licenses/novnc-LICENSE.MPL-2.0.txt   the full text of the Mozilla Public License 2.0
  licenses/novnc-pako-LICENSE.txt      pako (MIT), zlib port used by noVNC's decoders
  licenses/novnc-des-NOTICE.txt        DES implementation notice (various BSD-style licenses), from core/crypto/des.js

React ${reactMeta.version}, ReactDOM ${reactDomMeta.version}, Scheduler ${schedulerMeta.version} - MIT
------------------------------------------------------------------
  licenses/react-LICENSE.txt
  licenses/react-dom-LICENSE.txt
  licenses/scheduler-LICENSE.txt

Build tooling (Vite, Tailwind CSS, TypeScript, ...) is not part of the shipped bundle. Tailwind CSS keeps its own MIT
notice in the built stylesheet.
`;
  return files;
}
