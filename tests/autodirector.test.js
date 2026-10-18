import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../src/core/store.js';
import {
  createProject, createTrack, createClip, createAsset, projectDuration,
} from '../src/core/model.js';
import { secondsToTicks, TICKS_PER_SECOND } from '../src/core/time.js';
import {
  AutoDirector, AUTO_META, timelineTicksForSource, sourceWindows,
} from '../src/auto/autodirector.js';

function makeApp() {
  const project = createProject({ fps: 30, width: 1920, height: 1080 });
  const asset = createAsset({ id: 'asset-1', durationTicks: secondsToTicks(30) });
  project.assets[asset.id] = asset;
  project.assetOrder = [asset.id];
  const video = createTrack('video', { name: 'V1' });
  const clip = createClip('video', { assetId: asset.id, startTicks: 0, durationTicks: secondsToTicks(10) });
  video.clips.push(clip);
  project.tracks.push(video);
  const store = new ProjectStore(project);
  const app = {
    store,
    projectDuration: () => projectDuration(store.state),
    selectTrack: () => {},
  };
  return { app, store, clip };
}

function tracksOf(store) {
  return store.state.tracks;
}

test('timelineTicksForSource maps source seconds back into the timeline', () => {
  const clip = {
    startTicks: 120000, durationTicks: 480000, speed: 1, inTicks: 240000, reversed: false,
  };
  assert.equal(timelineTicksForSource(clip, 2), 120000, 'source 2s lands exactly on the in-point');
  assert.equal(timelineTicksForSource(clip, 3), 240000, 'source 3s = 2s into the clip');
  assert.equal(timelineTicksForSource(clip, 6), 600000);

  const reversed = { ...clip, reversed: true };
  assert.equal(timelineTicksForSource(reversed, 6), 120000, 'reversed clips walk backwards');
  assert.equal(timelineTicksForSource(reversed, 3), 480000);

  const fast = {
    startTicks: 0, durationTicks: 60000, speed: 2, inTicks: 12000, reversed: false,
  };
  assert.equal(timelineTicksForSource(fast, 0.5), 24000, 'playback speed divides the local time');
});

test('sourceWindows collects the real source range of video clips', () => {
  const { store } = makeApp();
  const image = createTrack('image', { name: 'I1' });
  image.clips.push(createClip('image', { assetId: 'asset-1', startTicks: 0, durationTicks: 120000 }));
  const text = createTrack('text', { name: 'T1' });
  text.clips.push(createClip('text', { startTicks: 0, durationTicks: 120000 }));
  store.transact('setup', () => {
    store.touch(['tracks']);
    store.state.tracks.push(image, text);
  });

  const range = { inTicks: secondsToTicks(2), outTicks: secondsToTicks(4) };
  const windows = sourceWindows(store.state, range);
  assert.equal(windows.length, 1, 'only video clips with an asset produce windows');
  const win = windows[0];
  assert.equal(win.timelineIn, secondsToTicks(2));
  assert.equal(win.timelineOut, secondsToTicks(4));
  assert.equal(win.fromSeconds, 2);
  assert.equal(win.toSeconds, 4);
});

test('intervalClicks builds a regular grid inside the range', () => {
  const { app } = makeApp();
  const auto = new AutoDirector(app);
  const clicks = auto.intervalClicks({ inTicks: 0, outTicks: secondsToTicks(18) }, 6);
  assert.equal(clicks.length, 3);
  assert.deepEqual(clicks.map((c) => c.ticks), [0, secondsToTicks(6), secondsToTicks(12)]);
  assert.equal(clicks[0].x, 0.5);
  assert.equal(clicks[1].x, 0.36);
  assert.equal(clicks[2].x, 0.64);
  assert.ok(clicks.every((c) => c.synthetic === true));
});

test('mergeClicks folds nearby detections with a strength weighted average', () => {
  const { app } = makeApp();
  const auto = new AutoDirector(app);
  const merged = auto.mergeClicks([
    { ticks: 0, x: 0.2, y: 0.2, strength: 1 },
    { ticks: 30000, x: 0.6, y: 0.8, strength: 3 },
    { ticks: 200000, x: 0.1, y: 0.1, strength: 2 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].ticks, 22500);
  assert.ok(Math.abs(merged[0].x - 0.5) < 1e-9);
  assert.ok(Math.abs(merged[0].y - 0.65) < 1e-9);
  assert.equal(merged[0].strength, 3);
  assert.equal(merged[1].ticks, 200000);
});

test('defaultRange prefers the work area over the full duration', () => {
  const { app, store } = makeApp();
  const auto = new AutoDirector(app);
  assert.deepEqual(auto.defaultRange(), { inTicks: 0, outTicks: secondsToTicks(10) });

  store.state.settings.workArea = { inTicks: secondsToTicks(1), outTicks: secondsToTicks(5) };
  assert.deepEqual(auto.defaultRange(), { inTicks: secondsToTicks(1), outTicks: secondsToTicks(5) });
});

test('apply() creates editable auto objects in one undoable transaction', () => {
  const { app, store } = makeApp();
  const auto = new AutoDirector(app);
  const range = { inTicks: 0, outTicks: secondsToTicks(10) };
  const before = store.undoStack.length;

  const summary = auto.apply({
    range,
    clicks: [{ ticks: secondsToTicks(2), x: 0.3, y: 0.4, strength: 2 }],
    zooms: true,
    rings: true,
  });

  assert.equal(summary.zooms, 1);
  assert.equal(summary.rings, 1);
  assert.equal(summary.trackIds.length, 2);
  assert.equal(store.undoStack.length, before + 1, 'the whole run is a single undo step');

  const tracks = tracksOf(store);
  assert.equal(tracks.length, 3);

  const videoIndex = tracks.findIndex((t) => t.id === store.state.tracks.find((x) => x.kind === 'video').id);
  const zoomTrack = tracks.find((t) => t.name.includes('ズーム（AI）'));
  const ringTrack = tracks.find((t) => t.name.includes('クリック（AI）'));
  assert.ok(tracks.indexOf(zoomTrack) < videoIndex, 'the effect track sits above the footage it zooms');
  assert.ok(tracks.indexOf(ringTrack) < videoIndex, 'click rings render over the footage');
  assert.equal(zoomTrack.kind, 'effect');
  const zoomClip = zoomTrack.clips[0];
  assert.equal(zoomClip.metadata.auto, AUTO_META.zoom);
  const fx = zoomClip.effects[0];
  assert.equal(fx.type, 'cameraTransform');
  assert.equal(fx.params.scale, 1.6);

  const scaleKeys = zoomClip.keyframes[`effects.${fx.id}.scale`];
  assert.equal(scaleKeys.length, 4, 'in / hold / end plateau');
  assert.deepEqual(scaleKeys.map((k) => k.v), [1, 1.6, 1.6, 1]);
  assert.equal(scaleKeys[1].t, secondsToTicks(0.55), 'lead-in before the click');
  const xKeys = zoomClip.keyframes[`effects.${fx.id}.x`];
  assert.equal(xKeys[1].v, 0.3);
  assert.equal(xKeys[1].v, xKeys[2].v, 'the pinned point holds during the zoom');

  const ringClip = ringTrack.clips[0];
  assert.equal(ringClip.metadata.auto, AUTO_META.click);
  assert.equal(ringClip.shape.kind, 'ellipse');
  assert.equal(ringClip.startTicks, secondsToTicks(2));
  const widthKeys = ringClip.keyframes['shape.width'];
  assert.deepEqual(widthKeys.map((k) => k.v), [0.03, 0.3]);
  const heightKeys = ringClip.keyframes['shape.height'];
  assert.ok(Math.abs(heightKeys[1].v / widthKeys[1].v - 1920 / 1080) < 1e-6, 'ellipse stays round on 16:9');

  const manualVideo = store.state.tracks.find((t) => t.kind === 'video');
  assert.equal(manualVideo.clips[0].metadata.auto, undefined, 'manual clips are untouched');
  assert.ok(tracks.indexOf(manualVideo) > tracks.indexOf(ringTrack), 'AI stack stays above the footage');

  store.undo();
  assert.equal(store.state.tracks.length, 1);
  assert.equal(store.state.tracks[0].clips.length, 1);
});

test('apply() builds interval zooms when asked', () => {
  const { app } = makeApp();
  const auto = new AutoDirector(app);
  const summary = auto.apply({
    range: { inTicks: 0, outTicks: secondsToTicks(18) },
    mode: 'interval',
    intervalSeconds: 6,
    rings: true,
  });
  assert.equal(summary.zooms, 3);
  assert.equal(summary.rings, 3);
});

test('subtitle cues become text clips that follow cuts', () => {
  const { app, store } = makeApp();
  const auto = new AutoDirector(app);
  const range = { inTicks: 0, outTicks: secondsToTicks(10) };
  const summary = auto.apply({
    range,
    zooms: false,
    cues: [{ startMs: 1000, endMs: 3000, text: 'こんにちは世界' }],
  });

  assert.equal(summary.subtitles, 1);
  const subtitleTrack = tracksOf(store).find((t) => t.name === '字幕（AI）');
  assert.ok(subtitleTrack);
  assert.equal(subtitleTrack.kind, 'text');
  assert.equal(tracksOf(store)[0].id, subtitleTrack.id, 'subtitles render on top of the picture');
  const cueClip = subtitleTrack.clips[0];
  assert.equal(cueClip.metadata.auto, AUTO_META.subtitle);
  assert.equal(cueClip.text.content, 'こんにちは世界');
  assert.equal(cueClip.startTicks, secondsToTicks(1));
  assert.equal(cueClip.durationTicks, secondsToTicks(2));
  assert.ok(cueClip.text.fontSize > 0.05 && cueClip.text.fontSize < 0.08);
});

test('subtitle offset shifts the cues while keeping the text', () => {
  const { app, store } = makeApp();
  const auto = new AutoDirector(app);
  auto.apply({
    range: { inTicks: 0, outTicks: secondsToTicks(10) },
    zooms: false,
    subtitleOffsetMs: 500,
    cues: [{ startMs: 1000, endMs: 2000, text: 'ずらす' }],
  });
  const track = tracksOf(store).find((t) => t.name === '字幕（AI）');
  assert.equal(track.clips[0].startTicks, secondsToTicks(1.5));
});

test('removeAutoObjects deletes only AI content', () => {
  const { app, store, clip } = makeApp();
  const auto = new AutoDirector(app);
  auto.apply({
    range: { inTicks: 0, outTicks: secondsToTicks(10) },
    clicks: [{ ticks: secondsToTicks(2), x: 0.3, y: 0.4, strength: 2 }],
    zooms: true,
    rings: true,
  });
  auto.apply({
    range: { inTicks: 0, outTicks: secondsToTicks(10) },
    zooms: false,
    cues: [{ startMs: 0, endMs: 2000, text: '字幕' }],
  });
  assert.equal(tracksOf(store).length, 4);

  const removedZoom = auto.removeAutoObjects(AUTO_META.zoom);
  assert.equal(removedZoom, 1);
  assert.equal(tracksOf(store).find((t) => t.name.includes('ズーム（AI）')), undefined);

  const removedRest = auto.removeAutoObjects();
  assert.equal(removedRest, 2);
  assert.equal(tracksOf(store).length, 1, 'only the manual video track survives');
  assert.equal(store.state.tracks[0].clips[0].id, clip.id);
  assert.ok(!tracksOf(store).some((t) => t.name?.includes('（AI）')));
});

test('TICKS_PER_SECOND based positions stay exact', () => {
  const { app, store } = makeApp();
  const auto = new AutoDirector(app);
  auto.apply({
    range: { inTicks: 0, outTicks: 10 * TICKS_PER_SECOND },
    clicks: [{ ticks: 2 * TICKS_PER_SECOND, x: 0.5, y: 0.5, strength: 1 }],
    zooms: true,
  });
  const zoomTrack = tracksOf(store).find((t) => t.name.includes('ズーム（AI）'));
  const zoomClip = zoomTrack.clips[0];
  assert.ok(Number.isInteger(zoomClip.startTicks));
  assert.ok(Number.isInteger(zoomClip.durationTicks));
  for (const list of Object.values(zoomClip.keyframes)) {
    for (const kf of list) assert.ok(Number.isInteger(kf.t));
  }
});
