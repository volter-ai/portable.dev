/**
 * mediaSource — authed relay resolution for screenshot/video blocks + the
 * getToolResultText media-leak guard.
 *
 * Screenshots/videos arrive from the PC as RELATIVE paths (`/data/media/...` public,
 * `/api/video|uploads/...` behind the PC JWT) that RN's `<Image>`/expo-video cannot load
 * directly — `resolveAuthedMediaSource` must turn them into the ABSOLUTE relay URL
 * (`<gatewayBase>/t/<pcId>/...`) with a `Bearer` header for `/api/*` only. Inline
 * `data:`/`http(s)` pass through. And `getToolResultText` must NEVER stringify a base64
 * image item into a tool block (the bug the user saw).
 *
 * Imports the SOURCE FILES directly (not the chat barrel) so no theme/mmkv/expo graph is
 * pulled — only the two lazily-required relay/token modules, mocked here.
 */

jest.mock('../src/features/api/baseUrls', () => ({
  getRelayUrl: jest.fn(async () => 'https://gw.test/t/pc-1'),
}));
jest.mock('../src/features/pc-connect/dataPathToken', () => ({
  resolveDataPathToken: jest.fn(async () => 'jwt-abc'),
}));

import { getToolResultText } from '../src/features/chat/blocks/blockHelpers';
import { isInlineUri, resolveAuthedMediaSource } from '../src/features/chat/blocks/mediaSource';

describe('resolveAuthedMediaSource', () => {
  it('passes a data: URI (base64 screenshot) through unchanged — no relay, no header', async () => {
    expect(await resolveAuthedMediaSource('data:image/png;base64,AAAB')).toEqual({
      uri: 'data:image/png;base64,AAAB',
    });
  });

  it('passes an absolute http(s) URL through unchanged', async () => {
    expect(await resolveAuthedMediaSource('https://cdn.test/x.png')).toEqual({
      uri: 'https://cdn.test/x.png',
    });
  });

  it('resolves a /data/media screenshot URL to the absolute relay base WITHOUT a header (public route)', async () => {
    const s = await resolveAuthedMediaSource('/data/media/u/screenshot-1.webp');
    expect(s.uri).toBe('https://gw.test/t/pc-1/data/media/u/screenshot-1.webp');
    expect(s.headers).toBeUndefined();
  });

  it('resolves an /api/video URL to the absolute relay base WITH a Bearer header', async () => {
    const s = await resolveAuthedMediaSource('/api/video/o/r/clip.webm');
    expect(s.uri).toBe('https://gw.test/t/pc-1/api/video/o/r/clip.webm');
    expect(s.headers).toEqual({ Authorization: 'Bearer jwt-abc' });
  });
});

describe('isInlineUri', () => {
  it('is true for data: and http(s), false for relative PC paths', () => {
    expect(isInlineUri('data:image/png;base64,AA')).toBe(true);
    expect(isInlineUri('https://x/y')).toBe(true);
    expect(isInlineUri('http://x/y')).toBe(true);
    expect(isInlineUri('/data/media/x.webp')).toBe(false);
    expect(isInlineUri('/api/video/x.webm')).toBe(false);
  });
});

describe('getToolResultText never leaks media as text', () => {
  it('drops a lone base64 image content array (no base64 / JSON dump)', () => {
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BIGBASE64' } },
    ];
    expect(getToolResultText(content)).toBe('');
  });

  it('keeps real text but skips media in a mixed array', () => {
    const content = [
      { type: 'text', text: 'page state' },
      { type: 'image', source: { type: 'base64', data: 'XXXX' } },
    ];
    expect(getToolResultText(content)).toBe('page state');
  });

  it('drops a lone media object instead of JSON.stringify-ing it', () => {
    expect(getToolResultText({ type: 'image', source: { url: '/data/media/x.webp' } })).toBe('');
  });

  it('still stringifies a genuinely-unknown non-media object', () => {
    expect(getToolResultText({ foo: 'bar' })).toContain('foo');
  });
});
