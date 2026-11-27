// @vitest-environment node
// Fix round "ui", checks that need Node (Vite and esbuild do not load under jsdom):
//  * the production build keeps noVNC's license notices (MPL-2.0 section 3.2): the real Vite config is loaded and its
//    license plugin's generateBundle hook runs against a recording emitFile, so dropping the plugin from vite.config.ts,
//    or a notice from scripts/third-party-licenses.mjs, fails here;
//  * the Apple apps live in the separate NEBULA-iOS repository, so the docs here name the Dashboard's real pages and
//    button, the push notes live in docs/apple-apps.md, and no doc claims that opening the pairing link pairs the app
//    or that the apps build with Xcode 16.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import config from '../../vite.config';
import { en } from '../i18n/en';

const repo = join(cwd(), '..', '..'); // vitest runs from apps/dashboard
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

describe('Apple app docs match the Dashboard', () => {
  const page = en['nav.devices'];
  const button = en['devices.pair'];

  it('the Dashboard labels the docs refer to', () => {
    expect(page).toBe('Devices');
    expect(button).toBe('Pair an iPhone or Mac');
  });

  it('docs/ios-app.md names the top-level Devices page and its button, and the paste or scan pairing', () => {
    const doc = read('docs/ios-app.md');
    expect(doc).toContain(`**Dashboard → ${page} → ${button}**`);
    expect(doc).toMatch(/Tap \*\*Scan QR code\*\*, or paste/);
    expect(doc).not.toMatch(/Settings(,| →) Devices|Pair iPhone or Mac/);
  });

  it('docs/ios-app.md says that opening the pairing link does not pair the app, and that Xcode 26 is needed', () => {
    expect(read('docs/ios-app.md')).toMatch(/does \*\*not\*\* pair the app/);
    expect(read('docs/ios-app.md')).toContain('Xcode 26 or later');
  });

  it('push notes live in docs/apple-apps.md (section "Push notifications"), never the removed APPLE_INSTALL.md', () => {
    expect(read('docs/apple-apps.md')).toMatch(/^## Push notifications$/m);
    expect(read('docs/apple-apps.md')).not.toContain('APPLE_INSTALL');
  });
});

describe('build output keeps the noVNC license notices', () => {
  it('the production build emits dist/licenses/* (index, noVNC LICENSE, MPL-2.0 text, pako, DES)', () => {
    const plugins = ((config as { plugins?: unknown[] }).plugins ?? []).flat(4) as Plugin[];
    const lic = plugins.find((p) => p && typeof p === 'object' && p.name === 'nebula-third-party-licenses');
    expect(lic).toBeDefined();
    const emitted: { type: string; fileName: string; source: string }[] = [];
    const hook = lic?.generateBundle as unknown as (this: { emitFile: (f: { type: string; fileName: string; source: string }) => string }) => void;
    hook.call({
      emitFile: (f) => {
        emitted.push(f);
        return f.fileName;
      },
    });
    expect(emitted.every((f) => f.type === 'asset')).toBe(true);
    const files = Object.fromEntries(emitted.map((f) => [f.fileName, f.source]));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'licenses/THIRD_PARTY_NOTICES.txt',
        'licenses/novnc-LICENSE.txt',
        'licenses/novnc-LICENSE.MPL-2.0.txt',
        'licenses/novnc-pako-LICENSE.txt',
        'licenses/novnc-des-NOTICE.txt',
      ]),
    );
    expect(files['licenses/novnc-LICENSE.MPL-2.0.txt']).toMatch(/Mozilla Public License Version 2\.0/);
    expect(files['licenses/novnc-LICENSE.txt']).toMatch(/noVNC is Copyright/);
    expect(files['licenses/THIRD_PARTY_NOTICES.txt']).toMatch(/noVNC [\d.]+ - MPL-2\.0/);
    expect(files['licenses/THIRD_PARTY_NOTICES.txt']).toMatch(/UNMODIFIED/);
  });
});
