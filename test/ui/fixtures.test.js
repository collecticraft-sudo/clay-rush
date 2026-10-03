// The UI fixtures conform to the shared contracts (so the UI tests exercise contract-shaped data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValid } from '../../public/js/shared/validate.js';
import { hitEvent, makeSnapshot, makeStatus, practiceEvent, roundResult, shotEvent, providerFact, actionFact, navFact } from '../../test-support/ui/fixtures.js';

test('snapshot, events, results, statuses and action events built by the fixtures are valid', () => {
  assertValid('GameSnapshot', makeSnapshot());
  assertValid('GameSnapshot', makeSnapshot({ mode: 'practice', phase: 'flight' }));
  assertValid('GameSnapshot', makeSnapshot({ phase: 'ready' }));
  for (const ev of [practiceEvent('hit'), practiceEvent('lost'), practiceEvent('thrown'), shotEvent(), hitEvent()]) assertValid('GameEvent', ev);
  assertValid('RoundResult', roundResult());
  assertValid('RoundResult', roundResult({ mode: 'timeattack', stageId: 'hills', endReason: 'timer', rank: 'S' }));
  assertValid('RoundResult', roundResult({ mode: 'zen', stageId: 'alpine', rank: null, accuracy: null }));
  assertValid('InputStatus', makeStatus());
  assertValid('InputStatus', providerFact('joycon', 'streaming').status);
  assertValid('ActionEvent', actionFact('fire', 'joycon', 5).event);
  assertValid('NavEvent', navFact('left', 'joycon').event);
  assert.ok(true);
});
