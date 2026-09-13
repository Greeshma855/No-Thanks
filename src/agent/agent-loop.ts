import { createHash } from 'node:crypto';
import type { GuardianDecision } from './decision-schema.js';
import { BrowserSession } from '../browser/browser-session.js';
import { consentStateFingerprint, sanitizeUrl } from '../browser/perception.js';
import { createBrowserTools } from '../browser/browser-tools.js';
import { createDemoPacer, type DemoPacer } from '../browser/demo-pacer.js';
import type { InspectorTone } from '../browser/inspector-overlay.js';
import type { GuardianConfig } from '../config/env.js';
import { resolveViewport } from '../config/display-profile.js';
import { BRAND } from '../config/brand.js';
import type {
  ActionRecord,
  DarkPattern,
  GuardianAction,
  GuardianReport,
  PageState,
  VerificationLevel,
  VerificationResult,
} from '../domain/types.js';
import { AuditLogger } from '../logging/audit-logger.js';
import type { ReasoningProvider } from '../providers/reasoning-provider.js';
import type { ModelScreenshot } from '../providers/reasoning-provider.js';
import { actionFingerprint, evaluateAction } from '../safety/action-policy.js';
import { isRemoteAnalysisAllowed } from '../safety/remote-host-policy.js';
import { calculateVerificationLevel } from '../verification/consent-verifier.js';

export interface GuardianLoopDependencies {
  session?: BrowserSession;
  pacer?: DemoPacer;
}

export interface GuardianRunOptions {
  navigate?: boolean;
  refreshForPersistence?: boolean;
  artifactRoot?: string;
  auditRunId?: string;
  isCurrent?: () => boolean;
}

export class GuardianLoop {
  constructor(
    private readonly config: GuardianConfig,
    private readonly provider: ReasoningProvider,
    private readonly dependencies: GuardianLoopDependencies = {},
  ) {}

  async run(url: string, options: GuardianRunOptions = {}): Promise<GuardianReport> {
    const startedAt = new Date().toISOString();
    const audit = await AuditLogger.create(
      options.artifactRoot ?? this.config.GUARDIAN_ARTIFACT_DIR,
      this.config.GUARDIAN_REPORT_EMBED_SCREENSHOTS,
      options.auditRunId,
    );
    const viewport = resolveViewport(this.config);
    const session =
      this.dependencies.session ??
      new BrowserSession({
        mode: this.config.GUARDIAN_MODE,
        viewport,
        slowMoMs:
          this.config.GUARDIAN_MODE === 'inspector' && this.config.GUARDIAN_DEMO_PACING
            ? this.config.GUARDIAN_SLOW_MO_MS
            : 0,
        artifactDirectory: audit.directory,
        recordVideo: this.config.GUARDIAN_RECORD_VIDEO,
        recordTrace: this.config.GUARDIAN_RECORD_TRACE,
      });
    const pacer = this.dependencies.pacer ?? createDemoPacer(this.config);
    const actions: ActionRecord[] = [];
    const safetyStops: string[] = [];
    const patterns = new Set<DarkPattern>();
    const fingerprints = new Set<string>();
    let current: PageState | undefined;
    let initial: PageState | undefined;
    let firstObservedConsentState: PageState | undefined;
    let lastRemoteStateHash: string | undefined;
    let usefulModelCalls = 0;
    let usefulReasoningSteps = 0;
    let staleRetries = 0;
    let lastStep = 0;
    let consentCandidateDetectedAt: string | undefined;
    const maximumStaleRetries = 2;
    try {
      await session.start();
      if (options.navigate ?? true) await session.navigate(url);
      const discovery = await session.discoverConsent(
        this.config.CONSENT_DISCOVERY_MAX_MS,
        this.config.CONSENT_DISCOVERY_POLL_MS,
        options.isCurrent,
      );
      current = discovery.state;
      consentCandidateDetectedAt = discovery.consentCandidateDetectedAt;
      initial = current;
      if (current.bannerDetected) firstObservedConsentState = current;
      await session.present(current, {
        phase: 'Perceive',
        tone: 'blue',
        step: 0,
        summary: `${current.elements.length} registered consent control(s) detected.`,
      });
      await audit.state(0, current);
      const initialScreenshot = await session.screenshot(audit.screenshotPath(0, 'initial'));
      await audit.telemetry(0, {
        discoveryInitialPerceptionAt: discovery.initialPerceptionCapturedAt,
        perceptionCapturedAt: current.capturedAt,
        ...(consentCandidateDetectedAt ? { consentCandidateDetectedAt } : {}),
        frameCount: current.frames.length,
        screenshotHash: createHash('sha256').update(initialScreenshot).digest('hex'),
        screenshotDimensions: session.viewport,
        imageAttachedToModel: false,
      });
      const tools = createBrowserTools(
        session,
        () => {
          if (!current) throw new Error('No current page state');
          return current;
        },
        this.config.GUARDIAN_MIN_CONFIDENCE,
      );

      for (let step = 1; step <= this.config.GUARDIAN_MAX_STEPS + maximumStaleRetries; step += 1) {
        lastStep = step;
        if (usefulReasoningSteps >= this.config.GUARDIAN_MAX_STEPS) break;
        if (options.isCurrent && !options.isCurrent()) {
          safetyStops.push('STALE_AUDIT: navigation changed; no further action was taken');
          break;
        }
        if (
          this.provider.name !== 'mock' &&
          !isRemoteAnalysisAllowed(current.url, this.config.REMOTE_ANALYSIS_ALLOWED_HOSTS)
        ) {
          const reason = 'no_safe_action: hostname is not approved for remote analysis';
          safetyStops.push(reason);
          await audit.safety(step, reason);
          await audit.continuation(
            step,
            'Remote analysis was skipped; the page was left untouched.',
          );
          break;
        }
        if (
          this.provider.name !== 'mock' &&
          usefulModelCalls >= this.config.MAX_MODEL_CALLS_PER_AUDIT
        ) {
          const reason = `no_safe_action: model-call limit ${this.config.MAX_MODEL_CALLS_PER_AUDIT} reached`;
          safetyStops.push(reason);
          await audit.safety(step, reason);
          break;
        }
        if (this.config.GUARDIAN_MODE === 'inspector') console.log(`[${step}] Perceive → Reason`);
        await session.present(current, {
          phase: 'Perceive',
          tone: 'blue',
          step,
          summary: `${current.elements.length} registered consent control(s) in a stable ${viewport.width}×${viewport.height} viewport.`,
        });
        await audit.state(step, current);
        const screenshot = await session.screenshot(audit.screenshotPath(step, 'before'));
        const modelInputFingerprint = consentStateFingerprint(current);
        let modelScreenshot: ModelScreenshot | undefined = { bytes: screenshot, format: 'png' };
        if (this.provider.name !== 'mock') {
          if (modelInputFingerprint === lastRemoteStateHash) modelScreenshot = undefined;
          else {
            const remoteBytes = await session.screenshotForModel(
              this.config.SCREENSHOT_MAX_WIDTH,
              this.config.SCREENSHOT_JPEG_QUALITY,
            );
            modelScreenshot = { bytes: remoteBytes, format: 'jpeg' };
          }
          lastRemoteStateHash = modelInputFingerprint;
        }
        await audit.telemetry(step, {
          perceptionCapturedAt: current.capturedAt,
          ...(consentCandidateDetectedAt && step === 1 ? { consentCandidateDetectedAt } : {}),
          frameCount: current.frames.length,
          screenshotHash: createHash('sha256')
            .update(modelScreenshot?.bytes ?? screenshot)
            .digest('hex'),
          screenshotDimensions: screenshotDimensions(
            session.viewport,
            modelScreenshot?.format,
            this.config.SCREENSHOT_MAX_WIDTH,
          ),
          imageAttachedToModel: modelScreenshot !== undefined,
          imageAttachedToOpenAIRequest:
            this.provider.name === 'openai' && modelScreenshot !== undefined,
          modelInputConsentFingerprint: modelInputFingerprint,
        });
        if (options.isCurrent && !options.isCurrent()) {
          const reason = 'STALE_AUDIT: navigation changed before reasoning; no model call was made';
          safetyStops.push(reason);
          await audit.safety(step, reason);
          break;
        }
        const modelStartedAt = new Date().toISOString();
        await audit.telemetry(step, { modelStartedAt });
        const rawDecision = await this.provider.decide(current, modelScreenshot, tools.all);
        const modelCompletedAt = new Date().toISOString();
        await audit.telemetry(step, { modelCompletedAt });

        // A decision is never trusted against the snapshot that produced it. This
        // fresh, complete perception is also the mandatory pre-terminal check for
        // NO_BANNER and STOP_SUCCESS.
        const postDecisionState = await session.inspect();
        if (postDecisionState.bannerDetected && !firstObservedConsentState)
          firstObservedConsentState = postDecisionState;
        const postDecisionFingerprint = consentStateFingerprint(postDecisionState);
        const postDecisionScreenshot = await session.screenshot(
          audit.screenshotPath(step, 'after'),
        );
        await audit.telemetry(step, {
          postDecisionPerceptionAt: postDecisionState.capturedAt,
          postDecisionConsentFingerprint: postDecisionFingerprint,
          postDecisionScreenshotHash: createHash('sha256')
            .update(postDecisionScreenshot)
            .digest('hex'),
          postDecisionScreenshotDimensions: session.viewport,
          frameCount: postDecisionState.frames.length,
        });
        if (options.isCurrent && !options.isCurrent()) {
          const reason = 'STALE_AUDIT: navigation changed while reasoning; model action abandoned';
          safetyStops.push(reason);
          await audit.safety(step, reason);
          await audit.continuation(
            step,
            'The stale model response was discarded without clicking.',
          );
          break;
        }
        if (
          postDecisionFingerprint !== modelInputFingerprint &&
          !canRevalidateDecision(
            rawDecision,
            current,
            postDecisionState,
            this.config.GUARDIAN_MIN_CONFIDENCE,
          )
        ) {
          const reason =
            'STALE_DECISION: consent state changed while reasoning; model response abandoned';
          await audit.safety(step, reason);
          await audit.warning(reason);
          await audit.continuation(
            step,
            'The stale model response was discarded; reasoning will continue from the fresh perception.',
          );
          await audit.telemetry(step, { staleDecisionDiscarded: true });
          await audit.decision(step, rawDecision);
          current = postDecisionState;
          staleRetries += 1;
          if (staleRetries > maximumStaleRetries) {
            const stop = `STOP_UNCERTAIN: stale-response retry limit ${maximumStaleRetries} reached`;
            safetyStops.push(stop);
            await audit.safety(step, stop);
            break;
          }
          continue;
        }
        if (this.provider.name !== 'mock') usefulModelCalls += 1;
        usefulReasoningSteps += 1;
        current = postDecisionState;
        const decision = correctRenderedClassification(rawDecision, current);
        await audit.decision(step, decision);
        decision.darkPatterns.forEach((pattern) => {
          if (pattern !== 'NONE') patterns.add(pattern);
        });
        const target = decision.action.elementId
          ? current.elements.find((element) => element.id === decision.action.elementId)
          : undefined;
        const tool = toolForAction(decision.action.type);
        await session.present(current, {
          phase: 'Reason',
          tone: decision.action.type === 'STOP_UNCERTAIN' ? 'gray' : 'amber',
          step,
          darkPatterns: decision.darkPatterns,
          summary: decision.summary,
          tool,
          ...(target
            ? {
                targetId: target.id,
                targetLabel: target.name || target.label,
              }
            : {}),
          confidence: decision.confidence,
        });
        if (this.config.GUARDIAN_MODE === 'inspector')
          console.log(`[${step}] ${decision.summary} (${decision.confidence.toFixed(2)})`);

        const policy = evaluateAction(decision, current, this.config.GUARDIAN_MIN_CONFIDENCE);
        if (!policy.allowed) {
          const reason = `STOP_UNCERTAIN: ${policy.reason}`;
          safetyStops.push(reason);
          await audit.safety(step, reason);
          await audit.continuation(step, 'Stopped because the safety policy blocked the action.');
          await session.present(current, {
            phase: 'Act',
            tone: decision.action.type === 'STOP_UNCERTAIN' ? 'gray' : 'red',
            step,
            darkPatterns: decision.darkPatterns,
            summary: decision.summary,
            tool,
            ...(target ? { targetId: target.id, targetLabel: target.name || target.label } : {}),
            confidence: decision.confidence,
            result: reason,
          });
          break;
        }
        if (decision.action.type === 'STOP_UNCERTAIN') {
          safetyStops.push(decision.summary);
          await audit.safety(step, policy.reason, true);
          await audit.continuation(
            step,
            'Stopped safely because no unambiguous action was available.',
          );
          await session.present(current, {
            phase: 'Verify',
            tone: 'gray',
            step,
            darkPatterns: decision.darkPatterns,
            summary: decision.summary,
            confidence: decision.confidence,
            result: 'Safe stop; no page action was executed.',
            verification: 'UNVERIFIED',
          });
          break;
        }
        if (['NO_BANNER', 'STOP_SUCCESS'].includes(decision.action.type)) {
          await audit.safety(step, policy.reason, true);
          await audit.continuation(step, 'Stopped because no further consent action was required.');
          break;
        }
        const fingerprint = actionFingerprint(decision, current);
        if (fingerprints.has(fingerprint)) {
          const reason = 'STOP_UNCERTAIN: repeated action/page-state fingerprint';
          safetyStops.push(reason);
          await audit.safety(step, reason);
          await audit.continuation(step, 'Stopped to prevent a repeated-action loop.');
          await session.present(current, {
            phase: 'Act',
            tone: 'red',
            step,
            darkPatterns: decision.darkPatterns,
            summary: decision.summary,
            tool,
            ...(target ? { targetId: target.id, targetLabel: target.name || target.label } : {}),
            confidence: decision.confidence,
            result: reason,
          });
          break;
        }
        fingerprints.add(fingerprint);
        await audit.safety(step, policy.reason, true);
        await session.present(current, {
          phase: 'Act',
          tone: 'amber',
          step,
          darkPatterns: decision.darkPatterns,
          summary: decision.summary,
          tool,
          ...(target ? { targetId: target.id, targetLabel: target.name || target.label } : {}),
          confidence: decision.confidence,
          result: 'Safety policy approved; action pending.',
        });
        await pacer.beforeAction();

        // Refresh both the DOM registry and consent fingerprint at the final
        // action boundary. A valid model target must still describe this exact
        // rendered interface immediately before it is used.
        const expectedActionState = consentStateFingerprint(current);
        const immediateState = await session.inspect();
        if (
          consentStateFingerprint(immediateState) !== expectedActionState &&
          !canRevalidateDecision(
            decision,
            current,
            immediateState,
            this.config.GUARDIAN_MIN_CONFIDENCE,
          )
        ) {
          const reason =
            'STALE_ACTION: consent state changed immediately before action; target abandoned';
          await audit.warning(reason);
          await audit.continuation(step, reason);
          current = immediateState;
          continue;
        }
        current = immediateState;
        if (current.bannerDetected && !firstObservedConsentState)
          firstObservedConsentState = current;
        const immediatePolicy = evaluateAction(
          decision,
          current,
          this.config.GUARDIAN_MIN_CONFIDENCE,
        );
        if (!immediatePolicy.allowed) {
          const reason = `STOP_UNCERTAIN: ${immediatePolicy.reason}`;
          safetyStops.push(reason);
          await audit.safety(step, reason);
          await audit.continuation(step, 'Stopped because the refreshed target failed policy.');
          break;
        }

        let success = false;
        let detail = '';
        let confirmedToggleIds: string[] | undefined;
        try {
          if (decision.action.type === 'CLICK_REJECT')
            await tools.clickConsentElement.invoke({
              elementId: decision.action.elementId!,
              purpose: 'reject',
            });
          else if (decision.action.type === 'OPEN_PREFERENCES')
            await tools.clickConsentElement.invoke({
              elementId: decision.action.elementId!,
              purpose: 'preferences',
            });
          else if (decision.action.type === 'SAVE_PREFERENCES')
            await tools.clickConsentElement.invoke({
              elementId: decision.action.elementId!,
              purpose: 'save',
            });
          else if (decision.action.type === 'SET_CONSENT_TOGGLE')
            await tools.setConsentToggle.invoke({
              elementId: decision.action.elementId!,
              desiredState: false,
            });
          else if (decision.action.type === 'SET_CONSENT_TOGGLES') {
            const batch = await tools.setConsentToggles.invoke({
              targets: decision.action.targets!,
              ...(decision.action.saveElementId
                ? { saveElementId: decision.action.saveElementId }
                : {}),
            });
            confirmedToggleIds = batch.confirmedToggleIds;
            detail = `Confirmed ${batch.confirmedToggleIds.length} non-essential toggle(s) off${batch.saveElementId ? ' and saved the choices' : ''}.`;
          } else if (decision.action.type === 'SCROLL_MODAL') {
            const scroll = await tools.scrollConsentContainer.invoke({
              ...(decision.action.containerId
                ? { containerId: decision.action.containerId }
                : { elementId: decision.action.elementId! }),
              direction: decision.action.direction!,
              amount: decision.action.amount!,
            });
            detail = `Scrolled ${scroll.containerId} from ${scroll.beforeScrollTop} to ${scroll.afterScrollTop}; visibleControlsChanged=${scroll.visibleControlsChanged}; consentStateChanged=${scroll.consentStateChanged}`;
          }
          success = true;
          if (!detail) detail = policy.reason;
        } catch (error) {
          detail = error instanceof Error ? error.message : String(error);
          safetyStops.push(detail);
        }
        await pacer.afterAction();
        const record: ActionRecord = {
          step,
          action: decision.action.type,
          ...(decision.action.elementId ? { elementId: decision.action.elementId } : {}),
          ...(decision.action.targets ? { targets: decision.action.targets } : {}),
          ...(decision.action.saveElementId
            ? { saveElementId: decision.action.saveElementId }
            : {}),
          ...(confirmedToggleIds ? { confirmedToggleIds } : {}),
          ...(decision.action.containerId ? { containerId: decision.action.containerId } : {}),
          ...(decision.action.direction ? { direction: decision.action.direction } : {}),
          ...(decision.action.amount ? { amount: decision.action.amount } : {}),
          success,
          detail,
        };
        actions.push(record);
        await audit.action(step, record);

        current = await session.inspect();
        const stepVerification = calculateVerificationLevel(
          firstObservedConsentState ?? initial,
          current,
          { actions },
        );
        await audit.verification(step, stepVerification);
        await session.present(current, {
          phase: 'Verify',
          tone: verificationTone(stepVerification.level),
          step,
          darkPatterns: decision.darkPatterns,
          summary: decision.summary,
          tool,
          ...(target ? { targetId: target.id, targetLabel: target.name || target.label } : {}),
          confidence: decision.confidence,
          result: success ? 'Action completed.' : detail,
          verification: stepVerification.level,
        });
        await session.screenshot(audit.screenshotPath(step, 'after'));
        await audit.continuation(
          step,
          success
            ? 'Continued with re-perception to detect another consent layer or confirm completion.'
            : 'Stopped because the browser action failed.',
        );
        await pacer.afterVerification();
        if (!success) break;
      }

      const beforeRefresh = current;
      let persisted = false;
      if (
        (options.refreshForPersistence ?? true) &&
        !current.bannerDetected &&
        Boolean(firstObservedConsentState?.bannerDetected) &&
        (!options.isCurrent || options.isCurrent())
      ) {
        await session.refresh();
        current = await session.inspect();
        persisted =
          !current.bannerDetected &&
          beforeRefresh.fixtureState !== undefined &&
          beforeRefresh.fixtureState === current.fixtureState;
      }
      // Final state is always a new complete perception, even when no action or
      // refresh occurred. This prevents an initial DOM snapshot from being
      // paired with a later screenshot.
      current = await session.inspect();
      const finalFingerprint = consentStateFingerprint(current);
      const finalStep = lastStep + 1;
      const finalScreenshot = await session.screenshot(audit.screenshotPath(finalStep, 'final'));
      await audit.telemetry(finalStep, {
        perceptionCapturedAt: current.capturedAt,
        postDecisionPerceptionAt: current.capturedAt,
        frameCount: current.frames.length,
        screenshotHash: createHash('sha256').update(finalScreenshot).digest('hex'),
        screenshotDimensions: session.viewport,
        imageAttachedToModel: false,
        imageAttachedToOpenAIRequest: false,
        postDecisionConsentFingerprint: finalFingerprint,
      });
      const verification: VerificationResult = calculateVerificationLevel(
        firstObservedConsentState ?? initial,
        current,
        { persistedAfterRefresh: persisted, actions },
      );
      await audit.finalState(current);
      await session.present(current, {
        phase: 'Verify',
        tone: verificationTone(verification.level),
        step: actions.length,
        darkPatterns: patterns.size ? [...patterns] : ['NONE'],
        summary: verification.evidence.details.join(' ') || 'No definitive rejection evidence.',
        result: safetyStops.at(-1) ?? `${BRAND.productName} run complete.`,
        verification: verification.level,
      });
      await audit.verification(finalStep, verification);
      const report: GuardianReport = {
        startedAt,
        completedAt: new Date().toISOString(),
        url: sanitizeUrl(url),
        provider: this.provider.name,
        ...(this.provider.modelId ? { model: this.provider.modelId } : {}),
        mode: this.config.GUARDIAN_MODE,
        displayProfile: this.config.GUARDIAN_DISPLAY_PROFILE,
        viewport,
        bannerDetected: Boolean(firstObservedConsentState?.bannerDetected),
        finalBannerDetected: current.bannerDetected,
        finalStateCapturedAt: current.capturedAt,
        finalConsentFingerprint: finalFingerprint,
        darkPatterns: patterns.size ? [...patterns] : ['NONE'],
        actions,
        safetyStops,
        verification,
        artifactDirectory: audit.directory,
      };
      await audit.final(report);
      await pacer.holdFinalState();
      return report;
    } finally {
      await session.close();
    }
  }
}

function toolForAction(action: GuardianAction): string {
  if (['CLICK_REJECT', 'OPEN_PREFERENCES', 'SAVE_PREFERENCES'].includes(action))
    return 'click_consent_element';
  if (action === 'SET_CONSENT_TOGGLE') return 'set_consent_toggle';
  if (action === 'SET_CONSENT_TOGGLES') return 'set_consent_toggles';
  if (action === 'SCROLL_MODAL') return 'scroll_consent_container';
  if (['STOP_SUCCESS', 'NO_BANNER'].includes(action)) return 'verify_consent_state';
  return 'none';
}

function verificationTone(level: VerificationLevel): InspectorTone {
  if (['VERIFIED', 'LIKELY_VERIFIED'].includes(level)) return 'green';
  if (level === 'FAILED') return 'red';
  return 'gray';
}

function screenshotDimensions(
  viewport: { width: number; height: number },
  format: ModelScreenshot['format'] | undefined,
  maximumWidth: number,
): { width: number; height: number } {
  if (format !== 'jpeg' || viewport.width <= maximumWidth) return viewport;
  return {
    width: maximumWidth,
    height: Math.max(1, Math.round((viewport.height * maximumWidth) / viewport.width)),
  };
}

function correctRenderedClassification(
  decision: Awaited<ReturnType<ReasoningProvider['decide']>>,
  state: PageState,
): Awaited<ReturnType<ReasoningProvider['decide']>> {
  if (!decision.darkPatterns.includes('HIDDEN_REJECTION')) return decision;
  const visibleReject = state.elements.some((element) =>
    /\b(reject|deny|decline|refuse|opt out|no[\s,]+thank(?:s| you))\b/i.test(
      `${element.name} ${element.label}`,
    ),
  );
  if (!visibleReject) return decision;
  const corrected = decision.darkPatterns.filter((pattern) => pattern !== 'HIDDEN_REJECTION');
  return { ...decision, darkPatterns: corrected.length ? corrected : ['NONE'] };
}

function canRevalidateDecision(
  decision: GuardianDecision,
  before: PageState,
  after: PageState,
  minConfidence: number,
): boolean {
  if (['NO_BANNER', 'STOP_SUCCESS', 'STOP_UNCERTAIN'].includes(decision.action.type)) return false;
  if (!evaluateAction(decision, after, minConfidence).allowed) return false;
  const sameElement = (id: string): boolean => {
    const previous = before.elements.find((element) => element.id === id);
    const current = after.elements.find((element) => element.id === id);
    if (!previous || !current) return false;
    const normalize = (value: string | undefined): string =>
      (value ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    return (
      previous.kind === current.kind &&
      normalize(previous.role) === normalize(current.role) &&
      normalize(previous.name) === normalize(current.name) &&
      normalize(previous.label) === normalize(current.label) &&
      normalize(previous.categoryLabel) === normalize(current.categoryLabel) &&
      previous.frameUrl === current.frameUrl
    );
  };
  if (decision.action.type === 'SCROLL_MODAL') {
    const id =
      decision.action.containerId ??
      before.elements.find(({ id }) => id === decision.action.elementId)?.containerId;
    const previous = before.containers.find((container) => container.id === id);
    const current = after.containers.find((container) => container.id === id);
    return Boolean(
      previous &&
        current &&
        previous.role === current.role &&
        previous.frameUrl === current.frameUrl &&
        current.scrollable,
    );
  }
  if (decision.action.type === 'SET_CONSENT_TOGGLES')
    return (
      decision.action.targets?.every(({ elementId }) => sameElement(elementId)) === true &&
      (!decision.action.saveElementId || sameElement(decision.action.saveElementId))
    );
  return Boolean(decision.action.elementId && sameElement(decision.action.elementId));
}
