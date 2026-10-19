/**
 * Qelvoryn browser integration tests.
 *
 * Unlike tests/*.test.js (pure logic, run in Node), these run in a real
 * browser and prove the parts that need real APIs: canvas rasterisation of
 * the compositor, WebAudio decode + waveform peaks, IndexedDB autosave and
 * the MediaRecorder export stack.  Open tests.html (via `npm run serve`)
 * and every test runs on load.
 */

import { ProjectStore } from '../../src/core/store.js';
import {
  createProject, createTrack, createClip, createAsset, projectDuration, subtitleTextStyle,
} from '../../src/core/model.js';
import { insertClip } from '../../src/core/commands.js';
import { secondsToTicks } from '../../src/core/time.js';
import { renderFrame, MediaFrameSource } from '../../src/engine/compositor.js';
import { MediaPool } from '../../src/media/mediapool.js';
import { Persistence } from '../../src/core/persist.js';
import { supportedContainers } from '../../src/export/exporter.js';
import { AutoDirector } from '../../src/auto/autodirector.js';

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

const TESTS = [];

function test(name, fn, opts = {}) {
  TESTS.push({ name, fn, opts });
}

export function assert(cond, message = 'assertion failed') {
  if (!cond) throw new Error(message);
}

export function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export async function runBrowserTests({ summary, list } = {}) {
  const out = summary || document.getElementById('summary');
  const container = list || document.getElementById('tests');
  container.innerHTML = '';
  out.querySelector('.big').textContent = '…';

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of TESTS) {
    const li = document.createElement('li');
    li.className = 'test running';
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '…';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    li.append(icon, name, meta);
    container.append(li);

    const started = performance.now();
    try {
      if (typeof entry.fn !== 'function') throw new Error('不正なテスト定義です');
      await withTimeout(entry.fn(), entry.opts.timeout ?? 20000, entry.name);
      if (entry.opts.skip) {
        li.className = 'test skip';
        icon.textContent = '−';
        skipped += 1;
      } else {
        li.className = 'test pass';
        icon.textContent = '✓';
        passed += 1;
      }
    } catch (err) {
      li.className = 'test fail';
      icon.textContent = '✕';
      failed += 1;
      const pre = document.createElement('pre');
      pre.className = 'err';
      pre.textContent = String(err?.stack || err?.message || err);
      li.append(pre);
    }
    meta.textContent = `${Math.round(performance.now() - started)}ms`;
  }

  out.querySelector('.big').textContent = failed ? `${passed} 成功 / ${failed} 失敗` : `${passed} 成功`;
  out.querySelector('.big').className = `big ${failed ? 'fail' : 'pass'}`;
  if (skipped) {
    const skipEl = document.createElement('span');
    skipEl.className = 'skip';
    skipEl.textContent = `${skipped} スキップ`;
    out.append(skipEl);
  }
  return { passed, failed, skipped };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`タイムアウト (${ms}ms): ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore({ width = 320, height = 180, fps = 30, tracks = [] } = {}) {
  const project = createProject({ name: 'browser test', width, height, fps });
  for (const t of tracks) project.tracks.push(t);
  const store = new ProjectStore(project);
  return store;
}

function makeCanvas(width = 320, height = 180) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return { canvas, ctx };
}

function pixel(ctx, x, y) {
  return [...ctx.getImageData(x, y, 1, 1).data];
}

function frameDiff(a, b) {
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) changed += 1;
  }
  return changed;
}

function redEllipseClip({ startTicks = 0, durationTicks = secondsToTicks(2), width = 0.2 } = {}) {
  return createClip('shape', {
    startTicks,
    durationTicks,
    shape: {
      kind: 'ellipse', width, height: width, fill: '#ff0000', fillAlpha: 1, strokeWidth: 0,
    },
  });
}

async function waitFor(predicate, { timeout = 8000, interval = 60 } = {}) {
  const start = performance.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (performance.now() - start > timeout) throw new Error('waitFor timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, interval));
  }
}

function wavFile({ seconds = 1, sampleRate = 8000, hz = 440, amp = 0.6 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i += 1) {
    const s = Math.sin((2 * Math.PI * hz * i) / sampleRate) * amp;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true);
  }
  return new File([new Blob([buffer], { type: 'audio/wav' })], 'tone.wav', { type: 'audio/wav' });
}

async function pngFile(color = '#00ff00', size = 64) {
  const { canvas } = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new File([blob], 'green.png', { type: 'image/png' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('renderFrame が図形クリップを実際に描画する', async () => {
  const track = createTrack('video', { name: 'V1' });
  const store = makeStore({ tracks: [track] });
  insertClip(store, track.id, redEllipseClip({ width: 0.5 }), { resolveOverlap: false });

  const mediaPool = new MediaPool(store);
  const { ctx } = makeCanvas();
  await renderFrame({
    ctx,
    project: store.state,
    timeTicks: secondsToTicks(1),
    source: new MediaFrameSource(mediaPool),
    scale: 1,
  });

  const centre = pixel(ctx, 160, 90);
  assert(centre[0] > 200 && centre[1] < 60 && centre[2] < 60, `centre pixel should be red, got ${centre}`);
  const corner = pixel(ctx, 3, 3);
  assert(corner[0] < 40 && corner[1] < 40 && corner[2] < 40, `corner should stay background, got ${corner}`);
});

test('renderFrame composites multiple layers instead of replacing them', async () => {
  const bgTrack = createTrack('video', { name: '背景' });
  const fgTrack = createTrack('video', { name: '前景' });
  const store = makeStore({ tracks: [fgTrack, bgTrack] });
  insertClip(store, bgTrack.id, createClip('shape', {
    startTicks: 0,
    durationTicks: secondsToTicks(2),
    shape: {
      kind: 'rect', width: 1.1, height: 1.1, fill: '#101820', fillAlpha: 1, strokeWidth: 0,
    },
  }), { resolveOverlap: false });
  insertClip(store, fgTrack.id, redEllipseClip({ width: 0.4 }), { resolveOverlap: false });

  const mediaPool = new MediaPool(store);
  const { ctx } = makeCanvas();
  await renderFrame({
    ctx,
    project: store.state,
    timeTicks: secondsToTicks(1),
    source: new MediaFrameSource(mediaPool),
    scale: 1,
  });

  const centre = pixel(ctx, 160, 90);
  const corner = pixel(ctx, 3, 3);
  assert(centre[0] > 200 && centre[1] < 60, `top layer is visible, got ${centre}`);
  assertEqual(corner[3], 255, `background layer stays opaque, got ${corner}`);
  assert(corner[0] > 8 && corner[0] < 40 && corner[1] < 40, `background colour shows through, got ${corner}`);
  assert(!(corner[0] === 0 && corner[1] === 0 && corner[2] === 0), 'the background clip is not lost');
});

test('renderFrame がテキストクリップを描画する', async () => {
  const track = createTrack('text', { name: 'T1' });
  const store = makeStore({ tracks: [track] });
  insertClip(store, track.id, createClip('text', {
    startTicks: 0,
    durationTicks: secondsToTicks(1),
    text: {
      content: 'Qelvoryn', fontSize: 0.3, color: '#ffffff', strokeWidth: 0,
      background: { enabled: false }, shadow: { enabled: false },
    },
  }), { resolveOverlap: false });

  const mediaPool = new MediaPool(store);
  const { ctx } = makeCanvas();
  const before = ctx.getImageData(0, 0, 320, 180);
  await renderFrame({
    ctx,
    project: store.state,
    timeTicks: secondsToTicks(0.5),
    source: new MediaFrameSource(mediaPool),
    scale: 1,
  });
  const after = ctx.getImageData(0, 0, 320, 180);
  const changed = frameDiff(before.data, after.data);
  assert(changed > 150, `text should light up many pixels, changed ${changed}`);
});

test('自動演出ズームが合成結果を実際に変える (描画順の検証)', async () => {
  const video = createTrack('video', { name: 'V1' });
  const store = makeStore({ tracks: [video] });
  insertClip(store, video.id, redEllipseClip({ startTicks: 0, durationTicks: secondsToTicks(4), width: 0.2 }), { resolveOverlap: false });

  const mediaPool = new MediaPool(store);
  const source = () => new MediaFrameSource(mediaPool);

  const { ctx: plainCtx } = makeCanvas();
  await renderFrame({ ctx: plainCtx, project: store.state, timeTicks: secondsToTicks(2), source: source(), scale: 1 });
  const plain = [...plainCtx.getImageData(0, 0, 320, 180).data];

  const app = {
    store,
    mediaPool,
    projectDuration: () => projectDuration(store.state),
    selectTrack: () => {},
  };
  const auto = new AutoDirector(app);
  auto.apply({
    range: { inTicks: 0, outTicks: secondsToTicks(4) },
    clicks: [{ ticks: secondsToTicks(2), x: 0.5, y: 0.5, strength: 2 }],
    zooms: true,
    rings: false,
    zoomLevel: 2,
  });

  const { ctx: zoomCtx } = makeCanvas();
  await renderFrame({ ctx: zoomCtx, project: store.state, timeTicks: secondsToTicks(2), source: source(), scale: 1 });
  const zoomed = [...zoomCtx.getImageData(0, 0, 320, 180).data];

  const changed = frameDiff(plain, zoomed);
  assert(changed > 500, `zoom must affect the composite (changed ${changed} pixels)`);
  const edge = pixel(zoomCtx, 160 + 55, 90);
  assert(edge[0] > 200 && edge[1] < 60, `the zoomed ellipse should reach x=215, got ${edge}`);
  const stillOutside = pixel(zoomCtx, 160 + 70, 90);
  assert(stillOutside[0] < 60, `x=230 should stay outside even at 2x, got ${stillOutside}`);
});

test('字幕レイヤーが映像の上に描画される', async () => {
  const video = createTrack('video', { name: 'V1' });
  const store = makeStore({ tracks: [video] });
  insertClip(store, video.id, redEllipseClip({ width: 0.6 }), { resolveOverlap: false });

  const mediaPool = new MediaPool(store);
  const source = () => new MediaFrameSource(mediaPool);
  const { ctx: baseCtx } = makeCanvas();
  await renderFrame({ ctx: baseCtx, project: store.state, timeTicks: secondsToTicks(1), source: source(), scale: 1 });
  const base = [...baseCtx.getImageData(0, 0, 320, 180).data];

  const subtitleTrack = createTrack('text', { name: '字幕' });
  store.transact('字幕レイヤーを追加', () => {
    store.touch(['tracks']);
    store.state.tracks.unshift(subtitleTrack);
  });
  insertClip(store, subtitleTrack.id, createClip('text', {
    name: '字幕',
    startTicks: 0,
    durationTicks: secondsToTicks(2),
    text: subtitleTextStyle('字幕テスト'),
    transform: { x: 0.5, y: 0.86 },
  }), { resolveOverlap: false });

  const { ctx: subCtx } = makeCanvas();
  await renderFrame({ ctx: subCtx, project: store.state, timeTicks: secondsToTicks(1), source: source(), scale: 1 });
  const withSub = [...subCtx.getImageData(0, 0, 320, 180).data];
  const changed = frameDiff(base, withSub);
  assert(changed > 60, `subtitle text must be visible above the picture (changed ${changed} pixels)`);
  assertEqual(store.state.tracks.indexOf(subtitleTrack), 0, 'subtitle track is the top layer');
});

test('MediaPool が実画像ファイルを読み込んで描画する', async () => {
  const track = createTrack('video', { name: 'V1' });
  const store = makeStore({ tracks: [track] });
  const mediaPool = new MediaPool(store);

  const [assetId] = await mediaPool.importFiles([await pngFile('#00ff00')]);
  assert(assetId, 'import assigned an asset id');
  assert(store.state.assets[assetId], 'asset is in the project');
  await waitFor(() => store.state.assets[assetId].status === 'ready' || store.state.assets[assetId].status === 'error');
  assertEqual(store.state.assets[assetId].status, 'ready', 'probe finished');
  assertEqual(store.state.assets[assetId].kind, 'image');

  const url = await mediaPool.getURL(assetId);
  assert(url && url.startsWith('blob:'), 'asset exposes a blob URL');
  const image = await mediaPool.getImage(assetId);
  assert(image && image.width === 64, 'image decodes with real dimensions');

  insertClip(store, track.id, createClip('image', {
    assetId, startTicks: 0, durationTicks: secondsToTicks(1),
  }), { resolveOverlap: false });

  const { ctx } = makeCanvas();
  await renderFrame({
    ctx,
    project: store.state,
    timeTicks: secondsToTicks(0.5),
    source: new MediaFrameSource(mediaPool),
    scale: 1,
  });
  const centre = pixel(ctx, 160, 90);
  assert(centre[1] > 200 && centre[0] < 60, `centre should show the green image, got ${centre}`);
});

test('MediaPool が実音声をデコードして実波形を計算する', async () => {
  const store = makeStore({ tracks: [] });
  const mediaPool = new MediaPool(store);
  const [assetId] = await mediaPool.importFiles([wavFile({ seconds: 1, hz: 440, amp: 0.6 })]);

  const buffer = await mediaPool.getAudioBuffer(assetId);
  assert(buffer, 'audio decodes');
  assert(buffer.duration > 0.9 && buffer.duration < 1.1, `decoded duration ~1s, got ${buffer.duration}`);

  const peaks = await mediaPool.getPeaks(assetId);
  let maxPeak = 0;
  let maxRms = 0;
  for (let i = 0; i < peaks.max.length; i += 1) {
    maxPeak = Math.max(maxPeak, Math.abs(peaks.max[i]), Math.abs(peaks.min[i]));
    maxRms = Math.max(maxRms, peaks.rms[i]);
  }
  assert(maxPeak > 0.5, `peaks reach the 0.6 sine amplitude, got ${maxPeak}`);
  assert(maxRms > 0.3, `RMS of a 0.6 sine is ~0.42, got ${maxRms}`);
  assert(mediaPool.hasPeaks(assetId), 'peaks are cached');
});

test('自動保存が IndexedDB を経て復元される', async () => {
  const track = createTrack('video', { name: 'V1' });
  const store = makeStore({ tracks: [track] });
  insertClip(store, track.id, createClip('shape', { startTicks: 0, durationTicks: secondsToTicks(1) }), { resolveOverlap: false });

  const app = {
    store,
    mediaPool: new MediaPool(store),
    projectDuration: () => projectDuration(store.state),
    serializeSession: () => ({ playheadTicks: 12345, zoom: 40 }),
  };
  const persistence = new Persistence(app);
  const saved = await persistence.saveNow();
  assert(saved === true, 'saveNow reports success');

  const project2 = createProject({ name: 'second' });
  const store2 = new ProjectStore(project2);
  const app2 = { store: store2, mediaPool: new MediaPool(store2) };
  const persistence2 = new Persistence(app2);
  const restored = await persistence2.restore();
  assert(restored && restored.project, 'restore returns the autosaved project');
  assertEqual(restored.project.name, 'browser test', 'project name round trips');
  store2.load(restored.project, {});
  assertEqual(store2.state.tracks.length, 1);
  assertEqual(store2.state.tracks[0].clips.length, 1, 'the clip survives the reload');
  assertEqual(restored.session?.playheadTicks, 12345, 'session state round trips');

  await persistence2.clear();
  const cleared = await persistence2.restore();
  assert(cleared === null, 'clear() removes the autosave');
});

test('MediaRecorder 書き出しスタックが実フレームを記録する', async () => {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is unavailable in this browser');
  }
  const containers = supportedContainers();
  assert(containers.length > 0, 'at least one container is supported');

  const { canvas, ctx } = makeCanvas(160, 90);
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: containers[0].mime, videoBitsPerSecond: 500000 });
  const chunks = [];
  recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  recorder.start(100);
  const start = performance.now();
  await new Promise((resolve) => {
    const draw = () => {
      const u = (performance.now() - start) / 400;
      ctx.fillStyle = `hsl(${(u * 360) % 360} 90% 50%)`;
      ctx.fillRect(0, 0, 160, 90);
      if (performance.now() - start < 400) requestAnimationFrame(draw);
      else resolve();
    };
    requestAnimationFrame(draw);
  });
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());

  const size = chunks.reduce((sum, c) => sum + c.size, 0);
  assert(size > 1000, `the recorder produced real data (${size} bytes, ${containers[0].mime})`);
});

test('append は {node} オブジェクトや非 Node 値でもアプリを壊さない', async () => {
  const { append, el } = await import('../../src/ui/dom.js');
  const host = document.createElement('div');
  const span = el('span', { text: 'x' });
  append(host, [{ node: span }, 123, null, 'text', false]);
  assert(host.childElementCount === 1, 'span が展開されて追加される');
  assert(host.textContent.includes('text'), '文字列はテキストノードになる');
});

test('インスペクタが全タブで例外なく描画される (トラック/クリップ選択)', async () => {
  const { Inspector } = await import('../../src/ui/inspector.js');
  const track = createTrack('video', { name: 'V1' });
  const store = makeStore({ tracks: [track] });
  const clip = redEllipseClip({});
  insertClip(store, track.id, clip, { resolveOverlap: false });

  const session = { selection: [], selectedTrackId: track.id, playheadTicks: 0 };
  const app = {
    store,
    session,
    mediaPool: { blobs: new Map() },
    projectDuration: () => projectDuration(store.state),
  };

  const inspector = new Inspector(app);
  assert(inspector.bodyEl.childElementCount > 0, 'トラック選択時のパネルが描画される');

  session.selection = [clip.id];
  inspector.render();
  assert(inspector.bodyEl.childElementCount > 0, 'クリップ選択時のパネルが描画される');

  for (const tab of ['effects', 'keyframes', 'project']) {
    inspector.setActiveTab(tab);
    assert(inspector.bodyEl.childElementCount > 0, `${tab} タブが描画される`);
  }
});

test('スチル書き出しが合成済み PNG を生成する', async () => {
  const video = createTrack('video', { name: 'V1' });
  const store = makeStore({ tracks: [video] });
  insertClip(store, video.id, redEllipseClip({ width: 0.5 }), { resolveOverlap: false });
  const mediaPool = new MediaPool(store);

  const { exportStill } = await import('../../src/export/exporter.js');
  const dataUrl = await exportStill(mediaPool, store.state, secondsToTicks(1), 1);
  assert(typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png'), 'exportStill returns a PNG data URL');

  const blob = await (await fetch(dataUrl)).blob();
  assert(blob.size > 500, `still has real pixels (${blob.size} bytes)`);

  const bitmap = await createImageBitmap(blob);
  const { ctx } = makeCanvas(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const centre = pixel(ctx, Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2));
  assert(centre[0] > 200 && centre[1] < 60, `exported still shows the red shape at centre, got ${centre}`);
});
