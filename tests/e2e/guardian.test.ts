import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GuardianLoop } from '../../src/agent/agent-loop.js';
import { loadConfig } from '../../src/config/env.js';
import { createFixtureServer } from '../../src/fixtures/server.js';
import { MockProvider } from '../../src/providers/mock-provider.js';
import { BrowserSession } from '../../src/browser/browser-session.js';
import { NoopDemoPacer } from '../../src/browser/demo-pacer.js';
import type { GuardianDecision } from '../../src/agent/decision-schema.js';
import type { PageState } from '../../src/domain/types.js';
import type { ModelScreenshot } from '../../src/providers/reasoning-provider.js';
import type { ReasoningProvider } from '../../src/providers/reasoning-provider.js';
import type { Tool } from '@strands-agents/sdk';
import { chromium } from 'playwright';

let server: Server;
let baseUrl: string;
let artifacts: string;
beforeAll(async () => {
  ({ server, url: baseUrl } = await createFixtureServer());
  artifacts = await mkdtemp(path.join(os.tmpdir(), 'guardian-e2e-'));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function run(name: string) {
  const config = loadConfig({
    GUARDIAN_MODE: 'guardian',
    GUARDIAN_PROVIDER: 'mock',
    GUARDIAN_ARTIFACT_DIR: artifacts,
  });
  return new GuardianLoop(config, new MockProvider()).run(`${baseUrl}/${name}`);
}

class DelayedNoBannerProvider extends MockProvider {
  calls = 0;

  override async decide(
    state: PageState,
    screenshot: ModelScreenshot | undefined,
    tools: Tool[],
  ): Promise<GuardianDecision> {
    this.calls += 1;
    if (this.calls === 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      return {
        bannerDetected: false,
        darkPatterns: ['NONE'],
        summary: 'No consent banner is visible.',
        confidence: 0.99,
        action: { type: 'NO_BANNER' },
      };
    }
    return super.decide(state, screenshot, tools);
  }
}

class DelayedValidDecisionProvider extends MockProvider {
  calls = 0;
  override async decide(
    state: PageState,
    screenshot: ModelScreenshot | undefined,
    tools: Tool[],
  ): Promise<GuardianDecision> {
    this.calls += 1;
    if (this.calls === 1) await new Promise<void>((resolve) => setTimeout(resolve, 400));
    return super.decide(state, screenshot, tools);
  }
}

class RemoteLikeStaleProvider implements ReasoningProvider {
  readonly name = 'openai' as const;
  readonly modelId = 'local-stale-response-double';
  calls = 0;
  private readonly delegate = new MockProvider();

  async decide(
    state: PageState,
    screenshot: ModelScreenshot | undefined,
    tools: Tool[],
  ): Promise<GuardianDecision> {
    this.calls += 1;
    if (this.calls === 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      return {
        bannerDetected: false,
        darkPatterns: ['NONE'],
        summary: 'No consent banner is visible.',
        confidence: 0.99,
        action: { type: 'NO_BANNER' },
      };
    }
    return this.delegate.decide(state, screenshot, tools);
  }
}

class StaleTargetProvider extends MockProvider {
  calls = 0;
  override async decide(
    state: PageState,
    screenshot: ModelScreenshot | undefined,
    tools: Tool[],
  ): Promise<GuardianDecision> {
    this.calls += 1;
    if (this.calls === 1) await new Promise<void>((resolve) => setTimeout(resolve, 700));
    return super.decide(state, screenshot, tools);
  }
}

class ForcedScrollProvider extends MockProvider {
  calls = 0;
  override async decide(state: PageState): Promise<GuardianDecision> {
    this.calls += 1;
    const container = state.containers.find(({ scrollable }) => scrollable);
    if (!container) return super.decide(state, undefined, []);
    return {
      bannerDetected: true,
      darkPatterns: ['OBSTRUCTION'],
      summary: 'Try to scroll the consent modal farther down.',
      confidence: 0.99,
      action: {
        type: 'SCROLL_MODAL',
        containerId: container.id,
        direction: 'down',
        amount: 'page',
      },
    };
  }
}

class UnsafeAcceptProvider extends MockProvider {
  override async decide(state: PageState): Promise<GuardianDecision> {
    const accept = state.elements.find((element) =>
      /accept|allow|agree/i.test(`${element.name} ${element.label}`),
    )!;
    return {
      bannerDetected: true,
      darkPatterns: ['UNKNOWN'],
      summary: 'Unsafe fallback attempt.',
      confidence: 0.99,
      action: { type: 'CLICK_REJECT', elementId: accept.id },
    };
  }
}

describe('mock No Thanks browser flow', () => {
  it('rejects a visible banner and persists after refresh', async () => {
    const report = await run('visible-reject');
    expect(report.actions.map((a) => a.action)).toEqual(['CLICK_REJECT']);
    expect(report.verification.level).toBe('VERIFIED');
  });
  it('navigates nested preferences', async () => {
    const report = await run('nested-settings');
    expect(report.actions.map((a) => a.action)).toEqual(['OPEN_PREFERENCES', 'SAVE_PREFERENCES']);
    expect(report.verification.level).toBe('VERIFIED');
  });
  it('disables every preselected non-essential toggle', async () => {
    const report = await run('preselected-toggles');
    const batch = report.actions.find((action) => action.action === 'SET_CONSENT_TOGGLES');
    expect(batch?.targets).toHaveLength(2);
    expect(batch?.confirmedToggleIds).toHaveLength(2);
    expect(batch?.saveElementId).toMatch(/^guardian-element-\d+$/);
    expect(report.verification.level).toBe('VERIFIED');
  });
  it('stops safely on ambiguity without clicking', async () => {
    const report = await run('ambiguous-banner');
    expect(report.actions).toHaveLength(0);
    expect(report.safetyStops).toHaveLength(1);
    expect(report.verification.level).not.toBe('VERIFIED');
  });

  it('discovers a banner appearing one second after navigation and captures a fresh final state', async () => {
    const report = await run('delayed-banner');
    expect(report.actions.map(({ action }) => action)).toEqual(['CLICK_REJECT']);
    expect(report.finalBannerDetected).toBe(false);
    const audit = JSON.parse(
      await readFile(path.join(report.artifactDirectory, 'audit.json'), 'utf8'),
    ) as {
      initialState: PageState;
      finalState: PageState;
      steps: Array<{
        step: number;
        telemetry?: {
          discoveryInitialPerceptionAt?: string;
          perceptionCapturedAt?: string;
          modelStartedAt?: string;
          modelCompletedAt?: string;
          postDecisionPerceptionAt?: string;
          consentCandidateDetectedAt?: string;
          frameCount?: number;
          screenshotHash?: string;
          screenshotDimensions?: { width: number; height: number };
          imageAttachedToOpenAIRequest?: boolean;
        };
      }>;
    };
    expect(audit.steps[0]?.telemetry?.consentCandidateDetectedAt).toBeTruthy();
    expect(
      Date.parse(audit.steps[0]!.telemetry!.consentCandidateDetectedAt!) -
        Date.parse(audit.steps[0]!.telemetry!.discoveryInitialPerceptionAt!),
    ).toBeGreaterThanOrEqual(700);
    const reasoningTelemetry = audit.steps.find(({ step }) => step === 1)?.telemetry;
    expect(reasoningTelemetry).toMatchObject({
      perceptionCapturedAt: expect.any(String),
      modelStartedAt: expect.any(String),
      modelCompletedAt: expect.any(String),
      postDecisionPerceptionAt: expect.any(String),
      frameCount: 1,
      screenshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      screenshotDimensions: report.viewport,
      imageAttachedToOpenAIRequest: false,
    });
    expect(Date.parse(audit.finalState.capturedAt)).toBeGreaterThan(
      Date.parse(audit.initialState.capturedAt),
    );
    expect(report.finalStateCapturedAt).toBe(audit.finalState.capturedAt);
  });

  it('registers and rejects controls in a cross-origin CMP iframe attached after navigation', async () => {
    const remote = await createFixtureServer();
    try {
      const report = await run(
        `iframe-host?src=${encodeURIComponent(`${remote.url}/iframe-consent`)}&delay=500`,
      );
      expect(report.actions.map(({ action }) => action)).toEqual(['CLICK_REJECT']);
      const audit = JSON.parse(
        await readFile(path.join(report.artifactDirectory, 'audit.json'), 'utf8'),
      ) as { initialState: PageState };
      expect(audit.initialState.frames.length).toBeGreaterThanOrEqual(2);
      expect(
        audit.initialState.elements.some(
          ({ name, frameIndex }) => /reject/i.test(name) && frameIndex > 0,
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => remote.server.close(() => resolve()));
    }
  });

  it('registers and clicks a no-thanks control in a sibling iframe action bar', async () => {
    const remote = await createFixtureServer();
    try {
      const report = await run(
        `iframe-host?src=${encodeURIComponent(`${remote.url}/iframe-consent-sibling`)}&delay=500`,
      );
      expect(report.actions.map(({ action }) => action)).toEqual(['CLICK_REJECT']);
      const audit = JSON.parse(
        await readFile(path.join(report.artifactDirectory, 'audit.json'), 'utf8'),
      ) as { initialState: PageState; report: { darkPatterns: string[] } };
      const noThanks = audit.initialState.elements.find(({ name }) => /no, thank you/i.test(name));
      expect(noThanks?.frameIndex).toBeGreaterThan(0);
      expect(audit.report.darkPatterns).not.toContain('HIDDEN_REJECTION');
    } finally {
      await new Promise<void>((resolve) => remote.server.close(() => resolve()));
    }
  });

  it('discovers a fixed sibling action bar, prefers No thanks, and blocks Accept', async () => {
    const report = await run('sticky-action-bar');
    expect(report.actions.map(({ action }) => action)).toEqual(['CLICK_REJECT']);
    expect(report.darkPatterns).not.toContain('HIDDEN_REJECTION');

    const config = loadConfig({
      GUARDIAN_MODE: 'guardian',
      GUARDIAN_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifacts,
    });
    const blocked = await new GuardianLoop(config, new UnsafeAcceptProvider()).run(
      `${baseUrl}/sticky-action-bar`,
    );
    expect(blocked.actions).toHaveLength(0);
    expect(blocked.safetyStops.join(' ')).toMatch(/expand consent|safe scope/i);
  });

  it('scrolls the registered modal, disables named optional switches, and confirms choices', async () => {
    const report = await run('scrolling-preferences');
    expect(report.actions[0]?.action).toBe('OPEN_PREFERENCES');
    const batch = report.actions.find(({ action }) => action === 'SET_CONSENT_TOGGLES');
    expect(batch?.targets).toHaveLength(2);
    expect(batch?.confirmedToggleIds).toHaveLength(2);
    expect(batch?.saveElementId).toMatch(/^guardian-element-\d+$/);
    const scrolls = report.actions.filter(({ action }) => action === 'SCROLL_MODAL');
    expect(scrolls).toHaveLength(0);
    const audit = JSON.parse(
      await readFile(path.join(report.artifactDirectory, 'audit.json'), 'utf8'),
    ) as { steps: Array<{ perception?: PageState }> };
    const names = audit.steps.flatMap(({ perception }) =>
      (perception?.elements ?? []).map(({ name, label }) => `${name} ${label}`),
    );
    expect(names.some((name) => /analytics cookies/i.test(name))).toBe(true);
    expect(names.some((name) => /advertising cookies/i.test(name))).toBe(true);
    expect(report.verification.level).toBe('VERIFIED');
  });

  it('records an unchanged end-of-modal scroll as failed and makes no retrying model call', async () => {
    const provider = new ForcedScrollProvider();
    const config = loadConfig({
      GUARDIAN_MODE: 'guardian',
      GUARDIAN_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifacts,
    });
    const report = await new GuardianLoop(config, provider).run(
      `${baseUrl}/scrolling-preferences?open=1`,
    );
    expect(provider.calls).toBe(1);
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]).toMatchObject({ action: 'SCROLL_MODAL', success: false });
    expect(report.actions[0]?.detail).toMatch(/NO_OP_SCROLL/);
  });

  it('registers label-backed hidden switches, batches four optional categories, and excludes background controls', async () => {
    const report = await run('custom-toggle-proxies');
    expect(report.actions.map(({ action }) => action)).toEqual([
      'OPEN_PREFERENCES',
      'SET_CONSENT_TOGGLES',
    ]);
    const batch = report.actions[1]!;
    expect(batch.targets).toHaveLength(4);
    expect(batch.confirmedToggleIds).toHaveLength(4);
    expect(batch.saveElementId).toMatch(/^guardian-element-\d+$/);
    expect(report.verification.level).toBe('VERIFIED');
    const audit = JSON.parse(
      await readFile(path.join(report.artifactDirectory, 'audit.json'), 'utf8'),
    ) as { steps: Array<{ perception?: PageState }> };
    const preferenceState = audit.steps
      .map(({ perception }) => perception)
      .find((state) => state?.elements.some(({ name }) => /performance cookies/i.test(name)));
    const toggles = preferenceState!.elements.filter(({ kind }) =>
      ['checkbox', 'switch'].includes(kind),
    );
    expect(toggles).toHaveLength(5);
    expect(toggles.every(({ name, categoryLabel }) => Boolean(name || categoryLabel))).toBe(true);
    expect(preferenceState!.elements.map(({ name }) => name)).not.toContain('Subscribe');
    expect(preferenceState!.elements.map(({ name }) => name)).not.toContain('Open video');
  });

  it('keeps consent control IDs stable across repeated perceptions', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1024, height: 576 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/custom-toggle-proxies`, { waitUntil: 'domcontentloaded' });
    const session = new BrowserSession({
      mode: 'guardian',
      viewport: { width: 1024, height: 576 },
      slowMoMs: 0,
      artifactDirectory: artifacts,
      recordVideo: false,
      recordTrace: false,
      attachedPage: page,
      allowCrossOriginNavigation: true,
    });
    await session.start();
    const initial = await session.inspect();
    const opener = initial.elements.find(({ name }) => /cookie preferences/i.test(name))!;
    await session.clickRegistered(opener.id);
    const first = await session.inspect();
    const second = await session.inspect();
    const ids = (state: PageState) =>
      Object.fromEntries(
        state.elements
          .filter(({ kind }) => ['checkbox', 'switch'].includes(kind))
          .map(({ name, id }) => [name, id]),
      );
    expect(ids(first)).toEqual(ids(second));
    await session.close();
    await context.close();
    await browser.close();
  });

  it('normalizes button aria-pressed controls as stateful consent toggles', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1024, height: 576 } });
    const page = await context.newPage();
    await page.setContent(
      '<section role="dialog" aria-modal="true" aria-label="Cookie preferences"><h2>Cookie preferences</h2><button aria-pressed="true" aria-label="Marketing cookies">On</button><button>Confirm choices</button></section>',
    );
    const session = new BrowserSession({
      mode: 'guardian',
      viewport: { width: 1024, height: 576 },
      slowMoMs: 0,
      artifactDirectory: artifacts,
      recordVideo: false,
      recordTrace: false,
      attachedPage: page,
      allowCrossOriginNavigation: true,
    });
    await session.start();
    const toggle = (await session.inspect()).elements.find(({ name }) =>
      /marketing cookies/i.test(name),
    );
    expect(toggle).toMatchObject({ kind: 'switch', role: 'switch', checked: true });
    await session.close();
    await context.close();
    await browser.close();
  });

  it('discards a NO_BANNER response when consent state changes during model latency', async () => {
    const provider = new DelayedNoBannerProvider();
    const config = loadConfig({
      GUARDIAN_MODE: 'guardian',
      GUARDIAN_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifacts,
      CONSENT_DISCOVERY_MAX_MS: '0',
      CONSENT_DISCOVERY_POLL_MS: '25',
    });
    const report = await new GuardianLoop(config, provider).run(
      `${baseUrl}/delayed-banner?delay=100`,
    );
    expect(provider.calls).toBeGreaterThanOrEqual(2);
    const audit = JSON.parse(
      await readFile(path.join(report.artifactDirectory, 'audit.json'), 'utf8'),
    ) as {
      warnings: string[];
      steps: Array<{ telemetry?: { staleDecisionDiscarded?: boolean } }>;
    };
    expect(audit.warnings.some((reason) => reason.startsWith('STALE_DECISION'))).toBe(true);
    expect(audit.steps.some(({ telemetry }) => telemetry?.staleDecisionDiscarded)).toBe(true);
    expect(report.actions.map(({ action }) => action)).toEqual(['CLICK_REJECT']);
    expect(report.finalBannerDetected).toBe(false);
  });

  it('keeps a valid consent decision when an unrelated advertising frame attaches', async () => {
    const provider = new DelayedValidDecisionProvider();
    const config = loadConfig({
      GUARDIAN_MODE: 'guardian',
      GUARDIAN_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifacts,
    });
    const report = await new GuardianLoop(config, provider).run(`${baseUrl}/dynamic-ad-reject`);
    expect(report.actions.map(({ action }) => action)).toEqual(['CLICK_REJECT']);
    expect(report.verification.level).toBe('VERIFIED');
    const audit = JSON.parse(
      await readFile(path.join(report.artifactDirectory, 'audit.json'), 'utf8'),
    ) as { warnings: string[] };
    expect(audit.warnings).not.toContain(
      'STALE_DECISION: consent state changed while reasoning; model response abandoned',
    );
  });

  it('does not charge a discarded stale response against the useful remote action budget', async () => {
    const provider = new RemoteLikeStaleProvider();
    const config = loadConfig({
      GUARDIAN_MODE: 'guardian',
      MODEL_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-only-placeholder',
      REMOTE_ANALYSIS_ALLOWED_HOSTS: '*',
      MAX_MODEL_CALLS_PER_AUDIT: '1',
      GUARDIAN_ARTIFACT_DIR: artifacts,
      CONSENT_DISCOVERY_MAX_MS: '0',
      CONSENT_DISCOVERY_POLL_MS: '25',
    });
    const report = await new GuardianLoop(config, provider).run(
      `${baseUrl}/delayed-banner?delay=100`,
    );
    expect(provider.calls).toBe(2);
    expect(report.actions.map(({ action }) => action)).toEqual(['CLICK_REJECT']);
    expect(report.verification.level).toBe('LIKELY_VERIFIED');
  });

  it('discards a genuinely stale consent target without clicking its replacement', async () => {
    const provider = new StaleTargetProvider();
    const config = loadConfig({
      GUARDIAN_MODE: 'guardian',
      GUARDIAN_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifacts,
    });
    const report = await new GuardianLoop(config, provider).run(`${baseUrl}/stale-consent-target`);
    expect(report.actions).toHaveLength(0);
    expect(report.safetyStops.join(' ')).toMatch(/confidence|no unambiguous action/i);
    const audit = JSON.parse(
      await readFile(path.join(report.artifactDirectory, 'audit.json'), 'utf8'),
    ) as { warnings: string[] };
    expect(audit.warnings.some((warning) => warning.startsWith('STALE_DECISION'))).toBe(true);
  });

  it('finishes without retries when no banner exists and reports verification as not applicable', async () => {
    const provider = new DelayedNoBannerProvider();
    provider.calls = 1;
    const config = loadConfig({
      GUARDIAN_MODE: 'guardian',
      GUARDIAN_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifacts,
      CONSENT_DISCOVERY_MAX_MS: '300',
      CONSENT_DISCOVERY_POLL_MS: '50',
    });
    const report = await new GuardianLoop(config, provider).run(`${baseUrl}/no-banner`);
    expect(provider.calls).toBe(2);
    expect(report.actions).toHaveLength(0);
    expect(report.verification.level).toBe('NOT_APPLICABLE');
    expect(report.verification.evidence.bannerGone).toBe(false);
    expect(report.verification.evidence.details).toContain(
      'No banner observed during the complete discovery window.',
    );
  });

  it('keeps one Inspector browser/context/page and one viewport through a multi-step flow', async () => {
    const config = loadConfig({
      GUARDIAN_MODE: 'inspector',
      GUARDIAN_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifacts,
      GUARDIAN_DISPLAY_PROFILE: 'custom',
      GUARDIAN_VIEWPORT_WIDTH: '1440',
      GUARDIAN_VIEWPORT_HEIGHT: '900',
    });
    const session = new BrowserSession({
      mode: 'inspector',
      viewport: { width: 1440, height: 900 },
      slowMoMs: 0,
      artifactDirectory: artifacts,
      recordVideo: false,
      recordTrace: false,
      headlessOverride: true,
    });
    const report = await new GuardianLoop(config, new MockProvider(), {
      session,
      pacer: new NoopDemoPacer(),
    }).run(`${baseUrl}/nested-settings`);
    const diagnostics = session.diagnostics();
    expect(report.actions).toHaveLength(2);
    expect(diagnostics.browserLaunches).toBe(1);
    expect(diagnostics.contextCreations).toBe(1);
    expect(diagnostics.pageCreations).toBe(1);
    expect(diagnostics.viewportSamples.length).toBeGreaterThanOrEqual(3);
    expect(
      new Set(diagnostics.viewportSamples.map(({ width, height }) => `${width}x${height}`)),
    ).toEqual(new Set(['1440x900']));
  });

  it('finalizes optional headless video and trace artifacts', async () => {
    const config = loadConfig({
      GUARDIAN_MODE: 'guardian',
      GUARDIAN_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifacts,
      GUARDIAN_RECORD_VIDEO: 'true',
      GUARDIAN_RECORD_TRACE: 'true',
    });
    const report = await new GuardianLoop(config, new MockProvider()).run(
      `${baseUrl}/visible-reject`,
    );
    expect(
      (await stat(path.join(report.artifactDirectory, 'raw', 'trace.zip'))).size,
    ).toBeGreaterThan(0);
    expect(
      (await stat(path.join(report.artifactDirectory, 'raw', 'video.webm'))).size,
    ).toBeGreaterThan(0);
  });

  it('writes one canonical audit and a self-contained chronological HTML report', async () => {
    const report = await run('nested-settings');
    const entries = await readdir(report.artifactDirectory);
    expect(entries.sort()).toEqual(['audit.json', 'raw', 'report.html']);
    const audit = JSON.parse(
      await readFile(path.join(report.artifactDirectory, 'audit.json'), 'utf8'),
    ) as {
      steps: Array<{
        decision?: unknown;
        action?: unknown;
        safetyValidation?: unknown;
        screenshotBefore?: string;
        screenshotAfter?: string;
      }>;
      report: { verification: { level: string } };
    };
    const decisionSteps = audit.steps.filter(({ decision }) => decision);
    expect(decisionSteps).toHaveLength(3);
    expect(
      decisionSteps.every(
        ({ safetyValidation, screenshotBefore, screenshotAfter }) =>
          safetyValidation && screenshotBefore && screenshotAfter,
      ),
    ).toBe(true);
    expect(audit.steps.filter(({ action }) => action)).toHaveLength(2);
    expect(audit.report.verification.level).toBe('VERIFIED');
    const html = await readFile(path.join(report.artifactDirectory, 'report.html'), 'utf8');
    expect(html).toContain('NO, THANKS.');
    expect(html).not.toContain('Dark-Pattern Guardian');
    expect(html).toContain('Chronological run report');
    expect(html).toContain('Step 1');
    expect(html).toContain('Step 2');
    expect(html).toContain('OPEN_PREFERENCES');
    expect(html).toContain('SAVE_PREFERENCES');
    expect(html).toMatch(/src="data:image\/png;base64,/);
  });
});
