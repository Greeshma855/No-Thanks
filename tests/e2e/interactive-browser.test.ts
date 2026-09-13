import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { InteractiveBrowserSession } from '../../src/browser/interactive-browser.js';
import { BrowserSession } from '../../src/browser/browser-session.js';
import { loadConfig } from '../../src/config/env.js';
import { createFixtureServer } from '../../src/fixtures/server.js';
import { MockProvider } from '../../src/providers/mock-provider.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  ({ server, url: baseUrl } = await createFixtureServer());
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('persistent interactive browser', () => {
  it('starts a new audit and rejects a late banner without another navigation', async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'guardian-late-browser-e2e-'));
    const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'guardian-late-profile-e2e-'));
    const config = loadConfig({
      MODEL_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifactRoot,
      BROWSER_SLOW_MO_MS: '0',
      CONSENT_DISCOVERY_MAX_MS: '100',
      CONSENT_DISCOVERY_POLL_MS: '25',
    });
    const browser = new InteractiveBrowserSession(config, new MockProvider(), {
      profileDirectory,
      headlessOverride: true,
      navigationDebounceMs: 10,
      stabilizationMs: 10,
    });
    await browser.start();
    const page = browser.pages()[0]!;
    await page.goto(`${baseUrl}/delayed-banner?delay=800`, { waitUntil: 'domcontentloaded' });
    await browser.waitForIdle();
    await page.waitForFunction(() => document.body.dataset.consentState === 'rejected', undefined, {
      timeout: 8_000,
    });
    await browser.waitForIdle();
    await page.close();
    await browser.shutdown();
    await browser.finish();

    const sessionName = (await readdir(artifactRoot)).find((name) =>
      name.startsWith('browser-session-'),
    );
    const manifest = JSON.parse(
      await readFile(path.join(artifactRoot, sessionName!, 'browser-session.json'), 'utf8'),
    ) as { tabs: Array<{ auditRunIds: string[] }> };
    expect(manifest.tabs[0]?.auditRunIds).toHaveLength(2);
    const secondAudit = JSON.parse(
      await readFile(
        path.join(artifactRoot, sessionName!, 'runs', 'audit-0002', 'audit.json'),
        'utf8',
      ),
    ) as { report: { actions: Array<{ action: string }>; finalBannerDetected: boolean } };
    expect(secondAudit.report.actions.map(({ action }) => action)).toContain('CLICK_REJECT');
    expect(secondAudit.report.finalBannerDetected).toBe(false);
  }, 20_000);

  it('registers tabs and navigation runs, then finalizes recordings and the manifest', async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'guardian-browser-e2e-'));
    const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'guardian-profile-e2e-'));
    const config = loadConfig({
      MODEL_PROVIDER: 'mock',
      GUARDIAN_ARTIFACT_DIR: artifactRoot,
      BROWSER_SLOW_MO_MS: '0',
      CONSENT_DISCOVERY_MAX_MS: '300',
      CONSENT_DISCOVERY_POLL_MS: '50',
    });
    const browser = new InteractiveBrowserSession(config, new MockProvider(), {
      profileDirectory,
      headlessOverride: true,
      navigationDebounceMs: 10,
      stabilizationMs: 10,
    });
    await browser.start();
    const first = browser.pages()[0];
    expect(first).toBeTruthy();
    await first!.goto(`${baseUrl}/visible-reject`, { waitUntil: 'domcontentloaded' });
    await browser.waitForIdle();
    const second = await browser.openTab(`${baseUrl}/preselected-toggles`);
    await browser.waitForIdle();
    await first!.goto(`${baseUrl}/nested-settings`, { waitUntil: 'domcontentloaded' });
    await browser.waitForIdle();
    await second.close();
    await first!.close();
    await browser.shutdown();
    await browser.finish();

    const sessionName = (await readdir(artifactRoot)).find((name) =>
      name.startsWith('browser-session-'),
    );
    expect(sessionName).toBeTruthy();
    const sessionDirectory = path.join(artifactRoot, sessionName!);
    const manifest = JSON.parse(
      await readFile(path.join(sessionDirectory, 'browser-session.json'), 'utf8'),
    ) as {
      endedAt?: string;
      tabs: Array<{ tabId: string; videoPath?: string; auditRunIds: string[] }>;
    };
    expect(manifest.endedAt).toBeTruthy();
    expect(manifest.tabs.map(({ tabId }) => tabId)).toEqual(['tab-001', 'tab-002']);
    expect(manifest.tabs[0]?.auditRunIds).toHaveLength(2);
    expect(manifest.tabs[1]?.auditRunIds).toHaveLength(1);
    for (const tab of manifest.tabs) {
      expect(tab.videoPath).toBeTruthy();
      expect((await stat(path.join(sessionDirectory, tab.videoPath!))).size).toBeGreaterThan(0);
    }
    await expect(access(path.join(sessionDirectory, 'raw', 'videos-pending'))).rejects.toThrow();
    const report = await readFile(path.join(sessionDirectory, 'report.html'), 'utf8');
    expect(report).toContain('audit-0001');
    expect(report).toContain('audit-0002');
    expect(report).toContain('audit-0003');
    expect(report).toContain(manifest.tabs[0]!.videoPath!);
    expect(report).toContain(manifest.tabs[1]!.videoPath!);
  }, 30_000);

  it('masks private fields and downsizes remote screenshots without changing form values', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.setContent(
      '<style>body{margin:0;background:white}input{position:absolute;left:100px;top:100px;width:400px;height:80px;font-size:30px}</style><input type="email" value="secret@example.com">',
    );
    const session = new BrowserSession({
      mode: 'guardian',
      viewport: { width: 1440, height: 900 },
      slowMoMs: 0,
      artifactDirectory: await mkdtemp(path.join(os.tmpdir(), 'guardian-shot-e2e-')),
      recordVideo: false,
      recordTrace: false,
      attachedPage: page,
      allowCrossOriginNavigation: true,
    });
    await session.start();
    const jpeg = await session.screenshotForModel(1280, 75);
    const decoded = await page.evaluate(async (base64) => {
      const source = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([source], { type: 'image/jpeg' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const drawing = canvas.getContext('2d')!;
      drawing.drawImage(bitmap, 0, 0);
      const pixel = [...drawing.getImageData(267, 124, 1, 1).data];
      return { width: bitmap.width, height: bitmap.height, pixel };
    }, jpeg.toString('base64'));
    expect(decoded.width).toBe(1280);
    expect(decoded.height).toBe(800);
    expect(decoded.pixel[0]).toBeGreaterThan(85);
    expect(decoded.pixel[0]).toBeLessThan(135);
    expect(await page.locator('input').inputValue()).toBe('secret@example.com');
    await session.close();
    await context.close();
    await browser.close();
  });
});
