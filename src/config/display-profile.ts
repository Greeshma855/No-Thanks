import type { GuardianConfig } from './env.js';

export type DisplayProfile = GuardianConfig['GUARDIAN_DISPLAY_PROFILE'];
export interface ViewportDimensions {
  width: number;
  height: number;
}

export function resolveViewport(config: GuardianConfig): ViewportDimensions {
  if (config.GUARDIAN_DISPLAY_PROFILE === 'laptop') return { width: 1024, height: 576 };
  if (config.GUARDIAN_DISPLAY_PROFILE === 'recording') return { width: 1280, height: 720 };
  return {
    width: config.GUARDIAN_VIEWPORT_WIDTH,
    height: config.GUARDIAN_VIEWPORT_HEIGHT,
  };
}
