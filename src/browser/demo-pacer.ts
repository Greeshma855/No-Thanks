import type { GuardianConfig } from '../config/env.js';

export interface DemoPacer {
  readonly enabled: boolean;
  beforeAction(): Promise<void>;
  afterAction(): Promise<void>;
  afterVerification(): Promise<void>;
  holdFinalState(): Promise<void>;
}

export type Sleep = (milliseconds: number) => Promise<void>;

export class NoopDemoPacer implements DemoPacer {
  readonly enabled = false;
  async beforeAction(): Promise<void> {}
  async afterAction(): Promise<void> {}
  async afterVerification(): Promise<void> {}
  async holdFinalState(): Promise<void> {}
}

export class TimedDemoPacer implements DemoPacer {
  readonly enabled = true;
  constructor(
    private readonly highlightDelayMs: number,
    private readonly stepDelayMs: number,
    private readonly finalHoldMs: number,
    private readonly sleep: Sleep = async (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async beforeAction(): Promise<void> {
    await this.delay(this.highlightDelayMs);
  }
  async afterAction(): Promise<void> {}
  async afterVerification(): Promise<void> {
    await this.delay(this.stepDelayMs);
  }
  async holdFinalState(): Promise<void> {
    await this.delay(this.finalHoldMs);
  }
  private async delay(milliseconds: number): Promise<void> {
    if (milliseconds > 0) await this.sleep(milliseconds);
  }
}

export function createDemoPacer(config: GuardianConfig, sleep?: Sleep): DemoPacer {
  if (config.GUARDIAN_MODE !== 'inspector' || !config.GUARDIAN_DEMO_PACING)
    return new NoopDemoPacer();
  return new TimedDemoPacer(
    config.GUARDIAN_HIGHLIGHT_DELAY_MS,
    config.GUARDIAN_STEP_DELAY_MS,
    config.GUARDIAN_FINAL_HOLD_MS,
    sleep,
  );
}
