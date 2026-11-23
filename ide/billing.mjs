import { parsePbMap } from '../agy-capsule/sidecars/agy_capsule/conversation_db.mjs';

const PAYGO_TIER = 'agy-business-paygo-tier';

// IDE 2.8's bundled codeium_common.proto: UserStatus.user_tier=36;
// onboarding.proto: UserTier.id=1. Do not inspect auth records or credentials.
// A missing quota, usesGcpTos, isAdc, or an enterprise label is not billing evidence.
export function userBillingMode(status) {
  let tier;
  if (typeof status === 'string') {
    if (!status || status.length > 1_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(status)) return 'unknown';
    const root = parsePbMap(Buffer.from(status, 'base64'));
    const bytes = root.get(36)?.[0];
    const id = Buffer.isBuffer(bytes) && parsePbMap(bytes).get(1)?.[0];
    tier = Buffer.isBuffer(id) ? id.toString('utf8') : undefined;
  } else if (status && typeof status === 'object') {
    tier = status.userTier?.id;
  }
  if (typeof tier !== 'string' || !tier) return 'unknown';
  return tier === PAYGO_TIER ? 'paygo' : 'other';
}

// Call only with the latest successful quota response; null means no valid read.
// An explicit empty list plus exact account evidence confirms pay-as-you-go.
export function quotaAvailability(groups, billingMode) {
  if (!Array.isArray(groups)) return 'unavailable';
  if (groups.length) return 'available';
  return billingMode === 'paygo' ? 'paygo' : 'unavailable';
}

// Self-contained for the existing CDP runtime bundle. The model selector's
// provider already holds UserStatus; return one enum, not the user record.
export function readComposerBilling(footer) {
  const trigger = footer?.querySelector('button[data-testid="model-selector-trigger"]');
  const key = trigger && Object.keys(trigger).find(k => k.startsWith('__reactFiber$'));
  let depth = 0;
  for (let fiber = key && trigger[key]; fiber && depth++ < 100; fiber = fiber.return) {
    const candidates = [fiber.memoizedProps?.value, fiber.memoizedProps];
    for (let dep = fiber.dependencies?.firstContext; dep; dep = dep.next) candidates.push(dep.memoizedValue);
    for (const value of candidates) {
      const id = value?.userStatus?.userTier?.id;
      if (typeof id === 'string' && id) return id === 'agy-business-paygo-tier' ? 'paygo' : 'other';
    }
  }
  return 'unknown';
}
