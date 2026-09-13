import { describe, expect, it, vi } from 'vitest';
import { createDemoPacer } from '../../src/browser/demo-pacer.js';
import { loadConfig } from '../../src/config/env.js';

describe('demo pacing', () => {
  it('is a no-op in Guardian mode even when demo variables are populated', async () => {
    const sleep = vi.fn(async () => undefined);
    const pacer = createDemoPacer(
      loadConfig({
        GUARDIAN_MODE: 'guardian',
        GUARDIAN_DEMO_PACING: 'true',
        GUARDIAN_HIGHLIGHT_DELAY_MS: '800',
        GUARDIAN_STEP_DELAY_MS: '1200',
        GUARDIAN_FINAL_HOLD_MS: '2500',
      }),
      sleep,
    );
    await pacer.beforeAction();
    await pacer.afterAction();
    await pacer.afterVerification();
    await pacer.holdFinalState();
    expect(pacer.enabled).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('centralizes Inspector demonstration delays', async () => {
    const delays: number[] = [];
    const pacer = createDemoPacer(
      loadConfig({
        GUARDIAN_MODE: 'inspector',
        GUARDIAN_DEMO_PACING: 'true',
        GUARDIAN_HIGHLIGHT_DELAY_MS: '800',
        GUARDIAN_STEP_DELAY_MS: '1200',
        GUARDIAN_FINAL_HOLD_MS: '2500',
      }),
      async (milliseconds) => {
        delays.push(milliseconds);
      },
    );
    await pacer.beforeAction();
    await pacer.afterAction();
    await pacer.afterVerification();
    await pacer.holdFinalState();
    expect(pacer.enabled).toBe(true);
    expect(delays).toEqual([800, 1200, 2500]);
  });
});
