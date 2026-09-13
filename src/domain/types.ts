import { z } from 'zod';

export const darkPatternSchema = z.enum([
  'ASYMMETRIC_EMPHASIS',
  'HIDDEN_REJECTION',
  'PRESELECTED_TRACKING',
  'CONFUSING_WORDING',
  'MULTI_LAYERED_CONSENT',
  'OBSTRUCTION',
  'NONE',
  'UNKNOWN',
]);
export type DarkPattern = z.infer<typeof darkPatternSchema>;
export const guardianActionSchema = z.enum([
  'CLICK_REJECT',
  'OPEN_PREFERENCES',
  'SET_CONSENT_TOGGLE',
  'SET_CONSENT_TOGGLES',
  'SCROLL_MODAL',
  'SAVE_PREFERENCES',
  'STOP_SUCCESS',
  'STOP_UNCERTAIN',
  'NO_BANNER',
]);
export type GuardianAction = z.infer<typeof guardianActionSchema>;
export const verificationLevelSchema = z.enum([
  'VERIFIED',
  'LIKELY_VERIFIED',
  'UNVERIFIED',
  'FAILED',
  'NOT_APPLICABLE',
]);
export type VerificationLevel = z.infer<typeof verificationLevelSchema>;

export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ConsentElement {
  id: string;
  role: string;
  name: string;
  label: string;
  bounds: ElementBounds;
  checked?: boolean;
  ariaChecked?: 'true' | 'false' | 'mixed';
  categoryLabel?: string;
  visible?: boolean;
  disabled: boolean;
  kind: 'button' | 'link' | 'checkbox' | 'switch' | 'select' | 'input';
  containerId: string;
  href?: string;
  submitsForm?: boolean;
  downloads?: boolean;
  frameIndex: number;
  frameUrl: string;
}
export interface ConsentContainer {
  id: string;
  role: string;
  text: string;
  bounds: ElementBounds;
  frameIndex: number;
  frameUrl: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollable: boolean;
}
export interface ConsentFrame {
  index: number;
  url: string;
  name: string;
  accessible: boolean;
}
export interface PageState {
  url: string;
  title: string;
  capturedAt: string;
  bannerDetected: boolean;
  frames: ConsentFrame[];
  containers: ConsentContainer[];
  elements: ConsentElement[];
  sanitizedText: string;
  fixtureState?: string;
}
export interface VerificationEvidence {
  explicitRejectActionSucceeded: boolean;
  bannerGone: boolean;
  successMessage: boolean;
  togglesRejected: boolean;
  saveActionSucceeded: boolean;
  persistedAfterRefresh: boolean;
  storageIndicatesRejection: boolean;
  details: string[];
}
export interface VerificationResult {
  level: VerificationLevel;
  evidence: VerificationEvidence;
}
export interface ActionRecord {
  step: number;
  action: GuardianAction;
  elementId?: string;
  targets?: Array<{ elementId: string; desiredState: false }>;
  saveElementId?: string;
  confirmedToggleIds?: string[];
  containerId?: string;
  direction?: 'up' | 'down';
  amount?: 'small' | 'page';
  success: boolean;
  detail: string;
}
export interface GuardianReport {
  startedAt: string;
  completedAt: string;
  url: string;
  provider: 'mock' | 'bedrock' | 'openai';
  model?: string;
  mode: 'inspector' | 'guardian';
  displayProfile: 'laptop' | 'recording' | 'custom';
  viewport: { width: number; height: number };
  bannerDetected: boolean;
  finalBannerDetected: boolean;
  finalStateCapturedAt: string;
  finalConsentFingerprint: string;
  darkPatterns: DarkPattern[];
  actions: ActionRecord[];
  safetyStops: string[];
  verification: VerificationResult;
  artifactDirectory: string;
}
