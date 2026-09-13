import type { Page } from 'playwright';
import type { PageState, VerificationLevel } from '../domain/types.js';

export type InspectorTone = 'blue' | 'amber' | 'green' | 'red' | 'gray';
export type InspectorPhase = 'Perceive' | 'Reason' | 'Act' | 'Verify';

export interface InspectorView {
  phase: InspectorPhase;
  tone: InspectorTone;
  step: number;
  darkPatterns?: string[];
  summary?: string;
  tool?: string;
  targetId?: string;
  targetLabel?: string;
  confidence?: number;
  result?: string;
  verification?: VerificationLevel;
}

export async function updateInspectorOverlay(
  page: Page,
  state: PageState,
  view: InspectorView,
): Promise<void> {
  await page.evaluate(
    ({ elements, view }) => {
      let root = document.querySelector<HTMLElement>('#guardian-inspector-overlay');
      if (!root) {
        root = document.createElement('div');
        root.id = 'guardian-inspector-overlay';
        root.setAttribute('aria-hidden', 'true');
        root.style.cssText =
          'all:initial;position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;contain:strict;display:block';
        root.attachShadow({ mode: 'open' });
        document.documentElement.appendChild(root);
      }
      const shadow = root.shadowRoot;
      if (!shadow) return;
      shadow.replaceChildren();
      const colors = {
        blue: '#38bdf8',
        amber: '#f59e0b',
        green: '#22c55e',
        red: '#ef4444',
        gray: '#94a3b8',
      } as const;
      const color = colors[view.tone];
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .box { position: fixed; border: 2px solid #38bdf8; border-radius: 6px; box-shadow: 0 0 0 2px rgb(15 23 42 / 55%); }
        .box.selected { border-width: 4px; border-color: ${color}; box-shadow: 0 0 0 4px rgb(15 23 42 / 70%), 0 0 24px ${color}; }
        .tag { position: absolute; left: -2px; top: -24px; white-space: nowrap; padding: 3px 7px; border-radius: 5px 5px 5px 0; background: #0284c7; color: white; font: 600 12px/18px ui-monospace, monospace; }
        .selected .tag { background: ${color}; color: #07111f; }
        .panel { position: fixed; top: 18px; right: 18px; width: min(390px, calc(100vw - 36px)); padding: 16px 18px; border: 1px solid ${color}; border-left-width: 5px; border-radius: 14px; background: rgb(15 23 42 / 90%); color: #f8fafc; box-shadow: 0 18px 48px rgb(0 0 0 / 35%); backdrop-filter: blur(12px); font: 13px/1.45 system-ui, sans-serif; }
        .phase { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 9px; color: ${color}; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
        .row { display: grid; grid-template-columns: 92px 1fr; gap: 9px; margin-top: 5px; }
        .key { color: #94a3b8; } .value { color: #f8fafc; overflow-wrap: anywhere; }
        @media (max-width: 700px), (max-height: 520px) {
          .panel { top: auto; right: 10px; bottom: 10px; width: min(520px, calc(100vw - 20px)); max-height: 42vh; overflow: hidden; padding: 10px 12px; border-radius: 10px; }
          .phase { margin-bottom: 4px; } .row { grid-template-columns: 78px 1fr; margin-top: 2px; font-size: 11px; line-height: 1.25; }
        }
      `;
      shadow.appendChild(style);
      for (const element of elements) {
        const box = document.createElement('div');
        const selected = element.id === view.targetId;
        box.className = `box${selected ? ' selected' : ''}`;
        box.style.left = `${element.bounds.x}px`;
        box.style.top = `${element.bounds.y}px`;
        box.style.width = `${element.bounds.width}px`;
        box.style.height = `${element.bounds.height}px`;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = element.id;
        box.appendChild(tag);
        shadow.appendChild(box);
      }
      const panel = document.createElement('section');
      panel.className = 'panel';
      const heading = document.createElement('div');
      heading.className = 'phase';
      const phase = document.createElement('span');
      phase.textContent = view.phase;
      const step = document.createElement('span');
      step.textContent = `Step ${view.step}`;
      heading.append(phase, step);
      panel.appendChild(heading);
      const rows: Array<[string, string | undefined]> = [
        ['Pattern', view.darkPatterns?.join(', ')],
        ['Decision', view.summary],
        ['Tool', view.tool],
        [
          'Target',
          view.targetId ? `${view.targetId} · ${view.targetLabel || 'unnamed'}` : undefined,
        ],
        [
          'Confidence',
          view.confidence === undefined ? undefined : `${Math.round(view.confidence * 100)}%`,
        ],
        ['Result', view.result],
        ['Verification', view.verification],
      ];
      for (const [key, value] of rows) {
        if (!value) continue;
        const row = document.createElement('div');
        row.className = 'row';
        const keyNode = document.createElement('span');
        keyNode.className = 'key';
        keyNode.textContent = key;
        const valueNode = document.createElement('span');
        valueNode.className = 'value';
        valueNode.textContent = value;
        row.append(keyNode, valueNode);
        panel.appendChild(row);
      }
      shadow.appendChild(panel);
    },
    { elements: state.elements, view },
  );
}

export async function removeInspectorOverlay(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector('#guardian-inspector-overlay')?.remove());
}
