import type { PageState } from '../src/domain/types.js';

export function state(overrides: Partial<PageState> = {}): PageState {
  return {
    url: 'https://example.test',
    title: 'Test',
    capturedAt: new Date(0).toISOString(),
    bannerDetected: true,
    frames: [{ index: 0, url: 'https://example.test', name: '', accessible: true }],
    containers: [
      {
        id: 'guardian-container-1',
        frameIndex: 0,
        frameUrl: 'https://example.test',
        role: 'dialog',
        text: 'Cookie choices',
        bounds: { x: 0, y: 0, width: 400, height: 200 },
        scrollTop: 0,
        scrollHeight: 200,
        clientHeight: 200,
        scrollable: false,
      },
    ],
    elements: [],
    sanitizedText: 'Cookie choices',
    ...overrides,
  };
}
