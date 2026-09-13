import { describe, expect, it } from 'vitest';
import { isPageLifecycleCancellation } from '../../src/browser/browser-session.js';

describe('page lifecycle cancellation classification', () => {
  it('recognizes screenshot failures caused by navigation or closure', () => {
    expect(
      isPageLifecycleCancellation(
        new Error('page.screenshot: Target page, context or browser has been closed'),
      ),
    ).toBe(true);
    expect(
      isPageLifecycleCancellation(
        new Error('Execution context was destroyed, most likely because of a navigation'),
      ),
    ).toBe(true);
    expect(isPageLifecycleCancellation(new Error('Unable to encode screenshot'))).toBe(false);
  });
});
