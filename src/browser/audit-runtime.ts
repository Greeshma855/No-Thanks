export interface ScheduledAudit {
  browserSessionId: string;
  tabId: string;
  auditRunId: string;
  url: string;
  signal: AbortSignal;
  isCurrent(): boolean;
}

export interface RuntimeTabSnapshot {
  tabId: string;
  auditRunIds: string[];
  generation: number;
  closed: boolean;
}

interface RuntimeTab {
  tabId: string;
  auditRunIds: string[];
  generation: number;
  closed: boolean;
  timer: NodeJS.Timeout | undefined;
  resolvePending: (() => void) | undefined;
  active: AbortController | undefined;
  queue: Promise<void>;
}

export type AuditHandler = (audit: ScheduledAudit) => Promise<void>;

export class AuditSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new Error('Audit concurrency must be a positive integer');
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maximum) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

export class BrowserAuditRuntime {
  private readonly tabs = new Map<string, RuntimeTab>();
  private readonly limiter: AuditSemaphore;
  private tabSequence = 0;
  private auditSequence = 0;
  private stopped = false;

  constructor(
    readonly browserSessionId: string,
    maximumConcurrency: number,
    private readonly debounceMs = 750,
  ) {
    this.limiter = new AuditSemaphore(maximumConcurrency);
  }

  registerTab(): string {
    if (this.stopped) throw new Error('Browser runtime is shut down');
    this.tabSequence += 1;
    const tabId = `tab-${String(this.tabSequence).padStart(3, '0')}`;
    this.tabs.set(tabId, {
      tabId,
      auditRunIds: [],
      generation: 0,
      closed: false,
      timer: undefined,
      resolvePending: undefined,
      active: undefined,
      queue: Promise.resolve(),
    });
    return tabId;
  }

  schedule(tabId: string, url: string, handler: AuditHandler): Promise<void> {
    const tab = this.requireTab(tabId);
    tab.generation += 1;
    const generation = tab.generation;
    tab.active?.abort();
    if (tab.timer) clearTimeout(tab.timer);
    tab.resolvePending?.();

    return new Promise<void>((resolve, reject) => {
      tab.resolvePending = resolve;
      tab.timer = setTimeout(() => {
        tab.timer = undefined;
        tab.resolvePending = undefined;
        tab.queue = tab.queue
          .catch(() => undefined)
          .then(async () => {
            if (this.stopped || tab.closed || tab.generation !== generation) return;
            this.auditSequence += 1;
            const auditRunId = `audit-${String(this.auditSequence).padStart(4, '0')}`;
            tab.auditRunIds.push(auditRunId);
            const controller = new AbortController();
            tab.active = controller;
            const isCurrent = () =>
              !this.stopped &&
              !tab.closed &&
              !controller.signal.aborted &&
              tab.generation === generation;
            try {
              await this.limiter.run(() =>
                handler({
                  browserSessionId: this.browserSessionId,
                  tabId,
                  auditRunId,
                  url,
                  signal: controller.signal,
                  isCurrent,
                }),
              );
            } finally {
              if (tab.active === controller) tab.active = undefined;
            }
          })
          .then(resolve, reject);
      }, this.debounceMs);
    });
  }

  closeTab(tabId: string): void {
    const tab = this.requireTab(tabId);
    tab.closed = true;
    tab.active?.abort();
    if (tab.timer) clearTimeout(tab.timer);
    tab.timer = undefined;
    tab.resolvePending?.();
    tab.resolvePending = undefined;
  }

  shutdown(): void {
    this.stopped = true;
    for (const tab of this.tabs.values()) this.closeTab(tab.tabId);
  }

  snapshot(tabId: string): RuntimeTabSnapshot {
    const tab = this.requireTab(tabId);
    return {
      tabId: tab.tabId,
      auditRunIds: [...tab.auditRunIds],
      generation: tab.generation,
      closed: tab.closed,
    };
  }

  async drain(): Promise<void> {
    await Promise.all([...this.tabs.values()].map((tab) => tab.queue.catch(() => undefined)));
  }

  private requireTab(tabId: string): RuntimeTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Unknown tab ${tabId}`);
    return tab;
  }
}
