import { createHash } from 'node:crypto';
import type { Frame, Page } from 'playwright';
import type { ConsentContainer, ConsentElement, ConsentFrame, PageState } from '../domain/types.js';

interface FrameSnapshot {
  containers: ConsentContainer[];
  elements: ConsentElement[];
  sanitizedText: string;
  fixtureState?: string;
}
interface FrameSnapshotArgs {
  frameIndex: number;
  frameUrl: string;
  containerOffset: number;
  elementOffset: number;
  candidateSelector: string;
  interactiveSelector: string;
}

const candidateSelector =
  '[role="dialog"], [aria-modal="true"], [data-cookie-banner], [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="privacy" i], [id*="privacy" i]';
const interactiveSelector =
  'button, input, select, a[href], [role="button"], [role="switch"], [role="checkbox"], [aria-checked], button[aria-pressed]';

export async function perceivePage(page: Page): Promise<PageState> {
  const title = await page.title();
  const frames = page.frames();
  const frameRecords: ConsentFrame[] = [];
  const containers: ConsentContainer[] = [];
  const elements: ConsentElement[] = [];
  const texts: string[] = [];
  let fixtureState: string | undefined;
  for (const [frameIndex, frame] of frames.entries()) {
    const frameUrl = sanitizeUrl(frame.url());
    const record: ConsentFrame = {
      index: frameIndex,
      url: frameUrl,
      name: cleanNodeText(frame.name(), 160),
      accessible: true,
    };
    try {
      const snapshot = await captureFrame(frame, {
        frameIndex,
        frameUrl,
        containerOffset: frameIndex * 1_000,
        elementOffset: frameIndex * 1_000,
        candidateSelector,
        interactiveSelector,
      });
      containers.push(...snapshot.containers);
      elements.push(...snapshot.elements);
      if (snapshot.sanitizedText) texts.push(snapshot.sanitizedText);
      if (frameIndex === 0 && snapshot.fixtureState) fixtureState = snapshot.fixtureState;
    } catch {
      record.accessible = false;
    }
    frameRecords.push(record);
  }
  return {
    url: sanitizeUrl(page.url()),
    title: cleanNodeText(title, 300),
    capturedAt: new Date().toISOString(),
    bannerDetected: containers.length > 0,
    frames: frameRecords,
    containers,
    elements,
    sanitizedText: cleanNodeText(texts.join(' | '), 5000),
    ...(fixtureState ? { fixtureState } : {}),
  };
}

export async function detectConsentCandidate(page: Page): Promise<boolean> {
  const results = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(
          ({ candidate, interactive }) => {
            const all: Element[] = [];
            const visit = (root: Document | ShadowRoot | Element): void => {
              const children =
                root instanceof Document
                  ? root.documentElement
                    ? [root.documentElement]
                    : []
                  : Array.from(root.children);
              for (const child of children) {
                all.push(child);
                if (child.shadowRoot) visit(child.shadowRoot);
                visit(child);
              }
            };
            visit(document);
            const visible = (element: Element): boolean => {
              if (!(element instanceof HTMLElement)) return false;
              const style = getComputedStyle(element);
              const bounds = element.getBoundingClientRect();
              return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity) > 0 &&
                bounds.width > 0 &&
                bounds.height > 0 &&
                bounds.right > 0 &&
                bounds.bottom > 0 &&
                bounds.left < innerWidth &&
                bounds.top < innerHeight
              );
            };
            if (
              all.some(
                (element) =>
                  element.matches(candidate) &&
                  visible(element) &&
                  /cookie|consent|privacy|tracking|preferences/i.test(element.textContent ?? ''),
              )
            )
              return true;
            const actionText = all
              .filter((element) => element.matches(interactive) && visible(element))
              .map(
                (element) =>
                  element.getAttribute('aria-label') ??
                  (element instanceof HTMLInputElement ? element.value : element.textContent) ??
                  '',
              )
              .join(' ');
            return (
              /cookie|consent|privacy|tracking/i.test(document.body?.innerText ?? '') &&
              /accept|allow|agree|reject|decline|no thanks|manage|preferences/i.test(actionText)
            );
          },
          { candidate: candidateSelector, interactive: interactiveSelector },
        )
        .catch(() => false),
    ),
  );
  return results.some(Boolean);
}

export function compactState(state: PageState): object {
  return {
    url: state.url,
    title: state.title,
    bannerDetected: state.bannerDetected,
    frames: state.frames,
    containers: state.containers,
    elements: state.elements,
    sanitizedText: state.sanitizedText,
    fixtureState: state.fixtureState,
  };
}

export function consentStateFingerprint(state: PageState): string {
  const normalize = (value: string | undefined): string =>
    (value ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const activeFrameUrls = [
    ...new Set([
      ...state.containers.map(({ frameUrl }) => frameUrl),
      ...state.elements.map(({ frameUrl }) => frameUrl),
    ]),
  ].sort();
  const evidence = {
    activeStage: !state.bannerDetected
      ? 'none'
      : state.elements.some(
            ({ kind, name, label }) =>
              ['checkbox', 'switch'].includes(kind) ||
              /\b(save|confirm|apply)\b/i.test(`${name} ${label}`),
          )
        ? 'preferences'
        : 'banner',
    activeFrameUrls,
    containers: state.containers
      .map(({ role, text, frameUrl, scrollable }) => ({
        role: normalize(role),
        text: normalize(text).slice(0, 800),
        frameUrl,
        scrollable,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    elements: state.elements
      .map(({ role, name, label, categoryLabel, checked, ariaChecked, disabled, kind, href }) => ({
        role: normalize(role),
        kind,
        name: normalize(name),
        label: normalize(label),
        categoryLabel: normalize(categoryLabel),
        checked,
        ariaChecked,
        disabled,
        ...(href ? { href } : {}),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl.split(/[?#]/, 1)[0] ?? '';
  }
}

async function captureFrame(frame: Frame, args: FrameSnapshotArgs): Promise<FrameSnapshot> {
  return frame.evaluate<FrameSnapshot, FrameSnapshotArgs>((input) => {
    const clean = (value: string | null | undefined, max = 500): string =>
      (value ?? '')
        // eslint-disable-next-line no-control-regex -- strip control bytes before audit/model use
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
    const all: Element[] = [];
    const visit = (root: Document | ShadowRoot | Element): void => {
      const children =
        root instanceof Document
          ? root.documentElement
            ? [root.documentElement]
            : []
          : Array.from(root.children);
      for (const child of children) {
        all.push(child);
        if (child.shadowRoot) visit(child.shadowRoot);
        visit(child);
      }
    };
    visit(document);
    const parentOf = (element: Element): Element | null => {
      if (element.parentElement) return element.parentElement;
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    };
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.closest('[aria-hidden="true"]'))
        return false;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) <= 0 ||
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        bounds.right <= 0 ||
        bounds.bottom <= 0 ||
        bounds.left >= innerWidth ||
        bounds.top >= innerHeight
      )
        return false;
      let parent = parentOf(element);
      while (parent && parent !== document.documentElement) {
        const parentStyle = getComputedStyle(parent);
        if (/hidden|clip|auto|scroll/.test(`${parentStyle.overflowX} ${parentStyle.overflowY}`)) {
          const parentBounds = parent.getBoundingClientRect();
          if (
            bounds.right <= parentBounds.left ||
            bounds.left >= parentBounds.right ||
            bounds.bottom <= parentBounds.top ||
            bounds.top >= parentBounds.bottom
          )
            return false;
        }
        parent = parentOf(parent);
      }
      return true;
    };
    const rendered = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.hidden) return false;
      let current: Element | null = element;
      while (current) {
        const style = getComputedStyle(current);
        if (
          current.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        )
          return false;
        current = parentOf(current);
      }
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    };
    const containsComposed = (container: Element, element: Element): boolean => {
      let current: Element | null = element;
      while (current) {
        if (current === container) return true;
        current = parentOf(current);
      }
      return false;
    };
    const boundsOf = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      };
    };
    const textOf = (element: Element): string =>
      clean(
        `${element instanceof HTMLElement ? element.innerText : (element.textContent ?? '')} ${element.shadowRoot?.textContent ?? ''}`,
        2400,
      );
    const isScrollable = (element: Element): boolean => {
      if (!(element instanceof HTMLElement)) return false;
      return (
        element.scrollHeight > element.clientHeight + 2 &&
        /auto|scroll|overlay/i.test(getComputedStyle(element).overflowY)
      );
    };
    const visibleControls = all
      .filter((element) => element.matches(input.interactiveSelector))
      .filter(visible);
    let candidates = all
      .filter((element) => element.matches(input.candidateSelector))
      .filter(visible)
      .filter((element) =>
        /cookie|consent|privacy|tracking|preferences/i.test(
          `${textOf(element)} ${element.getAttribute('aria-label') ?? ''}`,
        ),
      )
      .filter(
        (element, index, matches) =>
          !matches.some(
            (other, otherIndex) =>
              otherIndex !== index &&
              other.contains(element) &&
              textOf(other).length < textOf(element).length * 1.4,
          ),
      )
      .slice(0, 8);
    const modalCandidates = candidates.filter(
      (element) => element.getAttribute('aria-modal') === 'true',
    );
    if (modalCandidates.length > 0) candidates = modalCandidates;
    if (candidates.length === 0 && document.body && visible(document.body)) {
      const actionText = visibleControls
        .map(
          (element) =>
            element.getAttribute('aria-label') ??
            (element instanceof HTMLInputElement ? element.value : element.textContent) ??
            '',
        )
        .join(' ');
      if (
        /cookie|consent|privacy|tracking/i.test(document.body.innerText) &&
        /accept|allow|agree|reject|decline|no thanks|manage|preferences/i.test(actionText)
      )
        candidates = [document.body];
    }

    const consentActionPattern =
      /accept|allow|agree|reject|decline|deny|no thanks|manage|preferences|save|confirm/i;
    const expandConsentRoot = (candidate: Element): Element => {
      let root = candidate;
      let ancestor = parentOf(candidate);
      for (
        let depth = 0;
        ancestor && ancestor !== document.documentElement && depth < 6;
        depth += 1
      ) {
        if (ancestor === document.body) break;
        const marker = `${ancestor.id} ${ancestor.className} ${ancestor.getAttribute('role') ?? ''}`;
        const hasConsentText = /cookie|consent|privacy|tracking|preferences/i.test(
          `${marker} ${textOf(ancestor)}`,
        );
        const hasConsentAction = all.some(
          (element) =>
            containsComposed(ancestor!, element) &&
            element.matches(input.interactiveSelector) &&
            visible(element) &&
            consentActionPattern.test(
              `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`,
            ),
        );
        const style = getComputedStyle(ancestor);
        if (
          hasConsentText &&
          hasConsentAction &&
          (ancestor.matches(input.candidateSelector) ||
            ['fixed', 'sticky'].includes(style.position) ||
            root === candidate)
        )
          root = ancestor;
        ancestor = parentOf(ancestor);
      }
      return root;
    };
    const primaryRoots = [...new Set(candidates.map(expandConsentRoot))];
    const siblingActionRoots = all.filter((element) => {
      const parent = parentOf(element);
      if (!parent || !primaryRoots.some((root) => parentOf(root) === parent)) return false;
      const style = getComputedStyle(element);
      if (!['fixed', 'sticky'].includes(style.position) || !rendered(element)) return false;
      const actionCount = all.filter(
        (control) =>
          containsComposed(element, control) &&
          control.matches(input.interactiveSelector) &&
          visible(control) &&
          consentActionPattern.test(
            `${control.getAttribute('aria-label') ?? ''} ${control.textContent ?? ''}`,
          ),
      ).length;
      return actionCount >= 2;
    });
    const surfaceRoots = [...new Set([...primaryRoots, ...siblingActionRoots])].filter(
      (candidate, index, roots) =>
        !roots.some(
          (other, otherIndex) => index !== otherIndex && containsComposed(other, candidate),
        ),
    );
    const withinSurface = (element: Element): boolean =>
      surfaceRoots.some((root) => containsComposed(root, element));
    const containerElements: Element[] = [...surfaceRoots];
    for (const element of all) {
      if (isScrollable(element) && withinSurface(element) && !containerElements.includes(element))
        containerElements.push(element);
    }
    const containerIds = new Map<Element, string>();
    let containerIndex = Math.max(
      input.containerOffset,
      ...all.map((element) =>
        Number(element.getAttribute('data-guardian-container-id')?.match(/\d+$/)?.[0] ?? 0),
      ),
    );
    const containers = containerElements.map((element) => {
      const existingId = element.getAttribute('data-guardian-container-id');
      const id = /^guardian-container-\d+$/.test(existingId ?? '')
        ? existingId!
        : `guardian-container-${(containerIndex += 1)}`;
      containerIds.set(element, id);
      element.setAttribute('data-guardian-container-id', id);
      const html = element as HTMLElement;
      return {
        id,
        role: element.getAttribute('role') ?? (isScrollable(element) ? 'scroll-region' : 'region'),
        text: textOf(element),
        bounds: boundsOf(element),
        frameIndex: input.frameIndex,
        frameUrl: input.frameUrl,
        scrollTop: Math.round(html.scrollTop),
        scrollHeight: Math.round(html.scrollHeight),
        clientHeight: Math.round(html.clientHeight),
        scrollable: isScrollable(element),
      };
    });
    const associatedContainer = (element: Element): Element => {
      let ancestor: Element | null = element;
      while (ancestor) {
        if (containerIds.has(ancestor) && isScrollable(ancestor)) return ancestor;
        ancestor = parentOf(ancestor);
      }
      return surfaceRoots.find((root) => containsComposed(root, element))!;
    };
    const referencedText = (element: Element): string => {
      const root = element.getRootNode();
      return clean(
        (element.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) =>
            root instanceof ShadowRoot
              ? (root.getElementById(id)?.textContent ?? '')
              : (document.getElementById(id)?.textContent ?? ''),
          )
          .join(' '),
        240,
      );
    };
    const labelText = (element: Element): string => {
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
        const labels = Array.from(element.labels ?? [])
          .map((label) => label.innerText)
          .join(' ');
        if (labels) return clean(labels, 240);
      }
      return clean(element.closest('label')?.textContent, 240);
    };
    const headingText = (element: Element, boundary: Element): string => {
      const sibling = element.previousElementSibling;
      if (sibling?.matches('h1, h2, h3, h4, h5, h6, [role="heading"]'))
        return clean(sibling.textContent, 240);
      let parent = parentOf(element);
      for (let depth = 0; parent && parent !== boundary && depth < 3; depth += 1) {
        const heading = Array.from(parent.children).find((child) =>
          child.matches('h1, h2, h3, h4, h5, h6, [role="heading"]'),
        );
        if (heading && parent.querySelectorAll(input.interactiveSelector).length === 1)
          return clean(heading.textContent, 240);
        parent = parentOf(parent);
      }
      return '';
    };

    const categoryText = (element: Element, boundary: Element): string => {
      let row: Element | null = element;
      for (let depth = 0; row && row !== boundary && depth < 6; depth += 1) {
        const heading = row.querySelector(
          'h1, h2, h3, h4, h5, h6, legend, [role="heading"], button[aria-controls]',
        );
        const headingValue = heading ? clean(textOf(heading), 240) : '';
        if (headingValue && !/^(on|off|enabled|disabled)$/i.test(headingValue)) return headingValue;
        row = parentOf(row);
      }
      return headingText(element, boundary);
    };
    const semanticToggle = (element: Element): boolean =>
      (element instanceof HTMLInputElement && element.type === 'checkbox') ||
      ['switch', 'checkbox'].includes(element.getAttribute('role') ?? '') ||
      element.hasAttribute('aria-checked') ||
      (element instanceof HTMLButtonElement && element.hasAttribute('aria-pressed'));
    const semanticElements = all.filter(semanticToggle).filter(withinSurface);
    const isVisualProxy = (element: Element): boolean =>
      (element.getAttribute('aria-controls') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .some((id) => semanticElements.some((candidate) => candidate.id === id));
    const proxyFor = (stateElement: Element): Element | undefined => {
      if (stateElement instanceof HTMLInputElement) {
        const label = Array.from(stateElement.labels ?? []).find(rendered);
        if (label) return label;
      }
      const enclosingLabel = stateElement.closest('label');
      if (enclosingLabel && rendered(enclosingLabel)) return enclosingLabel;
      if (stateElement.id) {
        const controlledBy = all.find(
          (candidate) =>
            withinSurface(candidate) &&
            rendered(candidate) &&
            (candidate.getAttribute('aria-controls') ?? '').split(/\s+/).includes(stateElement.id),
        );
        if (controlledBy) return controlledBy;
      }
      return rendered(stateElement) ? stateElement : undefined;
    };
    const semanticRecords = semanticElements
      .filter((element) => !isVisualProxy(element))
      .map((stateElement) => ({ stateElement, clickElement: proxyFor(stateElement) }))
      .filter(
        (record): record is { stateElement: Element; clickElement: Element } =>
          record.clickElement !== undefined,
      );
    const claimedElements = new Set(
      semanticRecords.flatMap(({ stateElement, clickElement }) => [stateElement, clickElement]),
    );
    const ordinaryRecords = all
      .filter((element) => element.matches(input.interactiveSelector))
      .filter(withinSurface)
      .filter(rendered)
      .filter((element) => !claimedElements.has(element))
      .map((element) => ({ stateElement: element, clickElement: element }));
    const controlRecords = [...semanticRecords, ...ordinaryRecords].slice(0, 120);
    let elementIndex = Math.max(
      input.elementOffset,
      ...all.flatMap((element) =>
        ['data-guardian-id', 'data-guardian-state-id'].map((attribute) =>
          Number(element.getAttribute(attribute)?.match(/\d+$/)?.[0] ?? 0),
        ),
      ),
    );
    const elements = surfaceRoots.length
      ? controlRecords.map(({ stateElement, clickElement: element }) => {
          const container = associatedContainer(element);
          const existingId =
            element.getAttribute('data-guardian-id') ??
            stateElement.getAttribute('data-guardian-state-id');
          const id = /^guardian-element-\d+$/.test(existingId ?? '')
            ? existingId!
            : `guardian-element-${(elementIndex += 1)}`;
          element.setAttribute('data-guardian-id', id);
          stateElement.setAttribute('data-guardian-state-id', id);
          const inputElement = stateElement instanceof HTMLInputElement ? stateElement : undefined;
          const select = stateElement instanceof HTMLSelectElement ? stateElement : undefined;
          const button = stateElement instanceof HTMLButtonElement ? stateElement : undefined;
          const ariaValue =
            stateElement.getAttribute('aria-checked') ??
            (button?.hasAttribute('aria-pressed')
              ? button.getAttribute('aria-pressed')
              : undefined);
          const ariaChecked = ['true', 'false', 'mixed'].includes(ariaValue ?? '')
            ? (ariaValue as 'true' | 'false' | 'mixed')
            : undefined;
          const checked =
            inputElement && ['checkbox', 'radio'].includes(inputElement.type)
              ? inputElement.checked
              : ariaChecked === 'true'
                ? true
                : ariaChecked === 'false'
                  ? false
                  : undefined;
          const role =
            stateElement.getAttribute('role') ??
            (button?.hasAttribute('aria-pressed')
              ? 'switch'
              : stateElement instanceof HTMLAnchorElement
                ? 'link'
                : select
                  ? 'combobox'
                  : inputElement?.type === 'checkbox'
                    ? 'checkbox'
                    : inputElement?.type === 'radio'
                      ? 'radio'
                      : inputElement && ['button', 'submit', 'reset'].includes(inputElement.type)
                        ? 'button'
                        : inputElement
                          ? 'textbox'
                          : 'button');
          const kind: ConsentElement['kind'] =
            role === 'switch' || button?.hasAttribute('aria-pressed')
              ? 'switch'
              : role === 'checkbox' || inputElement?.type === 'checkbox'
                ? 'checkbox'
                : stateElement instanceof HTMLAnchorElement
                  ? 'link'
                  : select
                    ? 'select'
                    : inputElement && !['button', 'submit', 'reset'].includes(inputElement.type)
                      ? 'input'
                      : 'button';
          const reference = clean(
            `${referencedText(stateElement)} ${referencedText(element)}`,
            240,
          );
          const associated = clean(`${labelText(stateElement)} ${labelText(element)}`, 240);
          const heading = headingText(stateElement, container);
          const categoryLabel = semanticToggle(stateElement)
            ? clean(`${categoryText(stateElement, container)} ${associated} ${reference}`, 240)
            : '';
          const label = clean(
            `${reference} ${associated} ${stateElement.getAttribute('title') ?? ''} ${heading} ${categoryLabel}`,
            240,
          );
          const name = clean(
            stateElement.getAttribute('aria-label') ||
              element.getAttribute('aria-label') ||
              reference ||
              associated ||
              (element instanceof HTMLElement ? element.innerText : '') ||
              (stateElement instanceof HTMLElement ? stateElement.innerText : '') ||
              element.textContent ||
              stateElement.getAttribute('title') ||
              inputElement?.value ||
              select?.value ||
              categoryLabel ||
              heading,
            240,
          );
          return {
            id,
            role,
            name,
            label,
            bounds: boundsOf(element),
            ...(checked === undefined ? {} : { checked }),
            ...(ariaChecked === undefined ? {} : { ariaChecked }),
            ...(categoryLabel ? { categoryLabel } : {}),
            visible: visible(element),
            disabled:
              inputElement?.disabled === true ||
              select?.disabled === true ||
              button?.disabled === true ||
              stateElement.getAttribute('aria-disabled') === 'true' ||
              element.getAttribute('aria-disabled') === 'true',
            kind,
            containerId: containerIds.get(container)!,
            frameIndex: input.frameIndex,
            frameUrl: input.frameUrl,
            ...(stateElement instanceof HTMLAnchorElement
              ? {
                  href: (() => {
                    const url = new URL(stateElement.href, location.href);
                    return `${url.origin}${url.pathname}`;
                  })(),
                  ...(stateElement.hasAttribute('download') ? { downloads: true } : {}),
                }
              : {}),
            ...((button?.type === 'submit' && button.form) ||
            (inputElement?.type === 'submit' && inputElement.form)
              ? { submitsForm: true }
              : {}),
          };
        })
      : [];
    return {
      containers,
      elements,
      sanitizedText: clean(containers.map((container) => container.text).join(' | '), 4000),
      ...(document.body?.dataset.consentState
        ? { fixtureState: clean(document.body.dataset.consentState, 100) }
        : {}),
    } as FrameSnapshot;
  }, args);
}

function cleanNodeText(value: string, max: number): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- strip control bytes before audit/model use
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}
