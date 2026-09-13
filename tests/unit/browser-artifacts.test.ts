import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserSessionArtifacts } from '../../src/logging/browser-session-artifacts.js';

describe('browser session manifest', () => {
  it('records tabs, navigation runs, finalized video links, and graceful completion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'guardian-manifest-'));
    const artifacts = await BrowserSessionArtifacts.create(root, 'browser-session-test', 'mock');
    await artifacts.addTab('tab-001', 'about:blank');
    await artifacts.addTab('tab-002', 'null/');
    await artifacts.addAudit('tab-001', 'audit-0001', 'https://example.test/path?token=secret');
    await artifacts.setAuditStatus('tab-001', 'audit-0001', 'completed');
    await artifacts.setVideo('tab-001', 'raw/recordings/tab-001.webm');
    await artifacts.closeTab('tab-001', 'https://example.test/final?private=yes');
    await writeFile(path.join(artifacts.temporaryVideosDirectory, 'redundant.webm'), 'pending');
    await artifacts.cleanupTemporaryVideos();
    await artifacts.finalize();
    const manifest = JSON.parse(
      await readFile(path.join(artifacts.directory, 'browser-session.json'), 'utf8'),
    ) as { endedAt?: string; tabs: Array<Record<string, unknown>> };
    expect(manifest.endedAt).toBeTruthy();
    expect(manifest.tabs[0]).toMatchObject({
      tabId: 'tab-001',
      initialUrl: 'https://example.test/path',
      finalUrl: 'https://example.test/final',
      videoPath: 'raw/recordings/tab-001.webm',
      auditRunIds: ['audit-0001'],
      auditStatuses: { 'audit-0001': 'completed' },
    });
    expect(manifest.tabs[1]).toMatchObject({
      tabId: 'tab-002',
      initialUrl: null,
      auditRunIds: [],
    });
    await expect(access(artifacts.temporaryVideosDirectory)).rejects.toThrow();
    const html = await readFile(path.join(artifacts.directory, 'report.html'), 'utf8');
    expect(html).toContain('NO, THANKS.');
    expect(html).toContain('Privacy without the consent maze.');
    expect(html).not.toContain('Dark-Pattern Guardian');
    expect(html).toContain('runs/audit-0001/report.html');
    expect(html).toContain('raw/recordings/tab-001.webm');
    expect(html).not.toContain('token=secret');
  });

  it('separates cancelled navigation audits from consent attempts in the session report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'guardian-cancelled-manifest-'));
    const artifacts = await BrowserSessionArtifacts.create(root, 'browser-session-cancel', 'mock');
    await artifacts.addTab('tab-001', 'https://example.test');
    await artifacts.addAudit('tab-001', 'audit-0001', 'https://example.test');
    await artifacts.recordAuditCancellation('audit-0001', 'navigation changed');
    await artifacts.setAuditStatus('tab-001', 'audit-0001', 'cancelled');
    const html = await readFile(path.join(artifacts.directory, 'report.html'), 'utf8');
    expect(html).toContain('Cancelled navigation audits (1)');
    expect(html).toContain('not failed consent attempts');
  });
});
