import { describe, expect, it } from 'vitest';
import { decisionSchema } from '../../src/agent/decision-schema.js';

describe('decision schema', () => {
  it('accepts a safe registered action', () =>
    expect(
      decisionSchema.safeParse({
        bannerDetected: true,
        darkPatterns: ['HIDDEN_REJECTION'],
        summary: 'Open settings.',
        confidence: 0.9,
        action: { type: 'OPEN_PREFERENCES', elementId: 'guardian-element-1' },
      }).success,
    ).toBe(true));
  it('rejects selectors and consent enabling', () => {
    expect(
      decisionSchema.safeParse({
        bannerDetected: true,
        darkPatterns: ['UNKNOWN'],
        summary: 'Bad',
        confidence: 1,
        action: { type: 'SET_CONSENT_TOGGLE', elementId: '#ads', desiredState: true },
      }).success,
    ).toBe(false);
  });
  it('requires a registered container and bounded movement for modal scrolling', () => {
    expect(
      decisionSchema.safeParse({
        bannerDetected: true,
        darkPatterns: ['OBSTRUCTION'],
        summary: 'Scroll preferences.',
        confidence: 0.9,
        action: {
          type: 'SCROLL_MODAL',
          containerId: 'guardian-container-1',
          direction: 'down',
          amount: 'page',
        },
      }).success,
    ).toBe(true);
    expect(
      decisionSchema.safeParse({
        bannerDetected: true,
        darkPatterns: ['OBSTRUCTION'],
        summary: 'Bad scroll target.',
        confidence: 0.9,
        action: { type: 'SCROLL_MODAL', elementId: 'guardian-element-1' },
      }).success,
    ).toBe(false);
  });
  it('accepts only registered batch toggle IDs with a false desired state', () => {
    const base = {
      bannerDetected: true,
      darkPatterns: ['PRESELECTED_TRACKING'],
      summary: 'Disable optional categories.',
      confidence: 1,
    };
    expect(
      decisionSchema.safeParse({
        ...base,
        action: {
          type: 'SET_CONSENT_TOGGLES',
          targets: [
            { elementId: 'guardian-element-2', desiredState: false },
            { elementId: 'guardian-element-3', desiredState: false },
          ],
          saveElementId: 'guardian-element-4',
        },
      }).success,
    ).toBe(true);
    expect(
      decisionSchema.safeParse({
        ...base,
        action: {
          type: 'SET_CONSENT_TOGGLES',
          targets: [{ elementId: 'guardian-element-2', desiredState: true }],
        },
      }).success,
    ).toBe(false);
  });
});
