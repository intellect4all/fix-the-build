import { describe, expect, it } from 'vitest';
import { normalizeHandle, profileUrl } from './handle.ts';

describe('normalizeHandle', () => {
  it.each([
    ['@Tunde_Dev', 'x', { type: 'x', handle: 'tunde_dev' }],
    ['tunde_dev', 'x', { type: 'x', handle: 'tunde_dev' }],
    ['  @segun ', 'x', { type: 'x', handle: 'segun' }],
    ['https://x.com/Aisha_UI?s=21', 'x', { type: 'x', handle: 'aisha_ui' }],
    ['twitter.com/jemeel/', 'linkedin', { type: 'x', handle: 'jemeel' }],
    ['https://mobile.twitter.com/jemeel/status/1', 'x', { type: 'x', handle: 'jemeel' }],
    ['https://www.linkedin.com/in/Jane-Doe-123/', 'x', { type: 'linkedin', handle: 'jane-doe-123' }],
    ['linkedin.com/in/jemeel?trk=qr', 'x', { type: 'linkedin', handle: 'jemeel' }],
    ['jane-doe', 'linkedin', { type: 'linkedin', handle: 'jane-doe' }],
  ] as const)('%s (%s)', (input, fb, want) => {
    expect(normalizeHandle(input, fb)).toEqual(want);
  });

  it.each([
    ['', 'x'],
    ['@', 'x'],
    ['way_too_long_for_x_handle', 'x'],
    ['has space', 'x'],
    ['https://linkedin.com/company/acme', 'x'],
    ['jane-doe', 'x'], // hyphen is not valid on X
    ['<script>', 'linkedin'],
  ] as const)('rejects %s (%s)', (input, fb) => {
    expect(normalizeHandle(input, fb)).toBeNull();
  });

  it('builds profile URLs', () => {
    expect(profileUrl({ type: 'x', handle: 'a' })).toBe('https://x.com/a');
    expect(profileUrl({ type: 'linkedin', handle: 'b' })).toBe('https://www.linkedin.com/in/b');
  });
});
