import type {
  ActionRecord,
  PageState,
  VerificationLevel,
  VerificationResult,
} from '../domain/types.js';

const rejected = /reject|denied|declined|necessary|essential|opt.?out/i;

export function calculateVerificationLevel(
  before: PageState,
  after: PageState,
  context: boolean | { persistedAfterRefresh?: boolean; actions?: ActionRecord[] } = false,
): VerificationResult {
  const persistedAfterRefresh =
    typeof context === 'boolean' ? context : (context.persistedAfterRefresh ?? false);
  const actions = typeof context === 'boolean' ? [] : (context.actions ?? []);
  const explicitRejectActionSucceeded = actions.some(
    ({ action, success }) => action === 'CLICK_REJECT' && success,
  );
  const saveActionSucceeded = actions.some(
    ({ action, success, saveElementId }) =>
      success && (action === 'SAVE_PREFERENCES' || Boolean(saveElementId)),
  );
  if (!before.bannerDetected) {
    return {
      level: after.bannerDetected ? 'UNVERIFIED' : 'NOT_APPLICABLE',
      evidence: {
        explicitRejectActionSucceeded: false,
        bannerGone: false,
        successMessage: false,
        togglesRejected: false,
        saveActionSucceeded: false,
        persistedAfterRefresh: false,
        storageIndicatesRejection: false,
        details: [
          after.bannerDetected
            ? 'A consent interface appeared after the initial discovery window; rejection was not verified.'
            : 'No banner observed during the complete discovery window.',
        ],
      },
    };
  }
  const bannerGone = !after.bannerDetected;
  const successMessage = /saved|updated|rejected|privacy choices confirmed/i.test(
    after.sanitizedText,
  );
  const nonEssential = after.elements.filter(
    (element) =>
      /analytics|advertis|marketing|tracking|targeting|personal|social|performance|functional/i.test(
        `${element.name} ${element.label} ${element.categoryLabel ?? ''}`,
      ) && ['checkbox', 'switch'].includes(element.kind),
  );
  const togglesRejected =
    (nonEssential.length > 0 && nonEssential.every((element) => element.checked === false)) ||
    actions.some(
      ({ action, success, targets, confirmedToggleIds }) =>
        action === 'SET_CONSENT_TOGGLES' &&
        success &&
        Boolean(targets?.length) &&
        targets!.every(({ elementId }) => confirmedToggleIds?.includes(elementId)),
    );
  const storageIndicatesRejection = rejected.test(after.fixtureState ?? '');
  const storageIndicatesAcceptance = /accept|allowed|granted/i.test(after.fixtureState ?? '');
  const details: string[] = [];
  if (explicitRejectActionSucceeded) details.push('An explicit rejection action succeeded.');
  if (bannerGone) details.push('Consent interface disappeared.');
  if (successMessage) details.push('A save/rejection confirmation is visible.');
  if (togglesRejected) details.push('Visible non-essential toggles are disabled.');
  if (saveActionSucceeded) details.push('Privacy choices were saved after toggle confirmation.');
  if (storageIndicatesRejection) details.push('Sanitized consent state indicates rejection.');
  if (persistedAfterRefresh) details.push('Consent state persisted after refresh.');
  let level: VerificationLevel = 'UNVERIFIED';
  if (
    persistedAfterRefresh &&
    bannerGone &&
    (storageIndicatesRejection || explicitRejectActionSucceeded || saveActionSucceeded)
  )
    level = 'VERIFIED';
  else if (
    bannerGone &&
    (explicitRejectActionSucceeded ||
      saveActionSucceeded ||
      togglesRejected ||
      storageIndicatesRejection ||
      successMessage)
  )
    level = 'LIKELY_VERIFIED';
  else if (togglesRejected && saveActionSucceeded) level = 'LIKELY_VERIFIED';
  else if (storageIndicatesAcceptance) level = 'FAILED';
  return {
    level,
    evidence: {
      explicitRejectActionSucceeded,
      bannerGone,
      successMessage,
      togglesRejected,
      saveActionSucceeded,
      persistedAfterRefresh,
      storageIndicatesRejection,
      details,
    },
  };
}
