import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePeaks, peaksRange, envelopeForWidth, DEFAULT_PEAKS_PER_SECOND,
} from '../src/media/waveform.js';
import { createProject, createTrack, createClip, createAsset } from '../src/core/model.js';
import { scheduleProjectAudio, pendingAudioAssets } from '../src/audio/audiograph.js';

function fakeBuffer(channelData, sampleRate = 48000) {
  const channels = channelData.map((c) => (c instanceof Float32Array ? c : new Float32Array(c)));
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0].length,
    getChannelData: (i) => channels[i],
  };
}

function sine(seconds, hz, amp, sampleRate = 48000) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * amp;
  return out;
}

test('computePeaks extracts real min/max/rms per bucket', () => {
  const buffer = fakeBuffer([sine(1, 1000, 0.5)]);
  const peaks = computePeaks(buffer, 100);
  assert.equal(peaks.peaksPerSecond, 100);
  assert.equal(peaks.frames, 48000);
  assert.equal(peaks.duration, 1);
  assert.equal(peaks.channels, 1);
  assert.equal(peaks.min.length, 100, 'one bucket per 10ms');
  assert.equal(peaks.max.length, 100);
  assert.equal(peaks.rms.length, 100);

  for (let b = 0; b < 100; b += 1) {
    assert.ok(peaks.max[b] > 0.48 && peaks.max[b] <= 0.51, `bucket ${b} peak`);
    assert.ok(peaks.min[b] < -0.48 && peaks.min[b] >= -0.51, `bucket ${b} trough`);
  }
  const rms = peaks.rms.reduce((a, b) => a + b, 0) / peaks.rms.length;
  assert.ok(Math.abs(rms - 0.3535) < 0.01, `sine RMS is ~0.354 (got ${rms})`);
});

test('computePeaks is honest about silence and caches per buffer', () => {
  const silent = fakeBuffer([new Float32Array(4800)]);
  const peaks = computePeaks(silent, 100);
  for (const v of peaks.max) assert.equal(v, 0);
  for (const v of peaks.min) assert.equal(v, 0);
  for (const v of peaks.rms) assert.equal(v, 0);
  assert.equal(computePeaks(silent, 100), peaks, 'same buffer + rate returns the cached object');
  assert.notEqual(computePeaks(silent, 50), peaks, 'different rate recomputes');
});

test('multi channel peaks use every channel', () => {
  const quiet = sine(0.5, 500, 0.2);
  const loud = sine(0.5, 500, 0.8);
  const peaks = computePeaks(fakeBuffer([quiet, loud]), 100);
  assert.equal(peaks.channels, 2);
  const max = Math.max(...peaks.max);
  const min = Math.min(...peaks.min);
  assert.ok(max > 0.78, `loud channel drives the max (got ${max})`);
  assert.ok(min < -0.78, `loud channel drives the min (got ${min})`);
});

test('peaksRange aggregates a time window', () => {
  const buffer = fakeBuffer([sine(1, 1000, 0.5)]);
  const peaks = computePeaks(buffer, 100);
  const half = peaksRange(peaks, 0, 0.5);
  assert.equal(half.count, 50);
  assert.ok(half.max > 0.48 && half.rms > 0.3);
  const empty = peaksRange(peaks, 5, 6);
  assert.deepEqual(empty, { min: 0, max: 0, rms: 0, count: 0 });
});

test('envelopeForWidth adapts real peaks to a pixel column count', () => {
  const buffer = fakeBuffer([sine(1, 1000, 0.5)]);
  const peaks = computePeaks(buffer, 100);
  const env = envelopeForWidth(peaks, 0, 1, 64);
  assert.equal(env.min.length, 64);
  assert.equal(env.max.length, 64);
  assert.equal(env.rms.length, 64);
  for (let c = 0; c < 64; c += 1) {
    assert.ok(env.max[c] > 0.45 && env.max[c] <= 0.51);
  }
  const empty = envelopeForWidth(null, 0, 1, 8);
  assert.equal(empty.max.length, 8);
  assert.equal(empty.max[0], 0);
});

test('DEFAULT_PEAKS_PER_SECOND is sane', () => {
  assert.ok(DEFAULT_PEAKS_PER_SECOND >= 100);
  const buffer = fakeBuffer([sine(0.25, 440, 0.5)]);
  const peaks = computePeaks(buffer);
  assert.equal(peaks.peaksPerSecond, DEFAULT_PEAKS_PER_SECOND);
  assert.ok(peaks.min.length > 0);
});

test('scheduleProjectAudio stays quiet for silent assets, reports pending ones once each', () => {
  const project = createProject({});
  const track = createTrack('audio', { name: 'A1' });
  project.tracks.push(track);
  const silent = createAsset({ name: 'silent.mp3', kind: 'audio', hasAudio: false });
  const pending = createAsset({ name: 'pending.mp3', kind: 'audio', hasAudio: true });
  project.assets[silent.id] = silent;
  project.assets[pending.id] = pending;
  track.clips.push(createClip('audio', { assetId: silent.id, startTicks: 0, durationTicks: 1000 }));
  track.clips.push(createClip('audio', { assetId: pending.id, startTicks: 2000, durationTicks: 1000 }));

  const fakeCtx = { currentTime: 0 };
  const mediaPool = { audioBuffers: new Map() };
  const { handles, missing } = scheduleProjectAudio(fakeCtx, {
    project, destination: {}, mediaPool, fromTicks: 0, toTicks: 4000,
  });
  assert.equal(handles.length, 0, 'nothing is scheduled without decoded buffers');
  assert.equal(missing.length, 1, 'the undecoded-but-audible asset is reported');
  assert.equal(missing[0].assetId, pending.id);
  assert.ok(
    !pendingAudioAssets(project, mediaPool).some((p) => p.assetId === silent.id),
    'silent assets are never queued for decoding',
  );
});
