import { describe, expect, it } from 'vitest';
import { kindOf, MAX_ATTACHMENT_BYTES, typeLabel, validateFile } from './attachments';

describe('attachment checks (mirror the host intake)', () => {
  it('accepts up to 50 MB and rejects larger, empty and executable files', () => {
    expect(validateFile({ name: 'photo.jpg', size: 1024, type: 'image/jpeg' })).toBeNull();
    expect(validateFile({ name: 'clip.mov', size: MAX_ATTACHMENT_BYTES, type: 'video/quicktime' })).toBeNull();
    expect(validateFile({ name: 'clip.mov', size: MAX_ATTACHMENT_BYTES + 1, type: 'video/quicktime' })).toBe('Larger than 50 MB');
    expect(validateFile({ name: 'empty.txt', size: 0, type: 'text/plain' })).toBe('The file is empty');
    for (const name of ['setup.exe', 'Installer.DMG', 'app.apk', 'run.command', 'x.ps1', 'lib.dll']) {
      expect(validateFile({ name, size: 10, type: '' })).toBe('Executables and installers are not accepted');
    }
    expect(validateFile({ name: 'download', size: 10, type: 'application/x-msdownload' })).toBe('Executables and installers are not accepted');
  });

  it('classifies kinds for display (recorded voice is audio even when sniffed as video)', () => {
    expect(kindOf('voice.webm', 'video/webm', 'video')).toBe('audio');
    expect(kindOf('a.png', 'image/png')).toBe('image');
    expect(kindOf('song.mp3', '')).toBe('audio');
    expect(kindOf('report.pdf', 'application/pdf')).toBe('file');
    expect(typeLabel('report.pdf', 'application/pdf')).toBe('PDF');
    expect(typeLabel('voice.ogg', 'audio/ogg', true)).toBe('Voice');
  });
});
