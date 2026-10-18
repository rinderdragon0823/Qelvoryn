import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cubicBezierEase, easeProgress, hexToRgb, rgbToHex, interpolateValue, getStaticValue,
  setStaticValue, addKeyframe, removeKeyframe, moveKeyframe, setKeyframeInterp,
  evaluateParam, isAnimated, animatedPaths, isEffectAnimated, clearKeyframes, pruneOrphanKeyframes,
} from '../src/core/keyframes.js';
import { createClip, createEffect } from '../src/core/model.js';

test('hex and rgb helpers', () => {
  assert.deepEqual(hexToRgb('#ff8000'), [255, 128, 0]);
  assert.deepEqual(hexToRgb('#fff'), [255, 255, 255]);
  assert.equal(rgbToHex([255, 128, 0]), '#ff8000');
  assert.equal(rgbToHex([0, 0, 0]), '#000000');
});

test('interpolateValue handles numbers, colours and plain values', () => {
  assert.equal(interpolateValue(0, 10, 0.5), 5);
  assert.equal(interpolateValue(10, 0, 0.25), 7.5);
  assert.equal(interpolateValue('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(interpolateValue('a', 'b', 0.5), 'a', 'non numeric values hold at the start');
  assert.equal(interpolateValue('a', 'b', 1), 'b');
  assert.equal(interpolateValue(5, 5, 0.7), 5);
});

test('easing curves are monotonic and anchored', () => {
  for (const interp of ['linear', 'easeIn', 'easeOut', 'easeInOut', 'bezier']) {
    const samples = [];
    for (let i = 0; i <= 10; i += 1) samples.push(easeProgress(i / 10, interp, [0.42, 0, 0.58, 1]));
    assert.ok(Math.abs(samples[0]) < 1e-9, `${interp} starts at 0`);
    assert.ok(Math.abs(samples.at(-1) - 1) < 1e-9, `${interp} ends at 1`);
    for (let i = 1; i < samples.length; i += 1) {
      assert.ok(samples[i] >= samples[i - 1] - 1e-9, `${interp} is monotonic`);
    }
  }
  assert.equal(easeProgress(0.5, 'hold', null), 0, 'hold stays at the previous value');
  assert.ok(cubicBezierEase(0.33, 0, 0.67, 1, 0.5) > 0.4);
});

test('static values read and write through paths', () => {
  const clip = createClip('video', { opacity: 0.5 });
  assert.equal(getStaticValue(clip, 'opacity'), 0.5);
  assert.equal(getStaticValue(clip, 'transform.x'), 0.5);
  setStaticValue(clip, 'transform.x', 0.75);
  assert.equal(clip.transform.x, 0.75);
  const fx = createEffect('colorCorrect');
  clip.effects.push(fx);
  setStaticValue(clip, `effects.${fx.id}.brightness`, 2);
  assert.equal(fx.params.brightness, 2);
  assert.equal(getStaticValue(clip, `effects.${fx.id}.brightness`), 2);
});

test('keyframe create / update / remove / move / interpolate', () => {
  const clip = createClip('video', {});
  const kf = addKeyframe(clip, 'opacity', 0, 1, 'linear');
  assert.equal(clip.keyframes.opacity.length, 1);
  assert.equal(kf.t, 0);

  const same = addKeyframe(clip, 'opacity', 0, 0.5, 'easeIn');
  assert.equal(clip.keyframes.opacity.length, 1, 'keyframes at the same time are merged');
  assert.equal(same.v, 0.5);
  addKeyframe(clip, 'opacity', 3, 0.9, 'linear', { tolerance: 5 });
  assert.equal(clip.keyframes.opacity.length, 1, 'tolerance widens the merge window');

  addKeyframe(clip, 'opacity', 5000, 0.2, 'linear');
  assert.equal(clip.keyframes.opacity.length, 2);
  assert.ok(isAnimated(clip, 'opacity'));
  assert.deepEqual(animatedPaths(clip), ['opacity']);

  assert.ok(moveKeyframe(clip, 'opacity', clip.keyframes.opacity[0].id, 1000));
  assert.equal(clip.keyframes.opacity[0].t, 1000);
  assert.ok(!moveKeyframe(clip, 'opacity', clip.keyframes.opacity[0].id, 5000), 'cannot land on another keyframe');

  assert.ok(setKeyframeInterp(clip, 'opacity', clip.keyframes.opacity[0].id, 'hold', null));
  assert.equal(clip.keyframes.opacity[0].interp, 'hold');

  assert.ok(removeKeyframe(clip, 'opacity', clip.keyframes.opacity[0].id));
  assert.equal(clip.keyframes.opacity.length, 1);
  clearKeyframes(clip, 'opacity');
  assert.equal(clip.keyframes.opacity, undefined);
});

test('evaluateParam interpolates between keyframes', () => {
  const clip = createClip('video', {});
  addKeyframe(clip, 'opacity', 0, 0, 'linear');
  addKeyframe(clip, 'opacity', 1000, 1, 'linear');
  assert.equal(evaluateParam(clip, 'opacity', 0, 0.5), 0);
  assert.equal(evaluateParam(clip, 'opacity', 500, 0.5), 0.5);
  assert.equal(evaluateParam(clip, 'opacity', 1000, 0.5), 1);
  assert.equal(evaluateParam(clip, 'opacity', 5000, 0.5), 1, 'clamps after the last keyframe');
  assert.equal(evaluateParam(clip, 'opacity', -500, 0.5), 0, 'clamps before the first keyframe');

  addKeyframe(clip, 'opacity', 2000, 0.5, 'hold');
  assert.equal(evaluateParam(clip, 'opacity', 1500, 0.5), 0.75, 'previous segment still interpolates');
  assert.equal(evaluateParam(clip, 'opacity', 2500, 0.5), 0.5, 'hold keeps the value until the next keyframe');
  assert.equal(evaluateParam(clip, 'opacity', 3000, 0.5), 0.5);

  assert.equal(evaluateParam(clip, 'transform.x', 200, 0.42), 0.5, 'un-animated paths return the static value');
  assert.equal(evaluateParam(clip, 'mystery.path', 0, 0.42), 0.42, 'missing values use the fallback');
});

test('effect keyframes are detected and pruned', () => {
  const clip = createClip('video', {});
  const fx = createEffect('blur');
  clip.effects.push(fx);
  addKeyframe(clip, `effects.${fx.id}.amount`, 0, 0.2);
  assert.ok(isEffectAnimated(clip, fx.id));
  clip.effects.length = 0;
  pruneOrphanKeyframes(clip);
  assert.deepEqual(clip.keyframes, {});
});
