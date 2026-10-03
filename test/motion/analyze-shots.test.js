// tools/analyze-shots.mjs and tools/shooting-steps.json (docs/architecture.md 4.2, docs/game-design.md 11) on SYNTHETIC recordings
// (test-support/motion/shot-recording.js: real packets, a modelled hand and trigger jerk) and on the real sword recording, which has no
// trigger presses. The synthetic jerk gives the analysis a known answer; a real trigger jerk is UNVERIFIED-ON-HARDWARE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeShots, formatReport, loadRows, quantile } from '../../tools/analyze-shots.mjs';
import { makeShotRecording } from '../../test-support/motion/shot-recording.js';
import { RECORDING_FILE } from '../../test-support/motion/real-recording.js';
import { MOTION_CONFIG } from '../../public/js/motion/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(ROOT, 'tools/analyze-shots.mjs');
const PLAN = path.join(ROOT, 'tools/shooting-steps.json');
const T = { timeout: 60000 };

function tmpFile(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clay-shots-'));
  const file = path.join(dir, 'imu-synthetic.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const col = (r, comp) => r.candidates.find((c) => c.compMs === comp);

test('the plan: the steps of design 11 in the format record-imu.mjs --steps reads, English instructions, one step analysed', () => {
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  assert.ok(Array.isArray(plan) && plan.length >= 8);
  const names = plan.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, 'unique names');
  for (const s of plan) {
    assert.match(s.name, /^[a-z0-9_]+$/);
    assert.ok(Number.isFinite(s.seconds) && s.seconds >= 10 && s.seconds <= 90, `${s.name}: ${s.seconds} s`);
    assert.ok(typeof s.text === 'string' && s.text.length > 40, `${s.name}: a real instruction`);
    assert.match(s.text, /^[\x20-\x7E]+$/, `${s.name}: plain ASCII English`);
  }
  for (const n of ['rest_table', 'aim_5_points', 'track_slow', 'snap_shots', 'trigger_still', 'shot_sequence', 'arm_lower_raise']) assert.ok(names.includes(n), n);
  assert.deepEqual(plan.filter((s) => s.analyze === true).map((s) => s.name), ['trigger_still'], 'only the still trigger pulls set the compensation');
  assert.match(plan.find((s) => s.name === 'snap_shots').text, /20/);
  assert.match(plan.find((s) => s.name === 'trigger_still').text, /20/);
  assert.match(plan.find((s) => s.name === 'shot_sequence').text, /50/);
  const total = plan.reduce((a, s) => a + s.seconds, 0);
  assert.ok(total < 20 * 60, `${total} s of recording fits the 20 minute session`);
});

test('synthetic: a jerk starting 40 ms before the press report -> the recommendation is about 40 to 70 ms, every press found', T, () => {
  const r = analyzeShots(makeShotRecording({ jerk: { dps: 80, durMs: 120, leadMs: 40, yawShare: 0.25 } }));
  assert.equal(r.presses, 9);
  assert.equal(r.usedPresses, 9);
  assert.equal(r.selection, 'plan');
  assert.deepEqual(r.selectedSteps, ['trigger_still']);
  assert.deepEqual(r.candidates.map((c) => c.compMs), MOTION_CONFIG.shot.compCandidatesMs);
  assert.ok(col(r, 0).medianPx > 5, `uncompensated, the jerk moves the shot: ${col(r, 0).medianPx} px`);
  assert.ok(col(r, 100).p90Px < 0.5, 'looking back far enough the hand was still');
  for (let i = 1; i < r.candidates.length; i += 1) assert.ok(r.candidates[i].medianPx <= r.candidates[i - 1].medianPx + 1e-9, 'monotonic here');
  assert.ok(r.recommendedCompMs >= 40 && r.recommendedCompMs <= 70, `recommended ${r.recommendedCompMs}`);
  const best = Math.min(...r.candidates.map((c) => c.p90Px));
  assert.ok(col(r, r.recommendedCompMs).p90Px <= best + MOTION_CONFIG.shot.recommendTolerancePx);
  assert.ok(r.candidates.filter((c) => c.compMs < r.recommendedCompMs).every((c) => c.p90Px > best + MOTION_CONFIG.shot.recommendTolerancePx), 'the smallest such value');
  assert.ok(Math.abs(r.jerk.medianPeakDps - 80) < 10, `jerk peak ${r.jerk.medianPeakDps}`);
  assert.equal(r.bias.source, 'rest_table');
  assert.ok(Math.abs(r.bias.dps.y + 5 * (2000 / 32768)) < 1e-3 && Math.abs(r.bias.dps.z - 12 * (2000 / 32768)) < 1e-3, 'the synthetic bias');
  assert.match(formatReport(r), /RECOMMENDED triggerCompMs: \d+/);
});

test('synthetic: the recommendation follows the jerk timing (no jerk 0, jerk at the press <= 20, a late-starting 80 ms lead about 80 to 110)', T, () => {
  const none = analyzeShots(makeShotRecording({ jerk: null }));
  assert.equal(none.recommendedCompMs, 0);
  assert.ok(none.candidates.every((c) => c.p90Px < 0.5), 'a hand within the dead zone does not move the aim at all');
  const atPress = analyzeShots(makeShotRecording({ jerk: { dps: 80, durMs: 120, leadMs: 0 } }));
  assert.ok(atPress.recommendedCompMs <= 20, `${atPress.recommendedCompMs}`);
  const early = analyzeShots(makeShotRecording({ jerk: { dps: 80, durMs: 120, leadMs: 80 }, seed: 11 }));
  assert.ok(early.recommendedCompMs >= 80 && early.recommendedCompMs <= 100, `${early.recommendedCompMs}`);
});

test('synthetic: the trigger setting R reads R presses; with ZR the presses of R are reported as other shoulder presses', T, () => {
  const rows = makeShotRecording({ button: 'R' });
  const zr = analyzeShots(rows);
  assert.equal(zr.presses, 0);
  assert.equal(zr.recommendedCompMs, null);
  assert.match(zr.notes.join(' '), /No ZR presses found.*R x9/);
  const r = analyzeShots(rows, { trigger: 'R' });
  assert.equal(r.trigger, 'R');
  assert.equal(r.presses, 9);
  assert.ok(r.recommendedCompMs >= 40 && r.recommendedCompMs <= 70);
});

test('synthetic: without an "analyze" step in the recording every press is used, with a note; --steps selects explicitly', T, () => {
  const rows = makeShotRecording({ steps: [{ name: 'rest_table', seconds: 5, still: true }, { name: 'shots', seconds: 12, presses: [2, 5, 8, 11] }, { name: 'more', seconds: 6, presses: [3] }] });
  const all = analyzeShots(rows);
  assert.equal(all.selection, 'all');
  assert.equal(all.usedPresses, 5);
  assert.match(all.notes.join(' '), /every press is used/);
  const one = analyzeShots(rows, { steps: ['more'] });
  assert.equal(one.selection, 'given');
  assert.equal(one.usedPresses, 1);
  // a press right at the start of a step cannot be evaluated (no aim 200 ms before it)
  const early = analyzeShots(makeShotRecording({ steps: [{ name: 'trigger_still', seconds: 4, presses: [0.05, 2] }] }));
  assert.equal(early.presses, 2);
  assert.equal(early.usedPresses, 1);
  assert.equal(early.pressList[0].valid, false);
});

test('synthetic: other aim curves scale the displacement, the settings are reported', T, () => {
  const rows = makeShotRecording();
  const precise = analyzeShots(rows, { aimCurve: 'precise' });
  const fast = analyzeShots(rows, { aimCurve: 'fast' });
  assert.equal(precise.settings.aimCurve, 'precise');
  assert.ok(col(fast, 0).medianPx > col(precise, 0).medianPx, `${col(fast, 0).medianPx} > ${col(precise, 0).medianPx}`);
});

test('the real sword recording has no trigger presses: the tool says so cleanly (no crash, no recommendation)', T, () => {
  const r = analyzeShots(loadRows(RECORDING_FILE), { file: RECORDING_FILE });
  assert.equal(r.presses, 0);
  assert.equal(r.usedPresses, 0);
  assert.equal(r.recommendedCompMs, null);
  assert.equal(r.reports, 4744);
  assert.equal(r.steps.length, 9);
  assert.match(r.notes[0], /No ZR presses found/);
  assert.match(r.notes[0], /R x2/, 'the two R presses of the sword session (docs/hardware-findings.md 8)');
  assert.ok(r.candidates.every((c) => c.n === 0 && c.medianPx === null));
  assert.match(formatReport(r), /none \(no usable presses\)/);
});

test('CLI: text and --json on a synthetic file and on the real recording, exit code 0; a missing file is exit code 2', T, () => {
  const { file, cleanup } = tmpFile(makeShotRecording());
  try {
    const json = spawnSync(process.execPath, [TOOL, file, '--json'], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const out = JSON.parse(json.stdout);
    assert.equal(out.presses, 9);
    assert.ok(Number.isInteger(out.recommendedCompMs));
    const text = spawnSync(process.execPath, [TOOL, file, '--aim-curve', 'fast'], { encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /RECOMMENDED triggerCompMs: \d+/);
    assert.match(text.stdout, /aim curve fast/);
  } finally {
    cleanup();
  }
  const real = spawnSync(process.execPath, [TOOL, RECORDING_FILE], { encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /No ZR presses found/);
  const missing = spawnSync(process.execPath, [TOOL, path.join(os.tmpdir(), 'no-such-recording.jsonl')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  const bad = spawnSync(process.execPath, [TOOL, RECORDING_FILE, '--aim-curve', 'turbo'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('quantile helper', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([0, 10], 0.9), 9);
});

test('the replay uses the gains the game plays with (MOTION_CONFIG.shooter); --sword / {sword: true} replays with the old sword gains', T, () => {
  const rows = makeShotRecording();
  const shooter = analyzeShots(rows);
  const sword = analyzeShots(rows, { sword: true });
  assert.equal(shooter.settings.gains, 'shooter');
  assert.equal(sword.settings.gains, 'sword');
  // a slow jerk (under about 75 deg/s for most of it) moves the aim about 8/5 as far with the shooter gains
  const ratio = col(shooter, 0).medianPx / col(sword, 0).medianPx;
  assert.ok(ratio > 1.4 && ratio < 1.8, `shooter / sword displacement ${ratio.toFixed(2)}`);
  const cli = spawnSync(process.execPath, [TOOL, RECORDING_FILE, '--sword'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /gains sword/);
});
