import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject, createTrack, createClip, createEffect, createAsset, normalizeProject,
  findTrack, findClip, clipEnd, clipSourceSpan, maxDurationForClip, projectDuration,
  canTrackAcceptClip, TRACK_KINDS,
} from '../src/core/model.js';
import { secondsToTicks } from '../src/core/time.js';

test('createProject has the expected shape', () => {
  const p = createProject({ name: 'テスト', width: 1280, height: 720, fps: 60 });
  assert.equal(p.name, 'テスト');
  assert.equal(p.settings.width, 1280);
  assert.equal(p.settings.height, 720);
  assert.equal(p.settings.fps, 60);
  assert.deepEqual(p.tracks, []);
  assert.deepEqual(p.assets, {});
});

test('createClip fills defaults and honours overrides', () => {
  const clip = createClip('video', { startTicks: 1000, durationTicks: 5000, speed: 2 });
  assert.equal(clip.type, 'video');
  assert.equal(clip.startTicks, 1000);
  assert.equal(clip.durationTicks, 5000);
  assert.equal(clip.speed, 2);
  assert.equal(clip.opacity, 1);
  assert.equal(clip.fit, 'contain');
  assert.equal(clip.blendMode, 'source-over');
  assert.deepEqual(clip.fades, { inTicks: 0, outTicks: 0 });
  assert.equal(clip.transform.x, 0.5);
  assert.deepEqual(clip.keyframes, {});
  assert.deepEqual(clip.effects, []);
});

test('effect clips get a camera transform by default', () => {
  const clip = createClip('effect', {});
  assert.equal(clip.effects.length, 1);
  assert.equal(clip.effects[0].type, 'cameraTransform');
});

test('tracks are universal layers: every kind accepts every clip type', () => {
  const video = createTrack('video');
  const audio = createTrack('audio');
  const text = createTrack('text');
  const effect = createTrack('effect');
  for (const track of [video, audio, text, effect]) {
    for (const clipType of ['video', 'image', 'text', 'shape', 'audio', 'effect']) {
      assert.ok(canTrackAcceptClip(track, clipType), `${track.kind} accepts ${clipType}`);
    }
  }
  assert.ok(!canTrackAcceptClip(null, 'video'));
  assert.ok(!canTrackAcceptClip({ kind: 'bogus' }, 'video'));
  for (const def of Object.values(TRACK_KINDS)) assert.ok(typeof def.label === 'string');
});

test('lookups and geometry helpers', () => {
  const project = createProject();
  const track = createTrack('video');
  const clip = createClip('video', { startTicks: 1000, durationTicks: 3000, inTicks: 500, speed: 2 });
  track.clips.push(clip);
  project.tracks.push(track);
  clip.trackId = track.id;

  assert.equal(findTrack(project, track.id).track, track);
  assert.equal(findTrack(project, 'nope'), null);
  assert.equal(findClip(project, clip.id).clip, clip);
  assert.equal(findClip(project, 'nope'), null);
  assert.equal(clipEnd(clip), 4000);
  assert.equal(clipSourceSpan(clip), 6000);
  assert.equal(projectDuration(project), 4000);
});

test('maxDurationForClip respects remaining source and speed', () => {
  const asset = createAsset({ durationTicks: secondsToTicks(10) });
  const clip = createClip('video', { inTicks: secondsToTicks(4), speed: 2 });
  assert.equal(maxDurationForClip(clip, asset), Math.round(secondsToTicks(6) / 2));
  assert.equal(maxDurationForClip(createClip('text', {}), null), Infinity);
});

test('normalizeProject repairs broken projects', () => {
  const raw = {
    name: '壊れたプロジェクト',
    settings: { width: -10, height: 0, fps: 0 },
    tracks: [
      { id: 't1', kind: 'video', clips: [{ id: 'c1', type: 'video', startTicks: -100, durationTicks: 0 }] },
      { kind: 'audio' },
      null,
    ],
    assets: {
      a1: { id: 'a1', name: '素材' },
    },
    assetOrder: ['a1', 'missing'],
    markers: [{ tick: -5, name: 'm' }, { tick: 10 }],
  };
  const p = normalizeProject(raw);
  assert.ok(p.settings.width > 0);
  assert.ok(p.settings.height > 0);
  assert.ok(p.settings.fps > 0);
  assert.equal(p.tracks.length, 2);
  const clip = p.tracks[0].clips[0];
  assert.equal(clip.startTicks, 0);
  assert.ok(clip.durationTicks >= 1);
  assert.equal(clip.trackId, p.tracks[0].id);
  assert.ok(p.tracks[1].id, 'missing ids get generated');
  assert.deepEqual(p.assetOrder, ['a1'], 'missing assets are dropped from the order');
  assert.equal(p.markers[0].tick, 0);
  assert.ok(p.markers[1].id);
});

test('normalizeProject keeps negative keyframe times (already trimmed media)', () => {
  const raw = createProject();
  const track = createTrack('video');
  const clip = createClip('video', { durationTicks: 1000 });
  clip.keyframes = { 'transform.x': [{ id: 'k1', t: -500, v: 0.2, interp: 'linear' }] };
  track.clips.push(clip);
  raw.tracks.push(track);
  const p = normalizeProject(raw);
  assert.equal(p.tracks[0].clips[0].keyframes['transform.x'][0].t, -500);
});

test('normalizeProject drops keyframes of removed effects only on demand', () => {
  const raw = createProject();
  const track = createTrack('video');
  const clip = createClip('video', {});
  const fx = createEffect('colorCorrect');
  clip.effects = [fx];
  clip.keyframes = {
    [`effects.${fx.id}.amount`]: [{ id: 'k1', t: 0, v: 0.5, interp: 'linear' }],
    'effects.ghost.amount': [{ id: 'k2', t: 0, v: 0.5, interp: 'linear' }],
  };
  track.clips.push(clip);
  raw.tracks.push(track);
  const p = normalizeProject(raw);
  const paths = Object.keys(p.tracks[0].clips[0].keyframes);
  assert.ok(paths.includes(`effects.${fx.id}.amount`));
  assert.ok(!paths.includes('effects.ghost.amount'), 'orphan keyframes are pruned');
});
