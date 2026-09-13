import { describe, expect, it } from 'vitest';
import { calculateVerificationLevel } from '../../src/verification/consent-verifier.js';
import { state } from '../helpers.js';

describe('verification tiers', () => {
  it('requires persisted evidence for VERIFIED', () => {
    const before = state();
    const after = state({
      bannerDetected: false,
      containers: [],
      elements: [],
      fixtureState: 'rejected',
    });
    expect(calculateVerificationLevel(before, after).level).toBe('LIKELY_VERIFIED');
    expect(calculateVerificationLevel(before, after, true).level).toBe('VERIFIED');
  });
  it('does not claim rejection from disappearance alone', () =>
    expect(
      calculateVerificationLevel(state(), state({ bannerDetected: false, containers: [] })).level,
    ).toBe('UNVERIFIED'));
  it('reports a successful explicit rejection with a disappeared banner as likely verified', () => {
    const result = calculateVerificationLevel(
      state(),
      state({ bannerDetected: false, containers: [], elements: [] }),
      {
        actions: [
          {
            step: 1,
            action: 'CLICK_REJECT',
            elementId: 'guardian-element-1',
            success: true,
            detail: 'clicked',
          },
        ],
      },
    );
    expect(result.level).toBe('LIKELY_VERIFIED');
    expect(result.evidence).toMatchObject({
      explicitRejectActionSucceeded: true,
      bannerGone: true,
      persistedAfterRefresh: false,
    });
  });
  it('returns not applicable with no initial banner', () =>
    expect(
      calculateVerificationLevel(
        state({ bannerDetected: false, containers: [] }),
        state({ bannerDetected: false, containers: [] }),
      ).level,
    ).toBe('NOT_APPLICABLE'));
});
