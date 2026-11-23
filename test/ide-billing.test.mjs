import test from 'node:test';
import assert from 'node:assert/strict';
import { userBillingMode, quotaAvailability, readComposerBilling } from '../ide/billing.mjs';

const vi = n => n < 128 ? [n] : [128 | (n & 127), ...vi(n >>> 7)];
const field = (key, value) => Buffer.concat([Buffer.from([...vi(key * 8 + 2), ...vi(value.length)]), Buffer.from(value)]);
const status = id => field(36, field(1, id)).toString('base64');

test('IDE billing reads only the exact UserStatus tier field from typed or encoded status', () => {
  assert.equal(userBillingMode(status('agy-business-paygo-tier')), 'paygo');
  assert.equal(userBillingMode({ userTier: { id: 'agy-business-paygo-tier' } }), 'paygo');
  assert.equal(userBillingMode(status('free-tier')), 'other');
  assert.equal(userBillingMode({ userTier: { id: 'standard-tier' } }), 'other');
  assert.equal(userBillingMode(status('AGY-BUSINESS-PAYGO-TIER')), 'other');
});

test('absence, empty groups, labels, ADC and GCP terms never manufacture paygo evidence', () => {
  for (const value of [undefined, null, '', {}, 'not base64!', 'AA==',
    { isAdc: true, usesGcpTos: true, userTier: { name: 'Pay As You Go' } },
    { userTier: { id: '' } },
    field(35, 'agy-business-paygo-tier').toString('base64'),
    field(36, field(2, 'agy-business-paygo-tier')).toString('base64')]) {
    assert.equal(userBillingMode(value), 'unknown');
  }
  assert.equal(quotaAvailability([], 'unknown'), 'unavailable');
  assert.equal(quotaAvailability([], 'other'), 'unavailable');
  assert.equal(quotaAvailability(null, 'paygo'), 'unavailable');
  assert.equal(quotaAvailability(undefined, 'paygo'), 'unavailable');
  assert.equal(quotaAvailability([], 'paygo'), 'paygo');
  assert.equal(quotaAvailability([{ buckets: [{ window: 'weekly', remainingFraction: 0 }] }], 'paygo'), 'available');
});

test('renderer billing probe returns only a classification from its owning provider', () => {
  const trigger = { __reactFiber$fixture: { dependencies: { firstContext: { memoizedValue: {
    userStatus: { userTier: { id: 'agy-business-paygo-tier' }, email: 'never-return@example.invalid' },
  } } } } };
  const footer = { querySelector: () => trigger };
  assert.equal(readComposerBilling(footer), 'paygo');
  trigger.__reactFiber$fixture.dependencies.firstContext.memoizedValue.userStatus.userTier.id = 'g1-pro-tier';
  assert.equal(readComposerBilling(footer), 'other');
  delete trigger.__reactFiber$fixture.dependencies.firstContext.memoizedValue.userStatus;
  assert.equal(readComposerBilling(footer), 'unknown');
  assert.equal(readComposerBilling(null), 'unknown');
  // The bundle serializes this function without importing its module constants.
  assert.equal(new Function('return (' + readComposerBilling.toString() + ')')()(footer), 'unknown');
});
