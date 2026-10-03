// n1 (round 2 and 3): `npm test` must not be green when the browser tests could not run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skipOrFail } from '../../test-support/e2e/env.js';

test('a missing Chrome fails the suite unless E2E_OPTIONAL=1, and then the tests are reported as skipped with the reason', async () => {
  assert.throws(() => skipOrFail('Google Chrome not found', {}), /E2E_OPTIONAL=1/);
  assert.throws(() => skipOrFail('Google Chrome not found', { E2E_OPTIONAL: '0' }), /Google Chrome not found/);
  const s = skipOrFail('Google Chrome not found', { E2E_OPTIONAL: '1' });
  assert.equal(s.skip, 'Google Chrome not found');
  await s.close();
});
