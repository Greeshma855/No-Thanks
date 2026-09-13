import { describe, expect, it } from 'vitest';
import { BrowserAuditRuntime } from '../../src/browser/audit-runtime.js';

describe('interactive browser audit runtime', () => {
  it('registers unique tabs and keeps their state isolated', async () => {
    const runtime = new BrowserAuditRuntime('session-1', 2, 0);
    const first = runtime.registerTab();
    const second = runtime.registerTab();
    expect(first).not.toBe(second);
    await Promise.all([
      runtime.schedule(first, 'https://one.test', async () => undefined),
      runtime.schedule(second, 'https://two.test', async () => undefined),
    ]);
    expect(runtime.snapshot(first).auditRunIds).toHaveLength(1);
    expect(runtime.snapshot(second).auditRunIds).toHaveLength(1);
    expect(runtime.snapshot(first).auditRunIds[0]).not.toBe(
      runtime.snapshot(second).auditRunIds[0],
    );
  });

  it('debounces redirects and creates new runs for later same-tab navigation', async () => {
    const runtime = new BrowserAuditRuntime('session-1', 1, 5);
    const tab = runtime.registerTab();
    const seen: string[] = [];
    const redirected = runtime.schedule(tab, 'https://example.test/redirect', async ({ url }) => {
      seen.push(url);
    });
    const stable = runtime.schedule(tab, 'https://example.test/final', async ({ url }) => {
      seen.push(url);
    });
    await Promise.all([redirected, stable]);
    await runtime.schedule(tab, 'https://example.test/next', async ({ url }) => seen.push(url));
    expect(seen).toEqual(['https://example.test/final', 'https://example.test/next']);
    expect(runtime.snapshot(tab).auditRunIds).toHaveLength(2);
  });

  it('limits cross-tab concurrency globally', async () => {
    const runtime = new BrowserAuditRuntime('session-1', 1, 0);
    const tabs = [runtime.registerTab(), runtime.registerTab()];
    let active = 0;
    let maximum = 0;
    const handler = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    };
    await Promise.all(tabs.map((tab) => runtime.schedule(tab, `https://${tab}.test`, handler)));
    expect(maximum).toBe(1);
  });

  it('marks an in-flight run stale on navigation and shuts down gracefully', async () => {
    const runtime = new BrowserAuditRuntime('session-1', 1, 0);
    const tab = runtime.registerTab();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstCurrent = true;
    let firstAborted = false;
    const first = runtime.schedule(tab, 'https://example.test/one', async (audit) => {
      await gate;
      firstCurrent = audit.isCurrent();
      firstAborted = audit.signal.aborted;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = runtime.schedule(tab, 'https://example.test/two', async () => undefined);
    runtime.shutdown();
    release();
    await Promise.all([first, second]);
    expect(firstCurrent).toBe(false);
    expect(firstAborted).toBe(true);
    expect(runtime.snapshot(tab).closed).toBe(true);
  });
});
