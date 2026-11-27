// The built Dashboard must carry noVNC's MPL-2.0 notice (esbuild strips its header comments from the bundle).
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { cwd } from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { collectLicenseFiles, leadingComment, novncSourceUrl } from '../../scripts/third-party-licenses.mjs';
import { setRouteBase } from '../hooks/useHashRoute';
import { AboutCard } from '../pages/SettingsPage';

const root = cwd(); // vitest runs from apps/dashboard

afterEach(() => {
  cleanup();
  setRouteBase('');
});

describe('third-party license notices', () => {
  const files = collectLicenseFiles(root);

  it('ships noVNC license, the MPL-2.0 text, pako and the DES notice', () => {
    expect(Object.keys(files).sort()).toEqual([
      'licenses/THIRD_PARTY_NOTICES.txt',
      'licenses/novnc-LICENSE.MPL-2.0.txt',
      'licenses/novnc-LICENSE.txt',
      'licenses/novnc-des-NOTICE.txt',
      'licenses/novnc-pako-LICENSE.txt',
      'licenses/react-LICENSE.txt',
      'licenses/react-dom-LICENSE.txt',
      'licenses/scheduler-LICENSE.txt',
    ]);
    expect(files['licenses/novnc-LICENSE.txt']).toMatch(/noVNC is Copyright/);
    expect(files['licenses/novnc-LICENSE.MPL-2.0.txt']).toMatch(/Mozilla Public License Version 2\.0/);
    expect(files['licenses/novnc-pako-LICENSE.txt']).toMatch(/MIT License/);
    expect(files['licenses/novnc-des-NOTICE.txt']).toMatch(/Acme\.Crypto|ACME Labs/);
    for (const text of Object.values(files)) expect(text.trim().length).toBeGreaterThan(200);
  });

  it('the index names the exact bundled noVNC version, says it is unmodified and links its source', () => {
    const version = (JSON.parse(readFileSync(`${root}/node_modules/@novnc/novnc/package.json`, 'utf8')) as { version: string }).version;
    const index = files['licenses/THIRD_PARTY_NOTICES.txt'];
    expect(index).toContain(`noVNC ${version} - MPL-2.0`);
    expect(index).toContain(novncSourceUrl(version));
    expect(index).toMatch(/UNMODIFIED/);
    expect(index).toMatch(/NEBULA itself is released under the MIT License/);
  });

  it('leadingComment returns the header block verbatim and rejects files without one', () => {
    expect(leadingComment('/* a\n * b */\ncode();')).toBe('/* a\n * b */');
    expect(() => leadingComment('code(); /* late */')).toThrow();
  });

  it('Settings links to the notices', () => {
    render(<AboutCard />);
    const link = screen.getByRole('link', { name: 'Third-party licenses' });
    expect(link).toHaveAttribute('href', '/licenses/THIRD_PARTY_NOTICES.txt');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/noVNC \(MPL-2\.0, unmodified\)/)).toBeInTheDocument();
  });

  it('inside the Mini App administration area (its gateway serves no /licenses) there is no dead link', () => {
    setRouteBase('/admin');
    render(<AboutCard />);
    expect(screen.queryByRole('link', { name: 'Third-party licenses' })).toBeNull();
  });
});
