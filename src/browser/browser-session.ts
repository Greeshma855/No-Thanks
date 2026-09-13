import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import type { PageState } from '../domain/types.js';
import { ElementRegistry } from './element-registry.js';
import { updateInspectorOverlay, type InspectorView } from './inspector-overlay.js';
import {
  consentStateFingerprint,
  detectConsentCandidate,
  perceivePage,
  sanitizeUrl,
} from './perception.js';

export interface BrowserSessionOptions {
  mode: 'inspector' | 'guardian';
  viewport: { width: number; height: number };
  slowMoMs: number;
  artifactDirectory: string;
  recordVideo: boolean;
  recordTrace: boolean;
  headlessOverride?: boolean;
  attachedPage?: Page;
  allowCrossOriginNavigation?: boolean;
  isRunCurrent?: () => boolean;
}

export interface BrowserSessionDiagnostics {
  browserLaunches: number;
  contextCreations: number;
  pageCreations: number;
  viewportSamples: Array<{ width: number; height: number }>;
  displayMetrics?: RuntimeDisplayMetrics;
  videoPath?: string;
  tracePath?: string;
}

export interface RuntimeDisplayMetrics {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenWidth: number;
  screenHeight: number;
  screenAvailWidth: number;
  screenAvailHeight: number;
  devicePixelRatio: number;
  configuredViewport: { width: number; height: number };
}

export interface ConsentDiscoveryResult {
  state: PageState;
  initialPerceptionCapturedAt: string;
  consentCandidateDetectedAt?: string;
}

export interface ScrollResult {
  success: true;
  containerId: string;
  direction: 'up' | 'down';
  amount: 'small' | 'page';
  beforeScrollTop: number;
  afterScrollTop: number;
  visibleControlsChanged: boolean;
  consentStateChanged: boolean;
}

export interface BatchToggleResult {
  success: true;
  confirmedToggleIds: string[];
  skippedToggleIds: string[];
  saveElementId?: string;
}

const screenshotTimeoutMs = 5_000;

export class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private currentPage: Page | undefined;
  private initialOrigin: string | undefined;
  private tracingStarted = false;
  private readonly stats: BrowserSessionDiagnostics = {
    browserLaunches: 0,
    contextCreations: 0,
    pageCreations: 0,
    viewportSamples: [],
  };
  readonly registry = new ElementRegistry();

  constructor(private readonly options: BrowserSessionOptions) {}

  get page(): Page {
    if (!this.currentPage) throw new Error('Browser session is not initialized');
    return this.currentPage;
  }

  get viewport(): { width: number; height: number } {
    return { ...this.options.viewport };
  }

  diagnostics(): BrowserSessionDiagnostics {
    return {
      ...this.stats,
      viewportSamples: this.stats.viewportSamples.map((sample) => ({ ...sample })),
    };
  }

  async start(): Promise<void> {
    if (this.browser || this.context || this.currentPage)
      throw new Error('Browser session may only be started once');
    if (this.options.attachedPage) {
      this.currentPage = this.options.attachedPage;
      this.initialOrigin = safeOrigin(this.currentPage.url());
      return;
    }
    const headless = this.options.headlessOverride ?? headlessForMode(this.options.mode);
    this.browser = await chromium.launch({ headless, slowMo: this.options.slowMoMs });
    this.stats.browserLaunches += 1;
    this.context = await this.browser.newContext({
      viewport: this.options.viewport,
      deviceScaleFactor: 1,
      ...(this.options.recordVideo
        ? {
            recordVideo: {
              dir: path.join(this.options.artifactDirectory, 'raw'),
              size: this.options.viewport,
            },
          }
        : {}),
    });
    this.stats.contextCreations += 1;
    if (this.options.recordTrace) {
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      this.tracingStarted = true;
    }
    this.currentPage = await this.context.newPage();
    this.stats.pageCreations += 1;
    if (this.options.mode === 'inspector') {
      const measured = await this.page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        screenAvailWidth: window.screen.availWidth,
        screenAvailHeight: window.screen.availHeight,
        devicePixelRatio: window.devicePixelRatio,
      }));
      this.stats.displayMetrics = {
        ...measured,
        configuredViewport: { ...this.options.viewport },
      };
      console.log(
        [
          '[Inspector] display measurements',
          `  window.innerWidth: ${measured.innerWidth}`,
          `  window.innerHeight: ${measured.innerHeight}`,
          `  window.outerWidth: ${measured.outerWidth}`,
          `  window.outerHeight: ${measured.outerHeight}`,
          `  screen.width: ${measured.screenWidth}`,
          `  screen.height: ${measured.screenHeight}`,
          `  screen.availWidth: ${measured.screenAvailWidth}`,
          `  screen.availHeight: ${measured.screenAvailHeight}`,
          `  window.devicePixelRatio: ${measured.devicePixelRatio}`,
          `  Configured Playwright viewport: ${this.options.viewport.width}×${this.options.viewport.height}`,
        ].join('\n'),
      );
    }
  }

  async navigate(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Only http and https URLs are allowed');
    this.ensureCurrent();
    this.initialOrigin = url.origin;
    await this.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.page.waitForLoadState('load');
    await this.page.route('**/*', async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === this.page.mainFrame() &&
        new URL(request.url()).origin !== this.initialOrigin
      ) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
  }

  async inspect(): Promise<PageState> {
    if (
      !this.options.allowCrossOriginNavigation &&
      new URL(this.page.url()).origin !== this.initialOrigin
    )
      throw new Error('Cross-origin navigation was blocked');
    const viewport = this.page.viewportSize();
    if (!viewport) throw new Error('The browser context unexpectedly has no fixed viewport');
    if (
      viewport.width !== this.options.viewport.width ||
      viewport.height !== this.options.viewport.height
    ) {
      throw new Error(
        `Viewport changed during the run: expected ${this.options.viewport.width}×${this.options.viewport.height}, received ${viewport.width}×${viewport.height}`,
      );
    }
    this.stats.viewportSamples.push({ ...viewport });
    const state = await perceivePage(this.page);
    this.registry.replace(state);
    return state;
  }

  async discoverConsent(
    maximumDurationMs = 10_000,
    pollIntervalMs = 250,
    isCurrent?: () => boolean,
  ): Promise<ConsentDiscoveryResult> {
    const started = Date.now();
    const initialState = await this.inspect();
    if (initialState.bannerDetected)
      return {
        state: initialState,
        initialPerceptionCapturedAt: initialState.capturedAt,
        consentCandidateDetectedAt: initialState.capturedAt,
      };
    while (Date.now() - started < maximumDurationMs) {
      if (isCurrent && !isCurrent()) throw new Error('STALE_AUDIT: navigation changed');
      if (await detectConsentCandidate(this.page)) {
        const consentCandidateDetectedAt = new Date().toISOString();
        return {
          state: await this.inspect(),
          initialPerceptionCapturedAt: initialState.capturedAt,
          consentCandidateDetectedAt,
        };
      }
      const remaining = maximumDurationMs - (Date.now() - started);
      if (remaining <= 0) break;
      await delay(Math.min(pollIntervalMs, remaining));
    }
    if (isCurrent && !isCurrent()) throw new Error('STALE_AUDIT: navigation changed');
    return {
      state: maximumDurationMs === 0 ? initialState : await this.inspect(),
      initialPerceptionCapturedAt: initialState.capturedAt,
    };
  }

  async present(state: PageState, view: InspectorView): Promise<void> {
    if (this.options.mode === 'inspector') await updateInspectorOverlay(this.page, state, view);
  }

  async screenshot(filePath: string): Promise<Buffer> {
    return this.page.screenshot({ path: filePath, type: 'png', timeout: screenshotTimeoutMs });
  }

  async screenshotForModel(maxWidth: number, quality: number): Promise<Buffer> {
    const sensitiveSelector = [
      'input[type="password" i]',
      'input[type="email" i]',
      'input[type="tel" i]',
      'input[autocomplete="current-password" i]',
      'input[autocomplete="new-password" i]',
      'input[autocomplete="one-time-code" i]',
      'input[autocomplete="email" i]',
      'input[autocomplete="tel" i]',
      '[data-private]',
      '[data-sensitive]',
      '[aria-private="true" i]',
    ].join(',');
    const sensitive = this.page.frames().map((frame) => frame.locator(sensitiveSelector));
    const jpeg = await this.page.screenshot({
      type: 'jpeg',
      quality,
      mask: sensitive,
      maskColor: '#6b7280',
      timeout: screenshotTimeoutMs,
    });
    const viewport = this.page.viewportSize();
    if (!viewport || viewport.width <= maxWidth) return jpeg;
    const output = await this.page.evaluate(
      async ({ base64, width, quality }) => {
        const source = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([source], { type: 'image/jpeg' }));
        const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Unable to create screenshot resize context');
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      },
      { base64: jpeg.toString('base64'), width: maxWidth, quality },
    );
    return Buffer.from(output, 'base64');
  }

  async clickRegistered(id: string): Promise<void> {
    this.ensureCurrent();
    const element = this.registry.get(id);
    if (!element) throw new Error(`Element ${id} is not registered`);
    const before = await this.interactionFingerprint();
    const locator = this.frameFor(element.frameIndex, element.frameUrl).locator(
      `[data-guardian-id="${id}"]`,
    );
    await locator.scrollIntoViewIfNeeded({ timeout: 2_000 });
    await locator.click({ timeout: 2_000 });
    await this.waitForInteractionToSettle(before);
  }

  async setToggle(id: string, desiredState: boolean): Promise<void> {
    this.ensureCurrent();
    const state = await this.inspect();
    const element = state.elements.find((candidate) => candidate.id === id);
    if (!element || !['checkbox', 'switch'].includes(element.kind))
      throw new Error('Registered target is not a toggle');
    if (element.checked !== desiredState) await this.clickRegistered(id);
    const confirmed = (await this.inspect()).elements.find((candidate) => candidate.id === id);
    if (!confirmed || confirmed.checked !== desiredState)
      throw new Error(`TOGGLE_STATE_UNCONFIRMED: ${id} did not reach ${desiredState}`);
  }

  async setToggles(
    targets: Array<{ elementId: string; desiredState: false }>,
    saveElementId?: string,
  ): Promise<BatchToggleResult> {
    this.ensureCurrent();
    const confirmedToggleIds: string[] = [];
    const skippedToggleIds: string[] = [];
    for (const target of targets) {
      const before = (await this.inspect()).elements.find(
        (element) => element.id === target.elementId,
      );
      if (!before || !['checkbox', 'switch'].includes(before.kind) || before.disabled)
        throw new Error(`BATCH_TOGGLE_INVALID: ${target.elementId}`);
      const category = `${before.name} ${before.label} ${before.categoryLabel ?? ''}`;
      if (
        /\b(necessary|essential|required|always active)\b/i.test(category) ||
        !/analytics|advertis|marketing|tracking|targeting|personal|social|performance|functional/i.test(
          category,
        )
      )
        throw new Error(`BATCH_TOGGLE_UNSAFE_CATEGORY: ${target.elementId}`);
      if (before.checked === false) skippedToggleIds.push(target.elementId);
      else await this.setToggle(target.elementId, false);
      const after = (await this.inspect()).elements.find(
        (element) => element.id === target.elementId,
      );
      if (!after || after.checked !== false)
        throw new Error(`BATCH_TOGGLE_UNCONFIRMED: ${target.elementId}`);
      confirmedToggleIds.push(target.elementId);
    }
    if (saveElementId) {
      const finalState = await this.inspect();
      if (
        !targets.every(
          ({ elementId }) =>
            finalState.elements.find((element) => element.id === elementId)?.checked === false,
        )
      )
        throw new Error('BATCH_SAVE_BLOCKED: not every requested toggle is confirmed off');
      const save = finalState.elements.find((element) => element.id === saveElementId);
      if (
        !save ||
        save.disabled ||
        !['button', 'link'].includes(save.kind) ||
        !/\b(save|confirm|apply)\b/i.test(`${save.name} ${save.label}`) ||
        /\b(accept|allow|agree|enable)\b/i.test(`${save.name} ${save.label}`)
      )
        throw new Error('BATCH_SAVE_BLOCKED: save target is no longer safe');
      await this.clickRegistered(saveElementId);
    }
    return {
      success: true,
      confirmedToggleIds,
      skippedToggleIds,
      ...(saveElementId ? { saveElementId } : {}),
    };
  }

  async scrollContainer(
    containerId: string,
    direction: 'up' | 'down',
    amount: 'small' | 'page',
  ): Promise<ScrollResult> {
    this.ensureCurrent();
    const container = this.registry.getContainer(containerId);
    if (!container) throw new Error(`Container ${containerId} is not registered`);
    if (!container.scrollable || container.scrollHeight <= container.clientHeight)
      throw new Error(`Container ${containerId} is not a verified scrollable consent container`);
    const beforeState = await perceivePage(this.page);
    this.registry.replace(beforeState);
    const beforeContainer = beforeState.containers.find(({ id }) => id === containerId);
    if (!beforeContainer?.scrollable)
      throw new Error(`Container ${containerId} is stale or no longer scrollable`);
    const beforeControlSignature = visibleControlSignature(beforeState, containerId);
    const beforeConsentSignature = consentInteractionSignature(beforeState);
    const requestedDistance =
      amount === 'page'
        ? Math.max(1, Math.round(beforeContainer.clientHeight * 0.8))
        : Math.min(240, Math.max(80, Math.round(beforeContainer.clientHeight * 0.3)));
    await this.frameFor(beforeContainer.frameIndex, beforeContainer.frameUrl)
      .locator(`[data-guardian-container-id="${containerId}"]`)
      .evaluate(
        (element, movement) => {
          element.scrollBy({ top: movement, behavior: 'instant' });
        },
        direction === 'down' ? requestedDistance : -requestedDistance,
        { timeout: 2_000 },
      );
    const afterState = await perceivePage(this.page);
    this.registry.replace(afterState);
    const afterContainer = afterState.containers.find(({ id }) => id === containerId);
    const beforeScrollTop = beforeContainer.scrollTop;
    const afterScrollTop = afterContainer?.scrollTop ?? beforeScrollTop;
    const visibleControlsChanged =
      beforeControlSignature !== visibleControlSignature(afterState, containerId);
    const consentStateChanged = beforeConsentSignature !== consentInteractionSignature(afterState);
    if (afterScrollTop === beforeScrollTop && !visibleControlsChanged)
      throw new Error(`NO_OP_SCROLL: ${containerId} did not move and reveal any consent controls`);
    return {
      success: true,
      containerId,
      direction,
      amount,
      beforeScrollTop,
      afterScrollTop,
      visibleControlsChanged,
      consentStateChanged,
    };
  }

  async refresh(): Promise<void> {
    this.ensureCurrent();
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('load');
  }

  async close(): Promise<void> {
    if (this.options.attachedPage) {
      this.registry.clear();
      this.currentPage = undefined;
      return;
    }
    const context = this.context;
    const browser = this.browser;
    const video = this.currentPage?.video();
    try {
      if (context && this.tracingStarted) {
        const tracePath = path.join(this.options.artifactDirectory, 'raw', 'trace.zip');
        await context.tracing.stop({ path: tracePath });
        this.stats.tracePath = tracePath;
        this.tracingStarted = false;
      }
    } finally {
      await context?.close();
      if (video) {
        const videoPath = path.join(this.options.artifactDirectory, 'raw', 'video.webm');
        await video.saveAs(videoPath);
        await video.delete();
        this.stats.videoPath = videoPath;
      }
      await browser?.close();
      this.registry.clear();
      this.currentPage = undefined;
      this.context = undefined;
      this.browser = undefined;
    }
  }

  private async interactionFingerprint(): Promise<string> {
    return consentStateFingerprint(await perceivePage(this.page));
  }

  private ensureCurrent(): void {
    if (this.options.isRunCurrent && !this.options.isRunCurrent())
      throw new Error('STALE_AUDIT: navigation changed during this audit');
  }

  private async waitForInteractionToSettle(before: string): Promise<void> {
    const deadline = Date.now() + 1_000;
    do {
      if ((await this.interactionFingerprint()) !== before) return;
      await delay(100);
    } while (Date.now() < deadline);
  }

  private frameFor(frameIndex: number, expectedUrl: string): Frame {
    const frame = this.page.frames()[frameIndex];
    if (!frame || sanitizeUrl(frame.url()) !== expectedUrl)
      throw new Error('Registered target frame is stale or detached');
    return frame;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function safeOrigin(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return undefined;
  }
}

export function headlessForMode(mode: 'inspector' | 'guardian'): boolean {
  return mode === 'guardian';
}

function visibleControlSignature(state: PageState, containerId: string): string {
  return JSON.stringify(
    state.elements
      .filter((element) => element.containerId === containerId && element.visible !== false)
      .map(({ role, name, label, checked, ariaChecked, disabled }) => ({
        role,
        name,
        label,
        checked,
        ariaChecked,
        disabled,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

function consentInteractionSignature(state: PageState): string {
  return JSON.stringify({
    bannerDetected: state.bannerDetected,
    fixtureState: state.fixtureState,
    elements: state.elements
      .map(({ role, name, label, categoryLabel, checked, ariaChecked, disabled }) => ({
        role,
        name,
        label,
        categoryLabel,
        checked,
        ariaChecked,
        disabled,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  });
}

export function isPageLifecycleCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /page.*closed|target.*closed|context.*closed|browser.*closed|frame.*detached|navigation|execution context was destroyed/i.test(
    message,
  );
}
