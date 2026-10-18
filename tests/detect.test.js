import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectClicks } from '../src/auto/detect.js';

function baselineSample(time, meanDiff = 0.01, changedRatio = 0.02) {
  return { time, meanDiff, changedRatio, cx: 0.5, cy: 0.5, diff: null };
}

function makeSeries() {
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    samples.push(baselineSample(i / 8, 0.01 + (i % 3) * 0.001, 0.02));
  }
  samples[10] = { time: 10 / 8, meanDiff: 0.09, changedRatio: 0.04, cx: 0.25, cy: 0.75, diff: null };
  samples[11] = { time: 11 / 8, meanDiff: 0.03, changedRatio: 0.02, cx: 0.3, cy: 0.7, diff: null };
  samples[12] = { time: 12 / 8, meanDiff: 0.07, changedRatio: 0.04, cx: 0.7, cy: 0.3, diff: null };
  samples[13] = { time: 13 / 8, meanDiff: 0.011, changedRatio: 0.02, cx: 0.5, cy: 0.5, diff: null };
  samples[18] = { time: 18 / 8, meanDiff: 0.02, changedRatio: 0.0004, cx: 0.5, cy: 0.5, diff: null };
  samples[25] = { time: 25 / 8, meanDiff: 0.2, changedRatio: 0.5, cx: 0.5, cy: 0.5, diff: null };
  samples[30] = { time: 30 / 8, meanDiff: 0.08, changedRatio: 0.05, cx: 0.6, cy: 0.4, diff: null };
  samples[31] = { time: 31 / 8, meanDiff: 0.02, changedRatio: 0.02, cx: 0.6, cy: 0.4, diff: null };
  return samples;
}

test('detectClicks needs at least three samples', () => {
  assert.deepEqual(detectClicks([]), []);
  assert.deepEqual(detectClicks([baselineSample(0), baselineSample(0.1)]), []);
});

test('detectClicks finds sharp localised changes in the real diff signal', () => {
  const clicks = detectClicks(makeSeries());
  assert.equal(clicks.length, 2, 'two distinct clicks survive filtering');

  const first = clicks[0];
  assert.equal(first.time, 10 / 8);
  assert.equal(first.x, 0.25, 'click position comes from the weighted diff centroid');
  assert.equal(first.y, 0.75);
  assert.ok(first.strength > 1);

  const second = clicks[1];
  assert.equal(second.time, 30 / 8);
});

test('detectClicks rejects scrolls and noise', () => {
  const samples = makeSeries();
  const clicks = detectClicks(samples);
  for (const c of clicks) {
    assert.notEqual(c.time, 25 / 8, 'a change covering half the screen (scroll) is not a click');
    assert.notEqual(c.time, 18 / 8, 'a below-threshold blip is not a click');
  }
});

test('detectClicks merges double detections of the same click', () => {
  const samples = makeSeries();
  const clicks = detectClicks(samples, { minInterval: 0.35 });
  assert.ok(!clicks.some((c) => c.time === 12 / 8), 'the weaker twin 0.25s later is folded in');

  const loose = detectClicks(samples, { minInterval: 0.05, sensitivity: 1.6 });
  assert.ok(loose.some((c) => c.time === 12 / 8), 'with a tiny interval both detections are reported');
});

test('detectClicks sensitivity scales with the requested multiplier', () => {
  const samples = makeSeries();
  const few = detectClicks(samples, { sensitivity: 12 });
  const many = detectClicks(samples, { sensitivity: 0.2 });
  assert.ok(few.length <= many.length, 'a stricter multiplier never finds more clicks');
});
