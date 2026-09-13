import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GuardianDecision } from '../agent/decision-schema.js';
import { BRAND } from '../config/brand.js';
import type {
  ActionRecord,
  GuardianReport,
  PageState,
  VerificationResult,
} from '../domain/types.js';

interface AuditStep {
  step: number;
  perception?: PageState;
  decision?: GuardianDecision;
  action?: ActionRecord;
  safetyValidation?: { allowed: boolean; reason: string };
  verification?: VerificationResult;
  screenshotBefore?: string;
  screenshotAfter?: string;
  continuation?: string;
  telemetry?: PerceptionTelemetry;
}

export interface PerceptionTelemetry {
  discoveryInitialPerceptionAt?: string;
  perceptionCapturedAt?: string;
  modelStartedAt?: string;
  modelCompletedAt?: string;
  postDecisionPerceptionAt?: string;
  consentCandidateDetectedAt?: string;
  frameCount?: number;
  screenshotHash?: string;
  screenshotDimensions?: { width: number; height: number };
  postDecisionScreenshotHash?: string;
  postDecisionScreenshotDimensions?: { width: number; height: number };
  imageAttachedToModel?: boolean;
  imageAttachedToOpenAIRequest?: boolean;
  modelInputConsentFingerprint?: string;
  postDecisionConsentFingerprint?: string;
  staleDecisionDiscarded?: boolean;
}

interface AuditDocument {
  schemaVersion: 1;
  runId: string;
  initialState?: PageState;
  finalState?: PageState;
  initialScreenshot?: string;
  finalScreenshot?: string;
  steps: AuditStep[];
  warnings: string[];
  errors: string[];
  report?: GuardianReport;
}

export class AuditLogger {
  readonly directory: string;
  readonly rawDirectory: string;
  private readonly screenshotsDirectory: string;
  private readonly audit: AuditDocument;

  private constructor(
    directory: string,
    private readonly embedScreenshots: boolean,
  ) {
    this.directory = directory;
    this.rawDirectory = path.join(directory, 'raw');
    this.screenshotsDirectory = path.join(this.rawDirectory, 'screenshots');
    this.audit = {
      schemaVersion: 1,
      runId: path.basename(directory),
      steps: [],
      warnings: [],
      errors: [],
    };
  }

  static async create(root: string, embedScreenshots = true, runId?: string): Promise<AuditLogger> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directory = path.resolve(root, runId ?? `run-${stamp}`);
    const logger = new AuditLogger(directory, embedScreenshots);
    await mkdir(logger.screenshotsDirectory, { recursive: true });
    return logger;
  }

  screenshotPath(step: number, phase: 'initial' | 'before' | 'after' | 'final'): string {
    const relative = path.posix.join(
      'raw',
      'screenshots',
      `${String(step).padStart(2, '0')}-${phase}.png`,
    );
    if (phase === 'initial') this.audit.initialScreenshot = relative;
    else if (phase === 'final') this.audit.finalScreenshot = relative;
    else {
      const record = this.step(step);
      if (phase === 'before') record.screenshotBefore = relative;
      else record.screenshotAfter = relative;
    }
    return path.join(this.directory, ...relative.split('/'));
  }

  async state(step: number, state: PageState): Promise<void> {
    if (step === 0) this.audit.initialState = state;
    else this.step(step).perception = state;
  }

  async finalState(state: PageState): Promise<void> {
    this.audit.finalState = state;
  }

  async decision(step: number, decision: GuardianDecision): Promise<void> {
    this.step(step).decision = decision;
  }

  async safety(step: number, reason: string, allowed = false): Promise<void> {
    this.step(step).safetyValidation = { allowed, reason };
  }

  async action(step: number, value: ActionRecord): Promise<void> {
    const record = this.step(step);
    record.action = value;
    if (!record.safetyValidation)
      record.safetyValidation = { allowed: value.success, reason: value.detail };
  }

  async verification(step: number, value: VerificationResult): Promise<void> {
    this.step(step).verification = value;
  }

  async continuation(step: number, reason: string): Promise<void> {
    this.step(step).continuation = reason;
  }

  async telemetry(step: number, value: PerceptionTelemetry): Promise<void> {
    const record = this.step(step);
    record.telemetry = { ...record.telemetry, ...value };
  }

  async warning(message: string): Promise<void> {
    this.audit.warnings.push(message);
  }

  async error(message: string): Promise<void> {
    this.audit.errors.push(message);
  }

  async final(report: GuardianReport): Promise<void> {
    this.audit.report = report;
    await writeFile(
      path.join(this.directory, 'audit.json'),
      `${JSON.stringify(this.audit, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(this.directory, 'report.html'),
      await this.renderHtml(report),
      'utf8',
    );
  }

  private step(stepNumber: number): AuditStep {
    let record = this.audit.steps.find(({ step }) => step === stepNumber);
    if (!record) {
      record = { step: stepNumber };
      this.audit.steps.push(record);
      this.audit.steps.sort((left, right) => left.step - right.step);
    }
    return record;
  }

  private async renderHtml(report: GuardianReport): Promise<string> {
    const durationMs =
      new Date(report.completedAt).getTime() - new Date(report.startedAt).getTime();
    const screenshot = async (relative: string | undefined, alt: string): Promise<string> => {
      if (!relative) return '<p class="muted">No screenshot recorded.</p>';
      const source = this.embedScreenshots
        ? `data:image/png;base64,${(await readFile(path.join(this.directory, ...relative.split('/')))).toString('base64')}`
        : relative;
      return `<img src="${escapeAttribute(source)}" alt="${escapeAttribute(alt)}" loading="lazy">`;
    };
    const steps = await Promise.all(
      this.audit.steps
        .filter((step) => step.decision)
        .map(async (step) => {
          const decision = step.decision!;
          const target = decision.action.elementId
            ? step.perception?.elements.find(({ id }) => id === decision.action.elementId)
            : undefined;
          const targetContainer = decision.action.containerId
            ? step.perception?.containers.find(({ id }) => id === decision.action.containerId)
            : undefined;
          const containers = step.perception?.containers ?? [];
          const elements = step.perception?.elements ?? [];
          return `<article class="step">
            <header><span class="badge blue">Perceive</span><span class="badge amber">Reason / Act</span><span class="badge ${verificationClass(step.verification?.level)}">Verify</span><h2>Step ${step.step}</h2></header>
            <div class="shots"><figure>${await screenshot(step.screenshotBefore, `Step ${step.step} model input`)}<figcaption>Model-input capture</figcaption></figure><figure>${await screenshot(step.screenshotAfter, `Step ${step.step} ${step.action ? 'verification' : 'post-decision'} check`)}<figcaption>${step.action ? 'Verification capture' : 'Post-decision check'}</figcaption></figure></div>
            <div class="grid">
              ${fact('Consent container', containers.length ? containers.map((container) => `${container.role}: ${container.text.slice(0, 180)} · box ${box(container.bounds)}`).join('\n') : 'None detected')}
              ${fact('Dark patterns', decision.darkPatterns.join(', '))}
              ${fact('Decision', decision.summary)}
              ${fact('Confidence', `${Math.round(decision.confidence * 100)}%`)}
              ${fact('Selected tool', toolForAction(decision.action.type))}
              ${fact('Internal target', decision.action.elementId ?? decision.action.containerId ?? decision.action.targets?.map(({ elementId }) => elementId).join(', ') ?? 'None')}
              ${fact('Accessible label', target ? target.name || target.label || 'Unnamed' : targetContainer ? `${targetContainer.role}: ${targetContainer.text.slice(0, 180)}` : 'Not applicable')}
              ${fact('Safety validation', step.safetyValidation ? `${step.safetyValidation.allowed ? 'Allowed' : 'Blocked'} — ${step.safetyValidation.reason}` : 'No page action proposed')}
              ${fact('Action result', step.action ? `${step.action.success ? 'Success' : 'Failed'} — ${step.action.detail}` : 'No action executed')}
              ${fact('Verification', step.verification ? `${step.verification.level}: ${step.verification.evidence.details.join(' ') || 'No supporting evidence.'}` : 'Evaluated in final verification')}
              ${fact('Continue / stop', step.continuation ?? 'Stopped after this decision')}
            </div>
            <details><summary>Relevant elements and bounding boxes (${elements.length})</summary><pre>${escapeHtml(JSON.stringify(elements, null, 2))}</pre></details>
          </article>`;
        }),
    );
    const outcome = report.safetyStops.length
      ? 'Stopped safely'
      : report.verification.level === 'VERIFIED'
        ? 'Privacy result verified'
        : report.verification.level;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${BRAND.wordmark} · ${escapeHtml(this.audit.runId)}</title><style>
      :root{color-scheme:dark;--bg:#07111f;--card:#111d30;--line:#2b3a50;--text:#e6edf7;--muted:#94a3b8;--blue:#38bdf8;--amber:#f59e0b;--green:#22c55e;--red:#ef4444;--gray:#94a3b8}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#07111f,#101827);color:var(--text);font:15px/1.55 system-ui,sans-serif}main{width:min(1200px,calc(100% - 32px));margin:32px auto 80px}h1{font-size:clamp(30px,5vw,56px);margin:.2em 0}h2{margin:8px 0 18px}.eyebrow{color:var(--blue);font-weight:800;letter-spacing:.12em;text-transform:uppercase}.summary,.step,.final{background:rgb(17 29 48 / 94%);border:1px solid var(--line);border-radius:18px;padding:22px;margin:20px 0;box-shadow:0 20px 55px #0004}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.fact{background:#0b1627;border:1px solid #26364c;border-radius:12px;padding:12px;white-space:pre-wrap}.fact b{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.shots figure{margin:0}.shots img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:12px;background:#fff}.shots figcaption{color:var(--muted);margin-top:6px}.badge{display:inline-block;color:#07111f;font-weight:850;font-size:11px;letter-spacing:.08em;text-transform:uppercase;border-radius:999px;padding:4px 8px;margin-right:6px}.blue{background:var(--blue)}.amber{background:var(--amber)}.green{background:var(--green)}.red{background:var(--red);color:white}.gray{background:var(--gray)}details{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;color:var(--blue)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#07111f;padding:14px;border-radius:10px;color:#cbd5e1}.muted{color:var(--muted)}.definitions li{margin:6px 0}@media(max-width:620px){main{width:min(100% - 18px,1200px);margin-top:14px}.summary,.step,.final{padding:15px}.shots{grid-template-columns:1fr}}
    </style></head><body><main><p class="eyebrow">${BRAND.wordmark} audit</p><h1>Chronological run report</h1>
      <section class="summary"><h2>Run summary</h2><div class="grid">
        ${fact('URL', report.url)}${fact('Timestamp', report.startedAt)}${fact('Provider', report.provider)}${fact('Model', report.model ?? 'Not applicable')}${fact('Browser mode', report.mode)}${fact('Display profile', report.displayProfile)}${fact('Viewport', `${report.viewport.width} × ${report.viewport.height}`)}${fact('Final outcome', outcome)}${fact('Verification', report.verification.level)}${fact('Actions', String(report.actions.length))}${fact('Dark patterns', report.darkPatterns.join(', '))}${fact('Duration', `${(durationMs / 1000).toFixed(2)} seconds`)}
      </div></section>
      <section><h2>Chronological steps</h2>${steps.join('\n')}</section>
      <section class="final"><span class="badge ${verificationClass(report.verification.level)}">${escapeHtml(report.verification.level)}</span><h2>Final verification</h2><p>${escapeHtml(report.verification.evidence.details.join(' ') || 'No definitive rejection evidence was available.')}</p><ul class="definitions"><li><b>VERIFIED:</b> rejection evidence persisted after refresh.</li><li><b>LIKELY_VERIFIED:</b> strong rejection evidence exists without complete persistence proof.</li><li><b>UNVERIFIED:</b> the interface changed without enough evidence to prove rejection.</li><li><b>FAILED:</b> evidence indicates consent was accepted or rejection failed.</li><li><b>NOT_APPLICABLE:</b> no consent interface was detected.</li></ul></section>
      <section class="step"><h2>Technical appendix</h2>
        ${details(
          'Sanitized DOM summary',
          this.audit.steps
            .map((step) => ({ step: step.step, page: step.perception }))
            .filter(({ page }) => page),
        )}
        ${details(
          'Structured provider decisions',
          this.audit.steps
            .map((step) => ({ step: step.step, decision: step.decision }))
            .filter(({ decision }) => decision),
        )}
        ${details(
          'Tool-call inputs and results',
          this.audit.steps
            .map((step) => ({ step: step.step, input: step.decision?.action, result: step.action }))
            .filter(({ input }) => input),
        )}
        ${details(
          'Safety validations',
          this.audit.steps
            .map((step) => ({ step: step.step, safety: step.safetyValidation }))
            .filter(({ safety }) => safety),
        )}
        ${details(
          'Perception and model timing',
          this.audit.steps
            .map((step) => ({ step: step.step, telemetry: step.telemetry }))
            .filter(({ telemetry }) => telemetry),
        )}
        ${details('Verification evidence', { final: report.verification, steps: this.audit.steps.map((step) => ({ step: step.step, verification: step.verification })).filter(({ verification }) => verification) })}
        ${details('Errors and warnings', { errors: this.audit.errors, warnings: this.audit.warnings })}
      </section>
    </main></body></html>`;
  }
}

function fact(label: string, value: string): string {
  return `<div class="fact"><b>${escapeHtml(label)}</b>${escapeHtml(value)}</div>`;
}
function details(label: string, value: unknown): string {
  return `<details><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;
}
function box(bounds: { x: number; y: number; width: number; height: number }): string {
  return `x=${bounds.x}, y=${bounds.y}, w=${bounds.width}, h=${bounds.height}`;
}
function toolForAction(action: GuardianDecision['action']['type']): string {
  if (['CLICK_REJECT', 'OPEN_PREFERENCES', 'SAVE_PREFERENCES'].includes(action))
    return 'click_consent_element';
  if (action === 'SET_CONSENT_TOGGLE') return 'set_consent_toggle';
  if (action === 'SET_CONSENT_TOGGLES') return 'set_consent_toggles';
  if (action === 'SCROLL_MODAL') return 'scroll_consent_container';
  if (['STOP_SUCCESS', 'NO_BANNER'].includes(action)) return 'verify_consent_state';
  return 'none';
}
function verificationClass(level: VerificationResult['level'] | undefined): string {
  if (level === 'VERIFIED' || level === 'LIKELY_VERIFIED') return 'green';
  if (level === 'FAILED') return 'red';
  return 'gray';
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return replacements[character] ?? character;
  });
}
function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
