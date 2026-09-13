import path from 'node:path';
import { copyFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext, type Frame, type Page, type Video } from 'playwright';
import { GuardianLoop } from '../agent/agent-loop.js';
import type { GuardianConfig } from '../config/env.js';
import { BrowserSessionArtifacts } from '../logging/browser-session-artifacts.js';
import type { ReasoningProvider } from '../providers/reasoning-provider.js';
import { isEligibleBrowserUrl } from '../safety/remote-host-policy.js';
import { BrowserAuditRuntime, type ScheduledAudit } from './audit-runtime.js';
import { BrowserSession, isPageLifecycleCancellation } from './browser-session.js';
import { consentStateFingerprint, detectConsentCandidate, perceivePage } from './perception.js';

interface ManagedTab {
  tabId: string;
  page: Page;
  video: Video | null;
  openedAt: string;
  finalizePromise?: Promise<void>;
  auditActive: boolean;
  hasCompletedAudit: boolean;
  navigationPending: boolean;
  mutationPending: boolean;
  watcherTimer: NodeJS.Timeout | undefined;
  lastAuditedFingerprint: string | undefined;
  bindingName: string;
}

export interface InteractiveBrowserOptions {
  profileDirectory?: string;
  headlessOverride?: boolean;
  navigationDebounceMs?: number;
  stabilizationMs?: number;
}

export class InteractiveBrowserSession {
  private readonly browserSessionId = `browser-session-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  private readonly runtime: BrowserAuditRuntime;
  private readonly tabs = new Map<Page, ManagedTab>();
  private readonly finalizers = new Set<Promise<void>>();
  private readonly registrations = new Set<Promise<void>>();
  private context: BrowserContext | undefined;
  private artifacts: BrowserSessionArtifacts | undefined;
  private closing = false;
  private finished = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly config: GuardianConfig,
    private readonly provider: ReasoningProvider,
    private readonly options: InteractiveBrowserOptions = {},
  ) {
    this.runtime = new BrowserAuditRuntime(
      this.browserSessionId,
      config.MAX_CONCURRENT_AUDITS,
      options.navigationDebounceMs ?? 750,
    );
  }

  async start(): Promise<void> {
    if (this.context) throw new Error('Interactive browser session may only be started once');
    this.artifacts = await BrowserSessionArtifacts.create(
      this.config.GUARDIAN_ARTIFACT_DIR,
      this.browserSessionId,
      this.provider.name,
      this.provider.modelId,
    );
    const profileDirectory = path.resolve(
      this.options.profileDirectory ?? path.join('.dpg', 'browser-profile'),
    );
    this.context = await chromium.launchPersistentContext(profileDirectory, {
      headless: this.options.headlessOverride ?? false,
      slowMo: this.config.BROWSER_SLOW_MO_MS,
      viewport: {
        width: this.config.BROWSER_VIEWPORT_WIDTH,
        height: this.config.BROWSER_VIEWPORT_HEIGHT,
      },
      deviceScaleFactor: 1,
      recordVideo: {
        dir: this.artifacts.temporaryVideosDirectory,
        size: {
          width: this.config.BROWSER_VIEWPORT_WIDTH,
          height: this.config.BROWSER_VIEWPORT_HEIGHT,
        },
      },
    });
    this.context.on('page', (page) => this.trackRegistration(this.registerPage(page)));
    for (const page of this.context.pages()) await this.registerPage(page);
    this.status(undefined, undefined, 'ready');
  }

  async waitUntilClosed(): Promise<void> {
    const context = this.requireContext();
    const browser = context.browser();
    if (browser && !browser.isConnected()) return;
    await new Promise<void>((resolve) => context.once('close', () => resolve()));
  }

  pages(): Page[] {
    return this.requireContext().pages();
  }

  async openTab(url?: string): Promise<Page> {
    const page = await this.requireContext().newPage();
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page;
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.registrations]);
    await delay(
      (this.options.navigationDebounceMs ?? 750) + (this.options.stabilizationMs ?? 500) + 25,
    );
    await this.runtime.drain();
  }

  async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    await this.shutdownPromise;
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.shutdown();
    this.runtime.shutdown();
    await Promise.allSettled([...this.registrations]);
    await this.runtime.drain();
    await Promise.resolve();
    await Promise.allSettled([...this.finalizers]);
    if (this.artifacts) {
      for (const tab of this.tabs.values()) {
        await this.artifacts.closeTab(tab.tabId, tab.page.url());
        if (!tab.finalizePromise) this.trackFinalizer(this.finalizeVideo(tab));
      }
      await Promise.allSettled([...this.finalizers]);
      await this.artifacts.cleanupTemporaryVideos();
      await this.artifacts.finalize();
      this.status(undefined, undefined, `closed artifacts=${this.artifacts.directory}`);
    }
  }

  private async registerPage(page: Page): Promise<void> {
    if (this.tabs.has(page) || this.closing) return;
    const tabId = this.runtime.registerTab();
    const tab: ManagedTab = {
      tabId,
      page,
      video: page.video(),
      openedAt: new Date().toISOString(),
      auditActive: false,
      hasCompletedAudit: false,
      navigationPending: false,
      mutationPending: false,
      watcherTimer: undefined,
      lastAuditedFingerprint: undefined,
      bindingName: `__dpgConsentMutation_${tabId.replaceAll('-', '_')}`,
    };
    this.tabs.set(page, tab);
    await page.exposeBinding(tab.bindingName, () => this.signalConsentMutation(tab));
    page.on('frameattached', (frame) => {
      void this.installConsentWatcher(frame, tab);
      this.signalConsentMutation(tab);
    });
    page.on('framenavigated', (frame) => {
      void this.installConsentWatcher(frame, tab);
      if (frame === page.mainFrame()) this.handleNavigation(tab, frame.url());
      else this.signalConsentMutation(tab);
    });
    page.once('close', () => {
      if (tab.watcherTimer) clearTimeout(tab.watcherTimer);
      this.runtime.closeTab(tabId);
      const finalizer = this.finalizeClosedTab(tab);
      tab.finalizePromise = finalizer;
      this.trackFinalizer(finalizer);
    });
    await Promise.allSettled(page.frames().map((frame) => this.installConsentWatcher(frame, tab)));
    await this.requireArtifacts().addTab(tabId, page.url());
    if (isEligibleBrowserUrl(page.url())) this.handleNavigation(tab, page.url());
    this.status(tabId, undefined, 'tab_opened');
  }

  private handleNavigation(tab: ManagedTab, url: string): void {
    if (!isEligibleBrowserUrl(url) || tab.page.isClosed() || this.closing) return;
    tab.navigationPending = true;
    void this.runtime
      .schedule(tab.tabId, url, (audit) => this.runStableAudit(tab, audit))
      .catch((error: unknown) => {
        this.status(
          tab.tabId,
          undefined,
          `error=${safeError(error, this.config.OPENAI_API_KEY)}`,
          hostnameFor(url),
        );
      });
  }

  private async runStableAudit(tab: ManagedTab, audit: ScheduledAudit): Promise<void> {
    await tab.page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    await delay(this.options.stabilizationMs ?? 500);
    if (!audit.isCurrent() || tab.page.url() !== audit.url) return;
    tab.auditActive = true;
    tab.navigationPending = false;
    await this.requireArtifacts().addAudit(tab.tabId, audit.auditRunId, audit.url);
    this.status(tab.tabId, audit.auditRunId, 'started', hostnameFor(audit.url));
    const session = new BrowserSession({
      mode: 'guardian',
      viewport: {
        width: this.config.BROWSER_VIEWPORT_WIDTH,
        height: this.config.BROWSER_VIEWPORT_HEIGHT,
      },
      slowMoMs: 0,
      artifactDirectory: path.join(this.requireArtifacts().runsDirectory, audit.auditRunId),
      recordVideo: false,
      recordTrace: false,
      attachedPage: tab.page,
      allowCrossOriginNavigation: true,
      isRunCurrent: audit.isCurrent,
    });
    try {
      const runConfig: GuardianConfig = {
        ...this.config,
        GUARDIAN_MODE: 'guardian',
        GUARDIAN_DISPLAY_PROFILE: 'custom',
        GUARDIAN_VIEWPORT_WIDTH: this.config.BROWSER_VIEWPORT_WIDTH,
        GUARDIAN_VIEWPORT_HEIGHT: this.config.BROWSER_VIEWPORT_HEIGHT,
      };
      const report = await new GuardianLoop(runConfig, this.provider, { session }).run(audit.url, {
        navigate: false,
        refreshForPersistence: false,
        artifactRoot: this.requireArtifacts().runsDirectory,
        auditRunId: audit.auditRunId,
        isCurrent: audit.isCurrent,
      });
      tab.lastAuditedFingerprint = report.finalConsentFingerprint;
      await this.requireArtifacts().setAuditStatus(tab.tabId, audit.auditRunId, 'completed');
      const result = report.safetyStops.at(-1) ?? report.verification.level;
      this.status(tab.tabId, audit.auditRunId, result, hostnameFor(audit.url));
    } catch (error) {
      const message = safeError(error, this.config.OPENAI_API_KEY);
      if (!audit.isCurrent() || isPageLifecycleCancellation(error)) {
        await this.requireArtifacts().recordAuditCancellation(audit.auditRunId, message);
        await this.requireArtifacts().setAuditStatus(tab.tabId, audit.auditRunId, 'cancelled');
        this.status(tab.tabId, audit.auditRunId, `cancelled=${message}`, hostnameFor(audit.url));
      } else {
        await this.requireArtifacts().recordAuditFailure(audit.auditRunId, message);
        await this.requireArtifacts().setAuditStatus(tab.tabId, audit.auditRunId, 'failed');
        this.status(tab.tabId, audit.auditRunId, `error=${message}`, hostnameFor(audit.url));
      }
    } finally {
      tab.auditActive = false;
      tab.hasCompletedAudit = true;
      if (tab.mutationPending) this.signalConsentMutation(tab);
    }
  }

  private signalConsentMutation(tab: ManagedTab): void {
    tab.mutationPending = true;
    if (
      !tab.hasCompletedAudit ||
      tab.auditActive ||
      tab.navigationPending ||
      tab.page.isClosed() ||
      this.closing
    )
      return;
    if (tab.watcherTimer) clearTimeout(tab.watcherTimer);
    tab.watcherTimer = setTimeout(() => {
      tab.watcherTimer = undefined;
      void this.probeLateConsent(tab);
    }, 250);
  }

  private async probeLateConsent(tab: ManagedTab): Promise<void> {
    tab.mutationPending = false;
    if (tab.auditActive || tab.navigationPending || tab.page.isClosed() || this.closing) return;
    try {
      // Keep mutation handling cheap: perform the complete perception only when
      // a frame contains a visible consent candidate.
      if (!(await detectConsentCandidate(tab.page))) return;
      const state = await perceivePage(tab.page);
      const fingerprint = consentStateFingerprint(state);
      if (!state.bannerDetected || fingerprint === tab.lastAuditedFingerprint) return;
      tab.navigationPending = true;
      void this.runtime
        .schedule(tab.tabId, tab.page.url(), (audit) => this.runStableAudit(tab, audit))
        .catch((error: unknown) => {
          tab.navigationPending = false;
          this.status(
            tab.tabId,
            undefined,
            `error=${safeError(error, this.config.OPENAI_API_KEY)}`,
            hostnameFor(tab.page.url()),
          );
        });
    } catch {
      // Frames can detach between the lightweight probe and full capture.
    }
  }

  private async installConsentWatcher(frame: Frame, tab: ManagedTab): Promise<void> {
    await frame
      .evaluate((bindingName) => {
        const global = window as unknown as Record<string, unknown>;
        const observerKey = `${bindingName}Observer`;
        if (global[observerKey]) return;
        const relevant = (node: Node): boolean => {
          const element = node instanceof Element ? node : node.parentElement;
          if (!element) return false;
          if (
            element.matches(
              '[role="dialog"], [aria-modal="true"], [data-cookie-banner], [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="privacy" i], [id*="privacy" i]',
            ) ||
            element.closest(
              '[role="dialog"], [aria-modal="true"], [data-cookie-banner], [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="privacy" i], [id*="privacy" i]',
            )
          )
            return true;
          return /cookie|consent|privacy|reject|decline|necessary only/i.test(
            (element.textContent ?? '').slice(0, 500),
          );
        };
        const notify = (): void => {
          const binding = global[bindingName];
          if (typeof binding === 'function') void (binding as () => Promise<void>)();
        };
        const observer = new MutationObserver((mutations) => {
          if (
            mutations.some(
              (mutation) =>
                relevant(mutation.target) ||
                [...mutation.addedNodes].some((node) => relevant(node)),
            )
          )
            notify();
        });
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['class', 'id', 'role', 'aria-modal', 'aria-hidden', 'hidden', 'style'],
        });
        global[observerKey] = observer;
      }, tab.bindingName)
      .catch(() => undefined);
  }

  private async finalizeClosedTab(tab: ManagedTab): Promise<void> {
    await this.requireArtifacts().closeTab(tab.tabId, tab.page.url());
    await this.finalizeVideo(tab);
  }

  private async finalizeVideo(tab: ManagedTab): Promise<void> {
    if (!tab.video) return;
    const stamp = tab.openedAt.replace(/[:.]/g, '-');
    const filename = `${tab.tabId}-${stamp}.webm`;
    const destination = path.join(this.requireArtifacts().recordingsDirectory, filename);
    try {
      const temporaryPath = await tab.video.path();
      await rename(temporaryPath, destination).catch(async () => {
        await copyFile(temporaryPath, destination);
        await unlink(temporaryPath).catch(() => undefined);
      });
      await this.requireArtifacts().setVideo(
        tab.tabId,
        path.posix.join('raw', 'recordings', filename),
      );
    } catch (error) {
      this.status(
        tab.tabId,
        undefined,
        `recording_error=${safeError(error, this.config.OPENAI_API_KEY)}`,
      );
    }
  }

  private trackFinalizer(value: Promise<void>): void {
    this.finalizers.add(value);
    void value.finally(() => this.finalizers.delete(value));
  }

  private trackRegistration(value: Promise<void>): void {
    this.registrations.add(value);
    void value.finally(() => this.registrations.delete(value));
  }

  private status(
    tabId: string | undefined,
    auditRunId: string | undefined,
    result: string,
    hostname = '-',
  ): void {
    console.log(
      `[browserSessionId=${this.browserSessionId}] [tabId=${tabId ?? '-'}] [auditRunId=${auditRunId ?? '-'}] [provider=${this.provider.name}] [hostname=${hostname}] ${result}`,
    );
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error('Interactive browser session is not started');
    return this.context;
  }

  private async performShutdown(): Promise<void> {
    this.closing = true;
    this.runtime.shutdown();
    await this.context?.close().catch(() => undefined);
  }

  private requireArtifacts(): BrowserSessionArtifacts {
    if (!this.artifacts) throw new Error('Browser artifacts are not initialized');
    return this.artifacts;
  }
}

function hostnameFor(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '-';
  }
}

function safeError(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.replaceAll(secret, '[REDACTED]');
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\s+/g, ' ')
    .slice(0, 240);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
