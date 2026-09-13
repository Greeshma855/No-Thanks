import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeUrl } from '../browser/perception.js';
import { BRAND } from '../config/brand.js';

export interface BrowserSessionManifest {
  browserSessionId: string;
  startedAt: string;
  endedAt?: string;
  provider: string;
  model?: string;
  tabs: BrowserTabManifest[];
}

export interface BrowserTabManifest {
  tabId: string;
  openedAt: string;
  closedAt?: string;
  initialUrl: string | null;
  finalUrl?: string | null;
  videoPath?: string;
  auditRunIds: string[];
  auditStatuses: Record<string, 'running' | 'completed' | 'cancelled' | 'failed'>;
}

export class BrowserSessionArtifacts {
  readonly directory: string;
  readonly runsDirectory: string;
  readonly temporaryVideosDirectory: string;
  readonly recordingsDirectory: string;
  readonly manifest: BrowserSessionManifest;
  private writeQueue = Promise.resolve();

  private constructor(root: string, browserSessionId: string, provider: string, model?: string) {
    this.directory = path.resolve(root, browserSessionId);
    this.runsDirectory = path.join(this.directory, 'runs');
    this.temporaryVideosDirectory = path.join(this.directory, 'raw', 'videos-pending');
    this.recordingsDirectory = path.join(this.directory, 'raw', 'recordings');
    this.manifest = {
      browserSessionId,
      startedAt: new Date().toISOString(),
      provider,
      ...(model ? { model } : {}),
      tabs: [],
    };
  }

  static async create(
    root: string,
    browserSessionId: string,
    provider: string,
    model?: string,
  ): Promise<BrowserSessionArtifacts> {
    const artifacts = new BrowserSessionArtifacts(root, browserSessionId, provider, model);
    await Promise.all([
      mkdir(artifacts.runsDirectory, { recursive: true }),
      mkdir(artifacts.temporaryVideosDirectory, { recursive: true }),
      mkdir(artifacts.recordingsDirectory, { recursive: true }),
    ]);
    await artifacts.persist();
    return artifacts;
  }

  async addTab(tabId: string, rawUrl?: string): Promise<void> {
    this.manifest.tabs.push({
      tabId,
      openedAt: new Date().toISOString(),
      initialUrl: normalizeManifestUrl(rawUrl),
      auditRunIds: [],
      auditStatuses: {},
    });
    await this.persist();
  }

  async addAudit(tabId: string, auditRunId: string, rawUrl: string): Promise<void> {
    const tab = this.tab(tabId);
    if (!tab.initialUrl) tab.initialUrl = normalizeManifestUrl(rawUrl);
    tab.finalUrl = normalizeManifestUrl(rawUrl);
    tab.auditRunIds.push(auditRunId);
    tab.auditStatuses[auditRunId] = 'running';
    await this.persist();
  }

  async setAuditStatus(
    tabId: string,
    auditRunId: string,
    status: 'completed' | 'cancelled' | 'failed',
  ): Promise<void> {
    const tab = this.tab(tabId);
    if (!tab.auditRunIds.includes(auditRunId)) tab.auditRunIds.push(auditRunId);
    tab.auditStatuses[auditRunId] = status;
    await this.persist();
  }

  async closeTab(tabId: string, rawUrl: string): Promise<void> {
    const tab = this.tab(tabId);
    tab.closedAt ??= new Date().toISOString();
    tab.finalUrl = normalizeManifestUrl(rawUrl);
    await this.persist();
  }

  async setVideo(tabId: string, relativePath: string): Promise<void> {
    this.tab(tabId).videoPath = relativePath.replaceAll('\\', '/');
    await this.persist();
  }

  async finalize(): Promise<void> {
    this.manifest.endedAt ??= new Date().toISOString();
    await this.persist();
  }

  async cleanupTemporaryVideos(): Promise<void> {
    const target = path.resolve(this.temporaryVideosDirectory);
    const expectedParent = path.resolve(this.directory, 'raw');
    if (path.dirname(target) !== expectedParent || path.basename(target) !== 'videos-pending')
      throw new Error('Refusing to clean an unexpected video directory');
    await rm(target, { recursive: true, force: true });
  }

  async recordAuditFailure(auditRunId: string, message: string): Promise<void> {
    const directory = path.join(this.runsDirectory, auditRunId);
    const reportPath = path.join(directory, 'report.html');
    await mkdir(directory, { recursive: true });
    if (await exists(reportPath)) return;
    await writeFile(
      path.join(directory, 'audit.json'),
      `${JSON.stringify({ schemaVersion: 1, runId: auditRunId, errors: [message] }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      reportPath,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${BRAND.wordmark} · failed audit</title></head><body><main><h1>${escapeHtml(auditRunId)}</h1><p>The audit stopped without taking an uncontrolled action.</p><pre>${escapeHtml(message)}</pre></main></body></html>`,
      'utf8',
    );
  }

  async recordAuditCancellation(auditRunId: string, message: string): Promise<void> {
    const directory = path.join(this.runsDirectory, auditRunId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'audit.json'),
      `${JSON.stringify({ schemaVersion: 1, runId: auditRunId, status: 'cancelled', warnings: [message] }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(directory, 'report.html'),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${BRAND.wordmark} · cancelled audit</title></head><body><main><h1>${escapeHtml(auditRunId)}</h1><p>Audit cancelled because the page navigated or closed.</p><pre>${escapeHtml(message)}</pre></main></body></html>`,
      'utf8',
    );
  }

  private tab(tabId: string): BrowserTabManifest {
    const tab = this.manifest.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) throw new Error(`Unknown manifest tab ${tabId}`);
    return tab;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.manifest, null, 2);
    const html = renderBrowserSessionReport(this.manifest);
    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(path.join(this.directory, 'browser-session.json'), `${snapshot}\n`, 'utf8');
      await writeFile(path.join(this.directory, 'report.html'), html, 'utf8');
    });
    await this.writeQueue;
  }
}

function normalizeManifestUrl(rawUrl?: string): string | null {
  if (!rawUrl || rawUrl === 'about:blank' || /^null\/?$/i.test(rawUrl.trim())) return null;
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return sanitizeUrl(parsed.href);
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function renderBrowserSessionReport(manifest: BrowserSessionManifest): string {
  const tabs = manifest.tabs
    .map((tab) => {
      const statuses = tab.auditStatuses ?? {};
      const primaryRuns = tab.auditRunIds.filter((runId) => statuses[runId] !== 'cancelled');
      const cancelledRuns = tab.auditRunIds.filter((runId) => statuses[runId] === 'cancelled');
      const runs = primaryRuns.length
        ? `<ul>${primaryRuns
            .map(
              (runId) =>
                `<li><a href="runs/${encodeURIComponent(runId)}/report.html">${escapeHtml(runId)}</a> · ${escapeHtml(statuses[runId] ?? 'completed')}</li>`,
            )
            .join('')}</ul>`
        : '<p>No audit runs.</p>';
      const cancelled = cancelledRuns.length
        ? `<details><summary>Cancelled navigation audits (${cancelledRuns.length})</summary><p>Retained for debugging; these are not failed consent attempts.</p><ul>${cancelledRuns
            .map(
              (runId) =>
                `<li><a href="runs/${encodeURIComponent(runId)}/report.html">${escapeHtml(runId)}</a></li>`,
            )
            .join('')}</ul></details>`
        : '';
      const video = tab.videoPath
        ? `<a href="${escapeAttribute(tab.videoPath)}">Open continuous tab recording</a>`
        : '<span>Finalizes after the tab or browser closes.</span>';
      return `<article><h2>${escapeHtml(tab.tabId)}</h2><dl><dt>Opened</dt><dd>${escapeHtml(tab.openedAt)}</dd><dt>Initial URL</dt><dd>${escapeHtml(tab.initialUrl ?? 'about:blank')}</dd><dt>Final URL</dt><dd>${escapeHtml(tab.finalUrl ?? 'Open')}</dd><dt>Recording</dt><dd>${video}</dd></dl><h3>Audit runs</h3>${runs}${cancelled}</article>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${BRAND.wordmark} browser session</title><style>:root{color-scheme:dark}body{margin:0;background:#07111f;color:#e6edf7;font:15px/1.5 system-ui,sans-serif}main{width:min(1050px,calc(100% - 32px));margin:32px auto}header,article{background:#111d30;border:1px solid #2b3a50;border-radius:16px;padding:20px;margin:16px 0}h1{margin:.2em 0}dl{display:grid;grid-template-columns:120px 1fr;gap:7px}dt{color:#94a3b8}dd{margin:0;overflow-wrap:anywhere}a{color:#38bdf8}</style></head><body><main><header><p>${BRAND.wordmark}</p><h1>Browser session ${escapeHtml(manifest.browserSessionId)}</h1><p>${BRAND.tagline}</p><p>Provider: ${escapeHtml(manifest.provider)}${manifest.model ? ` · ${escapeHtml(manifest.model)}` : ''}</p><p>Started: ${escapeHtml(manifest.startedAt)} · Ended: ${escapeHtml(manifest.endedAt ?? 'Browser still open')}</p></header>${tabs || '<article>No tabs were registered.</article>'}</main></body></html>`;
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
