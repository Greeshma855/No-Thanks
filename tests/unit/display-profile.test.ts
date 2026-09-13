import { describe, expect, it } from 'vitest';
import { resolveViewport } from '../../src/config/display-profile.js';
import { loadConfig } from '../../src/config/env.js';

describe('display profiles', () => {
  it('uses laptop and recording dimensions', () => {
    expect(resolveViewport(loadConfig({ GUARDIAN_DISPLAY_PROFILE: 'laptop' }))).toEqual({
      width: 1024,
      height: 576,
    });
    expect(resolveViewport(loadConfig({ GUARDIAN_DISPLAY_PROFILE: 'recording' }))).toEqual({
      width: 1280,
      height: 720,
    });
  });
  it('uses explicit dimensions only for custom', () => {
    expect(
      resolveViewport(
        loadConfig({
          GUARDIAN_DISPLAY_PROFILE: 'custom',
          GUARDIAN_VIEWPORT_WIDTH: '1100',
          GUARDIAN_VIEWPORT_HEIGHT: '650',
        }),
      ),
    ).toEqual({ width: 1100, height: 650 });
  });
});
