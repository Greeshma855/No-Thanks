import { describe, expect, it } from 'vitest';
import { decisionSchema } from '../../src/agent/decision-schema.js';
import { mockDecision } from '../../src/providers/mock-provider.js';
import { state } from '../helpers.js';

const rejectElement = {
  id: 'guardian-element-7',
  frameIndex: 0,
  frameUrl: 'https://example.test',
  role: 'button',
  name: 'Reject All',
  label: '',
  bounds: { x: 10, y: 20, width: 100, height: 40 },
  disabled: false,
  kind: 'button' as const,
  containerId: 'guardian-container-1',
};

describe('targeting pipeline', () => {
  it('chooses from normalized DOM state independently of fixture URL', () => {
    const first = mockDecision(
      state({ url: 'https://one.test/visible-reject', elements: [rejectElement] }),
    );
    const second = mockDecision(
      state({ url: 'https://two.test/unrelated-route', elements: [rejectElement] }),
    );
    expect(first).toEqual(second);
    expect(first.action).toEqual({ type: 'CLICK_REJECT', elementId: 'guardian-element-7' });
  });
  it('does not permit provider-authored selectors or JavaScript targets', () => {
    const unsafe = {
      bannerDetected: true,
      darkPatterns: ['UNKNOWN'],
      summary: 'Unsafe selector.',
      confidence: 1,
      action: { type: 'CLICK_REJECT', elementId: 'button.reject', selector: '#reject' },
    };
    expect(decisionSchema.safeParse(unsafe).success).toBe(false);
  });
});
