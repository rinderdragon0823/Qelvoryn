import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../src/core/store.js';
import { createProject, createTrack, createClip, createAsset, findClip } from '../src/core/model.js';
import { secondsToTicks, TICKS_PER_SECOND } from '../src/core/time.js';
import {
  insertClip, findFreeSlot, clampStartOnTrack, computeMoveConstraints, applyMove, moveSelectionTo,
  trimClipEdge, splitAt, razorAll, deleteClips, duplicateClips, setClipSpeed, setClipTiming,
  addTrack, deleteTrack, duplicateTrack, reorderTracks, setTrackProp, toggleTrackFlag, setParamValue,
  toggleKeyframe, moveKeyframeTo, setKeyframeValue, addEffect, removeEffect, toggleEffect, moveEffect,
  setEffectParam, snapTime, snapCandidates, addMarker, clipDurationLabel, allClipIds, clipsInRange,
  trackRangeFree, findTrackForClip,
} from '../src/core/commands.js';

function setup() {
  const project = createProject({ fps: 30 });
  const v1 = createTrack('video', { name: 'V1' });
  const v2 = createTrack('video', { name: 'V2' });
  const audio = createTrack('audio', { name: 'A1' });
  project.tracks.push(v1, v2, audio);
  const store = new ProjectStore(project);
  return { store, v1, v2, audio };
}

function add(store, track, clip) {
  return insertClip(store, track.id, clip, { resolveOverlap: false });
}

test('insertClip places a clip and resolves overlap by default', () => {
  const { store, v1 } = setup();
  add(store, v1, createClip('video', { startTicks: 0, durationTicks: 1000 }));
  const second = insertClip(store, v1.id, createClip('video', { startTicks: 500, durationTicks: 1000 }));
  assert.equal(second.startTicks, 1000, 'overlapping clip is pushed to the next free slot');
  assert.equal(v1.clips.length, 2);
  assert.equal(second.trackId, v1.id);
});

test('insertClip rejects clips the track cannot hold', () => {
  const { store, audio } = setup();
  assert.throws(() => insertClip(store, audio.id, createClip('video', {})), /配置できません/);
});

test('findFreeSlot and clampStartOnTrack respect neighbours', () => {
  const { v1 } = setup();
  v1.clips.push(createClip('video', { startTicks: 0, durationTicks: 1000 }));
  v1.clips.push(createClip('video', { startTicks: 3000, durationTicks: 1000 }));
  assert.equal(findFreeSlot(v1, 500, 1000), 1000);
  assert.equal(findFreeSlot(v1, 1000, 500), 1000);
  assert.equal(findFreeSlot(v1, 4000, 500), 4000);
  const clip = createClip('video', { startTicks: 1500, durationTicks: 500 });
  assert.equal(clampStartOnTrack(v1, clip, 800), 1000, 'cannot move into the left neighbour');
  assert.equal(clampStartOnTrack(v1, clip, 5000), 2500, 'cannot move into the right neighbour');
});

test('trackRangeFree respects boundaries', () => {
  const { v1 } = setup();
  v1.clips.push(createClip('video', { startTicks: 1000, durationTicks: 2000 }));
  assert.equal(trackRangeFree(v1, 0, 1000), true, 'touching the left edge is free');
  assert.equal(trackRangeFree(v1, 3000, 500), true, 'touching the right edge is free');
  assert.equal(trackRangeFree(v1, 500, 1000), false, 'overlapping the clip is not free');
  assert.equal(trackRangeFree(v1, 2000, 100), false, 'starting inside the clip is not free');
});

test('findTrackForClip spills to the next free track, or reports a new track is needed', () => {
  const { store, v1, v2, audio } = setup();
  insertClip(store, v1.id, createClip('video', { startTicks: 0, durationTicks: 4000 }), { resolveOverlap: false });

  const preferred = findTrackForClip(store.state, 'video', {
    ticks: 0, durationTicks: 1000, preferredIndex: store.state.tracks.indexOf(v1),
  });
  assert.equal(preferred, v2, 'busy preferred lane spills to the free video track');

  insertClip(store, v2.id, createClip('video', { startTicks: 0, durationTicks: 4000 }), { resolveOverlap: false });
  assert.equal(
    findTrackForClip(store.state, 'video', { ticks: 0, durationTicks: 4000 }),
    null,
    'all video tracks busy at that spot -> null lets the caller create a new track',
  );
  assert.equal(
    findTrackForClip(store.state, 'video', { ticks: 8000, durationTicks: 1000 }),
    v1,
    'free spot on the first video track',
  );
  assert.equal(findTrackForClip(store.state, 'audio', { ticks: 0, durationTicks: 1000 }), audio);
});

test('duplicateTrack clones the track and its clips with new ids', () => {
  const { store, v1 } = setup();
  const clip = createClip('video', { startTicks: 0, durationTicks: 1000 });
  insertClip(store, v1.id, clip, { resolveOverlap: false });
  const copy = duplicateTrack(store, v1.id);
  const index = store.state.tracks.indexOf(v1);
  assert.equal(store.state.tracks[index + 1], copy, 'copy sits right below the source');
  assert.notEqual(copy.id, v1.id);
  assert.equal(copy.clips.length, 1);
  assert.notEqual(copy.clips[0].id, clip.id, 'clip ids are regenerated');
  assert.equal(copy.clips[0].trackId, copy.id, 'clips point at the copy');
  assert.equal(copy.clips[0].startTicks, clip.startTicks);
  copy.clips[0].startTicks = 9999;
  assert.equal(clip.startTicks, 0, 'deep copy: editing the clone does not touch the source');
});

test('computeMoveConstraints keeps a group between its neighbours', () => {
  const { v1 } = setup();
  const left = createClip('video', { startTicks: 0, durationTicks: 1000 });
  const mover = createClip('video', { startTicks: 2000, durationTicks: 1000 });
  const right = createClip('video', { startTicks: 5000, durationTicks: 1000 });
  v1.clips.push(left, mover, right);
  const { minDelta, maxDelta } = computeMoveConstraints([
    { clipId: mover.id, track: v1, startTicks: mover.startTicks, durationTicks: mover.durationTicks },
  ]);
  assert.equal(minDelta, -1000, 'can slide left until it touches the left clip (ends at 1000)');
  assert.equal(maxDelta, 2000, 'cannot pass the right clip (starts at 5000)');
});

test('applyMove moves clips in time and across tracks when compatible', () => {
  const { store, v1, v2, audio } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 1000, durationTicks: 1000 }));
  applyMove(store, [{ clipId: clip.id, trackId: v1.id }], 500);
  assert.equal(findClip(store.state, clip.id).clip.startTicks, 1500);

  applyMove(store, [{ clipId: clip.id, trackId: v2.id }], 0);
  const moved = findClip(store.state, clip.id);
  assert.equal(moved.track.id, v2.id);
  assert.equal(moved.clip.trackId, v2.id);

  applyMove(store, [{ clipId: clip.id, trackId: audio.id }], 0);
  assert.equal(findClip(store.state, clip.id).track.id, v2.id, 'incompatible destination is ignored');
});

test('moveSelectionTo anchors the left-most clip', () => {
  const { store, v1 } = setup();
  const a = add(store, v1, createClip('video', { startTicks: 1000, durationTicks: 1000 }));
  const b = add(store, v1, createClip('video', { startTicks: 3000, durationTicks: 1000 }));
  moveSelectionTo(store, [
    { clipId: a.id, trackId: v1.id },
    { clipId: b.id, trackId: v1.id },
  ], 5000);
  assert.equal(findClip(store.state, a.id).clip.startTicks, 5000);
  assert.equal(findClip(store.state, b.id).clip.startTicks, 7000);
});

test('trim left shifts in-point and keyframes so media stays anchored', () => {
  const { store, v1 } = setup();
  const asset = createAsset({ durationTicks: secondsToTicks(10) });
  const clip = createClip('video', { assetId: asset.id, startTicks: 1000, durationTicks: 40000, inTicks: 0 });
  clip.keyframes = { 'transform.x': [{ id: 'k1', t: 0, v: 0.5, interp: 'linear', bezier: [0.33, 0, 0.67, 1] }] };
  store.transact('asset', () => {
    store.touch(['assets']);
    store.state.assets[asset.id] = asset;
  });
  add(store, v1, clip);

  trimClipEdge(store, clip.id, 'left', 10000);
  const t = findClip(store.state, clip.id).clip;
  assert.equal(t.startTicks, 11000);
  assert.equal(t.durationTicks, 30000);
  assert.equal(t.inTicks, 10000, 'in-point advanced by the trimmed amount');
  assert.equal(t.keyframes['transform.x'][0].t, -10000, 'keyframe stays glued to the media');
});

test('trim right is limited by the media length', () => {
  const { store, v1 } = setup();
  const asset = createAsset({ durationTicks: secondsToTicks(2) });
  store.transact('asset', () => {
    store.touch(['assets']);
    store.state.assets[asset.id] = asset;
  });
  const clip = createClip('video', { assetId: asset.id, startTicks: 0, durationTicks: secondsToTicks(1) });
  add(store, v1, clip);
  trimClipEdge(store, clip.id, 'right', secondsToTicks(5));
  assert.equal(findClip(store.state, clip.id).clip.durationTicks, secondsToTicks(2));
  trimClipEdge(store, clip.id, 'right', -secondsToTicks(10));
  assert.equal(findClip(store.state, clip.id).clip.durationTicks, 4000, 'never shorter than one frame');
});

test('trim right stops at the next clip', () => {
  const { store, v1 } = setup();
  const a = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 8000 }));
  add(store, v1, createClip('video', { startTicks: 20000, durationTicks: 80000 }));
  trimClipEdge(store, a.id, 'right', 20000);
  assert.equal(findClip(store.state, a.id).clip.durationTicks, 20000);
});

test('dragging a trim edge is idempotent (restore from originals each frame)', () => {
  // The timeline gesture re-derives every pointer move from the original
  // geometry: restore, then apply the whole cumulative delta.  Simulate the
  // frame sequence and check the result equals a single one-shot trim.
  const { store, v1 } = setup();
  const clip = createClip('video', { startTicks: 6000, durationTicks: 40000, inTicks: 20000 });
  const asset = createAsset({ durationTicks: secondsToTicks(10) });
  store.transact('asset', () => {
    store.touch(['assets']);
    store.state.assets[asset.id] = asset;
  });
  clip.assetId = asset.id;
  add(store, v1, clip);

  const original = { start: clip.startTicks, duration: clip.durationTicks, inTicks: clip.inTicks };
  for (const cumulative of [100, 500, 2000, 6000, 9000]) {
    clip.startTicks = original.start;
    clip.durationTicks = original.duration;
    clip.inTicks = original.inTicks;
    trimClipEdge(store, clip.id, 'right', cumulative, {});
    assert.equal(clip.durationTicks, original.duration + cumulative, `frame ${cumulative} follows the pointer`);
  }
  // Left edge: cumulative negative delta grows the clip left-wards.
  for (const cumulative of [-100, -1500, -4000]) {
    clip.startTicks = original.start;
    clip.durationTicks = original.duration;
    clip.inTicks = original.inTicks;
    trimClipEdge(store, clip.id, 'left', cumulative, {});
    assert.equal(clip.startTicks, original.start + cumulative, `left frame ${cumulative} follows the pointer`);
    assert.equal(clip.durationTicks, original.duration - cumulative);
  }
});

test('splitAt cuts clips and shifts keyframes into the right half', () => {
  const { store, v1 } = setup();
  const clip = createClip('video', { startTicks: 0, durationTicks: 80000, inTicks: 0 });
  clip.keyframes = {
    'opacity': [
      { id: 'k1', t: 0, v: 0, interp: 'linear', bezier: [0.33, 0, 0.67, 1] },
      { id: 'k2', t: 60000, v: 1, interp: 'linear', bezier: [0.33, 0, 0.67, 1] },
    ],
  };
  add(store, v1, clip);

  const created = splitAt(store, 40000, [clip.id]);
  assert.equal(created.length, 1);
  const left = findClip(store.state, clip.id).clip;
  const right = findClip(store.state, created[0]).clip;
  assert.equal(left.durationTicks, 40000);
  assert.equal(right.startTicks, 40000);
  assert.equal(right.durationTicks, 40000);
  assert.equal(right.inTicks, 40000);
  assert.equal(right.keyframes.opacity.length, 2, 'split keeps the whole curve (useful when trimming back)');
  assert.equal(right.keyframes.opacity[1].t, 20000, '6s keyframe becomes 2s in the right half');
  assert.equal(right.keyframes.opacity[1].v, 1);
  assert.equal(left.keyframes.opacity.length, 2);
  assert.notEqual(right.keyframes.opacity[0].id, 'k1', 'cloned keyframes get fresh ids');
});

test('splitAt ignores the playhead at clip edges', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 40000 }));
  assert.equal(splitAt(store, 0, [clip.id]).length, 0);
  assert.equal(splitAt(store, 40000, [clip.id]).length, 0);
  assert.equal(splitAt(store, 20000, [clip.id]).length, 1);
});

test('razorAll splits every unlocked track', () => {
  const { store, v1, v2 } = setup();
  add(store, v1, createClip('video', { startTicks: 0, durationTicks: 80000 }));
  add(store, v2, createClip('video', { startTicks: 0, durationTicks: 80000 }));
  const created = razorAll(store, 40000);
  assert.equal(created.length, 2);
});

test('locked tracks and clips are protected', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 2000 }));
  clip.locked = true;
  assert.equal(splitAt(store, 1000, [clip.id]).length, 0);
  deleteClips(store, [clip.id]);
  assert.equal(v1.clips.length, 1, 'locked clip is not deleted');
});

test('deleteClips removes clips and ripple shifts neighbours', () => {
  const { store, v1 } = setup();
  const a = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 1000 }));
  const b = add(store, v1, createClip('video', { startTicks: 1000, durationTicks: 1000 }));
  const c = add(store, v1, createClip('video', { startTicks: 2000, durationTicks: 1000 }));
  deleteClips(store, [b.id]);
  assert.equal(v1.clips.length, 2);
  deleteClips(store, [a.id], { ripple: true });
  const rest = v1.clips.find((x) => x.id === c.id);
  assert.equal(rest.startTicks, 1000, 'following clip slides left');
});

test('duplicateClips appends copies after the original', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 1000, name: 'A' }));
  const created = duplicateClips(store, [clip.id]);
  assert.equal(created.length, 1);
  const copy = findClip(store.state, created[0]).clip;
  assert.equal(copy.startTicks, 1000);
  assert.notEqual(copy.id, clip.id);
  assert.equal(copy.name, 'A');
});

test('setClipSpeed keeps the source anchored', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 40000, inTicks: 0 }));
  setClipSpeed(store, clip.id, 2);
  const t = findClip(store.state, clip.id).clip;
  assert.equal(t.speed, 2);
  assert.equal(t.durationTicks, 20000);
  setClipSpeed(store, clip.id, 0.5);
  assert.equal(findClip(store.state, clip.id).clip.durationTicks, 80000);
});

test('setClipTiming moves and resizes within limits', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 1000 }));
  setClipTiming(store, clip.id, { startTicks: 3000 });
  assert.equal(findClip(store.state, clip.id).clip.startTicks, 3000);
  setClipTiming(store, clip.id, { durationTicks: 6000 });
  assert.equal(findClip(store.state, clip.id).clip.durationTicks, 6000);
  setClipTiming(store, clip.id, { durationTicks: 500 });
  assert.equal(findClip(store.state, clip.id).clip.durationTicks, 4000, 'never shorter than one frame');
  setClipTiming(store, clip.id, { name: 'シーン1' });
  assert.equal(findClip(store.state, clip.id).clip.name, 'シーン1');
});

test('track commands', () => {
  const { store, v1, v2 } = setup();
  const track = addTrack(store, 'overlay', { name: 'O1' });
  assert.equal(store.state.tracks.length, 4);
  assert.equal(track.name, 'O1');
  reorderTracks(store, 0, 3);
  assert.equal(store.state.tracks[3].id, v1.id);
  setTrackProp(store, v2.id, 'opacity', 0.5);
  assert.equal(store.track(v2.id).opacity, 0.5);
  toggleTrackFlag(store, v2.id, 'hidden');
  assert.equal(store.track(v2.id).hidden, true);
  const before = store.state.tracks.length;
  deleteTrack(store, track.id);
  assert.equal(store.state.tracks.length, before - 1);
});

test('setting a parameter writes static values or keyframes at the playhead', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 1000, durationTicks: 4000 }));
  setParamValue(store, [clip.id], 'opacity', 0.4);
  assert.equal(findClip(store.state, clip.id).clip.opacity, 0.4);

  toggleKeyframe(store, clip.id, 'opacity', 1000, {});
  assert.equal(findClip(store.state, clip.id).clip.keyframes.opacity.length, 1);
  setParamValue(store, [clip.id], 'opacity', 0.9, { playheadTicks: 2000 });
  const t = findClip(store.state, clip.id).clip;
  assert.equal(t.keyframes.opacity.length, 2, 'animated params gain a keyframe at the playhead');
  assert.equal(t.keyframes.opacity.at(-1).v, 0.9);
  assert.equal(t.keyframes.opacity.at(-1).t, 1000, 'local ticks = playhead - clip start');
});

test('keyframe editing commands', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 4000 }));
  toggleKeyframe(store, clip.id, 'opacity', 0);
  toggleKeyframe(store, clip.id, 'opacity', 1000);
  const kfs = findClip(store.state, clip.id).clip.keyframes.opacity;
  assert.equal(kfs.length, 2);
  moveKeyframeTo(store, clip.id, 'opacity', kfs[1].id, 1500);
  assert.equal(findClip(store.state, clip.id).clip.keyframes.opacity[1].t, 1500);
  setKeyframeValue(store, clip.id, 'opacity', kfs[1].id, 0.25);
  assert.equal(findClip(store.state, clip.id).clip.keyframes.opacity[1].v, 0.25);
  toggleKeyframe(store, clip.id, 'opacity', 0);
  assert.equal(findClip(store.state, clip.id).clip.keyframes.opacity.length, 1, 'toggling removes an existing keyframe');
});

test('effect commands', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', {}));
  addEffect(store, [clip.id], 'blur');
  const fx = findClip(store.state, clip.id).clip.effects[0];
  assert.ok(fx && fx.id);
  assert.equal(findClip(store.state, clip.id).clip.effects.length, 1);

  setEffectParam(store, clip.id, fx.id, 'amount', 0.75, { playheadTicks: 0 });
  assert.equal(findClip(store.state, clip.id).clip.effects[0].params.amount, 0.75);

  toggleEffect(store, clip.id, fx.id);
  assert.equal(findClip(store.state, clip.id).clip.effects[0].enabled, false);
  toggleEffect(store, clip.id, fx.id);
  assert.equal(findClip(store.state, clip.id).clip.effects[0].enabled, true);

  addEffect(store, [clip.id], 'pixelate');
  const second = findClip(store.state, clip.id).clip.effects.at(-1);
  assert.notEqual(second.id, fx.id);
  moveEffect(store, clip.id, second.id, -1);
  assert.equal(findClip(store.state, clip.id).clip.effects[0].id, second.id);
  removeEffect(store, clip.id, second.id);
  assert.equal(findClip(store.state, clip.id).clip.effects.length, 1);
});

test('effect param edits become keyframes once the parameter is animated', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', {}));
  addEffect(store, [clip.id], 'blur');
  const fx = findClip(store.state, clip.id).clip.effects[0];
  setEffectParam(store, clip.id, fx.id, 'amount', 0.9, { autoKey: true, playheadTicks: 0 });
  const path = `effects.${fx.id}.amount`;
  let keys = findClip(store.state, clip.id).clip.keyframes[path];
  assert.equal(keys.length, 1, 'auto-key starts an animation curve');
  assert.equal(keys[0].v, 0.9);
  assert.equal(keys[0].t, 0, 'stored in clip-local ticks');

  setEffectParam(store, clip.id, fx.id, 'amount', 0.2, { playheadTicks: 2000 });
  keys = findClip(store.state, clip.id).clip.keyframes[path];
  assert.equal(keys.length, 2, 'animated params gain a keyframe at the playhead');
  assert.equal(keys.at(-1).v, 0.2);
  assert.equal(keys.at(-1).t, 2000);

  removeEffect(store, clip.id, fx.id);
  assert.equal(findClip(store.state, clip.id).clip.keyframes[path], undefined);

  removeEffect(store, clip.id, fx.id);
  assert.equal(findClip(store.state, clip.id).clip.keyframes[`effects.${fx.id}.amount`], undefined);
});

test('snapping finds clip edges, markers and the origin', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 5000, durationTicks: 1000 }));
  addMarker(store, 8000, 'マーカー');

  const candidates = snapCandidates(store.state, { excludeClipIds: [] });
  assert.ok(candidates.some((c) => c.ticks === 0 && c.kind === 'origin'));
  assert.ok(candidates.some((c) => c.ticks === 5000 && c.kind === 'clip'));
  assert.ok(candidates.some((c) => c.ticks === 6000 && c.kind === 'clip'));
  assert.ok(candidates.some((c) => c.ticks === 8000 && c.kind === 'marker'));

  const snapped = snapTime(store.state, 5050, { thresholdTicks: 200 });
  assert.equal(snapped.ticks, 5000);
  assert.equal(snapped.snapped, true);

  const notSnapped = snapTime(store.state, 5050, { thresholdTicks: 10 });
  assert.equal(notSnapped.ticks, 5050);
  assert.equal(notSnapped.snapped, false);

  const disabled = snapTime(store.state, 5050, { enabled: false, thresholdTicks: 1000 });
  assert.equal(disabled.snapped, false);

  const excluded = snapTime(store.state, 5050, { thresholdTicks: 200, excludeClipIds: [clip.id] });
  assert.equal(excluded.snapped, false);
});

test('helper queries', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 3000 }));
  assert.deepEqual(allClipIds(store.state), [clip.id]);
  assert.equal(clipsInRange(store.state, 1000, 2000).length, 1);
  assert.equal(clipsInRange(store.state, 3000, 4000).length, 0);
  assert.ok(clipDurationLabel(3000).length > 0);
});

test('every command is undoable in one step', () => {
  const { store, v1 } = setup();
  const clip = add(store, v1, createClip('video', { startTicks: 0, durationTicks: 1000 }));
  const depth = store.undoStack.length;
  splitAt(store, 500, [clip.id]);
  assert.equal(store.undoStack.length, depth + 1);
  store.undo();
  assert.equal(store.state.tracks[0].clips.length, 1);
  assert.equal(store.state.tracks[0].clips[0].durationTicks, 1000);
});
