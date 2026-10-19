/**
 * Build the Qelvoryn demo project and render demo/demo.mp4 with the real
 * engine.
 *
 *   node tools/make-demo.mjs [--project-only] [--probe] [--frames-only] [--seconds=N]
 *
 * Requirements (optional dev tooling, not needed to use the editor):
 *   - Google Chrome or Microsoft Edge (headless rendering)
 *   - ffmpeg on PATH (encoding + soundtrack mux)
 *
 * The app itself stays dependency-free: frames are rendered by loading the
 * real editor in headless Chrome and calling its compositor (exportStill),
 * then encoded with ffmpeg.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createProject, createTrack, createClip, createEffect, normalizeProject,
  subtitleTextStyle,
} from '../src/core/model.js';
import { secondsToTicks } from '../src/core/time.js';
import { addKeyframe } from '../src/core/keyframes.js';
import { PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION } from '../src/core/persist.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = path.join(root, 'demo');
const FPS = 30;
const DURATION_SEC = 20;
const WIDTH = 1280;
const HEIGHT = 720;
const TPS = 120000;

const args = new Set(process.argv.slice(2));
const framesOnly = args.has('--frames-only');
const projectOnly = args.has('--project-only');
const secondsArg = process.argv.slice(2).find((arg) => arg.startsWith('--seconds='));
const renderSeconds = secondsArg ? Number(secondsArg.split('=')[1]) : DURATION_SEC;

const sec = (value) => secondsToTicks(value);
const round3 = (value) => Math.round(value * 1000) / 1000;

// ---------------------------------------------------------------------------
// 1. Demo project (fully synthetic: shapes + text + effects, no media)
// ---------------------------------------------------------------------------

function keys(clip, param, list) {
  for (const [t, v, interp = 'easeInOut'] of list) {
    addKeyframe(clip, param, sec(t), v, interp);
  }
}

function shape(kind, extra = {}) {
  return {
    kind,
    width: 0.3,
    height: 0.3,
    radius: 0.2,
    points: 5,
    fill: '#ffffff',
    fillAlpha: 1,
    stroke: '#000000',
    strokeWidth: 0,
    ...extra,
  };
}

function subtitle(text, start, end) {
  const pad = 0.25;
  const length = (end - start) + pad * 2;
  const clip = createClip('text', {
    name: text.slice(0, 18),
    startTicks: sec(start - pad),
    durationTicks: sec(length),
    text: subtitleTextStyle(text, { fontSize: 0.05 }),
    transform: { x: 0.5, y: 0.855 },
  });
  keys(clip, 'opacity', [[0, 0], [pad, 1, 'easeOut'], [length - pad, 1], [length, 0, 'easeIn']]);
  return clip;
}

function titleClip(content, opts = {}) {
  const clip = createClip('text', {
    name: content.slice(0, 18),
    startTicks: sec(opts.start ?? 0),
    durationTicks: sec(opts.duration ?? 3),
    text: {
      content,
      fontSize: opts.fontSize ?? 0.09,
      fontWeight: opts.fontWeight ?? 800,
      color: opts.color ?? '#ffffff',
      strokeColor: '#06231f',
      strokeWidth: opts.strokeWidth ?? 0,
      align: 'center',
      valign: 'middle',
      maxWidth: 0.9,
      shadow: { enabled: true, x: 0, y: opts.shadowY ?? 4, blur: opts.shadowBlur ?? 18, color: '#000000', alpha: 0.55 },
    },
    transform: { x: 0.5, y: opts.y ?? 0.5 },
  });
  return clip;
}

function buildProject() {
  const project = createProject({
    name: 'Qelvoryn デモ',
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    backgroundColor: '#0b1020',
  });

  const layer = (name) => createTrack('video', { name });
  const subtitles = layer('字幕');
  const grading = layer('演出');
  const camera = layer('カメラ');
  const light = layer('光');
  const shapes = layer('図形');
  const titles = layer('タイトル');
  const background = layer('背景');
  project.tracks.push(subtitles, grading, camera, light, shapes, titles, background);

  // ---- background ---------------------------------------------------------
  background.clips.push(createClip('shape', {
    name: '背景',
    startTicks: 0,
    durationTicks: sec(DURATION_SEC),
    shape: shape('rect', { width: 1.02, height: 1.02, fill: '#0b1020', strokeWidth: 0 }),
  }));

  const disc = (fill, w, start, end, alpha, blurRadius) => {
    const clip = createClip('shape', {
      name: '光',
      startTicks: 0,
      durationTicks: sec(DURATION_SEC),
      shape: shape('ellipse', { width: w, height: w, fill, fillAlpha: alpha, strokeWidth: 0 }),
      effects: [createEffect('blur', { radius: blurRadius, quality: 1 })],
    });
    keys(clip, 'transform.x', [[0, start[0]], [DURATION_SEC, end[0]]]);
    keys(clip, 'transform.y', [[0, start[1]], [DURATION_SEC, end[1]]]);
    keys(clip, 'transform.scaleX', [[0, 0.94], [10, 1.06], [DURATION_SEC, 0.97]]);
    keys(clip, 'transform.scaleY', [[0, 0.94], [10, 1.06], [DURATION_SEC, 0.97]]);
    return clip;
  };
  light.clips.push(disc('#123f3d', 0.7, [0.16, 0.72], [0.28, 0.62], 0.75, 60));
  light.clips.push(disc('#221a4a', 0.85, [0.84, 0.24], [0.72, 0.38], 0.7, 70));
  light.clips.push(disc('#3a1828', 0.5, [0.8, 0.88], [0.9, 0.74], 0.55, 50));

  const ring = (w, stroke, alpha, start, end, spin, scaleA, scaleB) => {
    const clip = createClip('shape', {
      name: 'リング',
      startTicks: 0,
      durationTicks: sec(DURATION_SEC),
      opacity: alpha,
      shape: shape('ellipse', { width: w, height: w, fillAlpha: 0, stroke, strokeWidth: 0.0025 }),
    });
    keys(clip, 'transform.x', [[0, start[0]], [DURATION_SEC, end[0]]]);
    keys(clip, 'transform.y', [[0, start[1]], [DURATION_SEC, end[1]]]);
    keys(clip, 'transform.rotation', [[0, 0, 'linear'], [DURATION_SEC, spin, 'linear']]);
    keys(clip, 'transform.scaleX', [[0, scaleA], [10, scaleB], [DURATION_SEC, scaleA]]);
    keys(clip, 'transform.scaleY', [[0, scaleA], [10, scaleB], [DURATION_SEC, scaleA]]);
    return clip;
  };
  light.clips.push(ring(0.62, '#34d3c0', 0.45, [0.36, 0.5], [0.42, 0.46], 75, 0.96, 1.06));
  light.clips.push(ring(0.3, '#a07ce0', 0.55, [0.78, 0.3], [0.72, 0.36], -120, 0.95, 1.1));

  const dot = (color, size, x, y, driftX, driftY) => {
    const clip = createClip('shape', {
      name: 'ドット',
      startTicks: 0,
      durationTicks: sec(DURATION_SEC),
      shape: shape('ellipse', { width: size, height: size, fill: color, fillAlpha: 1, strokeWidth: 0 }),
      effects: [createEffect('glow', { strength: 0.8, radius: 26 })],
    });
    keys(clip, 'transform.x', [[0, x], [10, x + driftX], [DURATION_SEC, x]]);
    keys(clip, 'transform.y', [[0, y], [10, y + driftY], [DURATION_SEC, y]]);
    keys(clip, 'opacity', [[0, 0.5], [6, 1], [13, 0.55], [DURATION_SEC, 0.9]]);
    return clip;
  };
  light.clips.push(dot('#34d3c0', 0.02, 0.16, 0.3, 0.06, -0.05));
  light.clips.push(dot('#a07ce0', 0.016, 0.86, 0.62, -0.05, -0.08));
  light.clips.push(dot('#f6ad55', 0.012, 0.68, 0.18, 0.04, 0.06));

  // ---- floating star, ring and pill --------------------------------------
  const star = createClip('shape', {
    name: 'スター',
    startTicks: 0,
    durationTicks: sec(DURATION_SEC),
    shape: shape('star', {
      width: 0.085, height: 0.085, points: 5, radius: 0.45,
      fill: '#f6ad55', fillAlpha: 1, stroke: '#ffe0b0', strokeWidth: 0.0035,
    }),
    effects: [createEffect('glow', { strength: 0.7, radius: 30 })],
  });
  keys(star, 'transform.x', [
    [0, 0.18], [4, 0.3], [8, 0.22], [12, 0.34], [16, 0.24], [20, 0.3],
  ]);
  keys(star, 'transform.y', [
    [0, 0.28], [4, 0.2], [8, 0.32], [12, 0.24], [16, 0.3], [20, 0.22],
  ]);
  keys(star, 'transform.rotation', [[0, 0, 'linear'], [20, 340, 'linear']]);
  keys(star, 'transform.scaleX', [[2, 0.85], [6, 1.1], [10, 0.9], [14, 1.15], [18, 0.95]]);
  keys(star, 'transform.scaleY', [[2, 0.85], [6, 1.1], [10, 0.9], [14, 1.15], [18, 0.95]]);
  shapes.clips.push(star);

  const pill = createClip('shape', {
    name: 'ピル',
    startTicks: sec(5),
    durationTicks: sec(10),
    shape: shape('rect', {
      width: 0.16, height: 0.06, radius: 0.5,
      fill: '#34d3c0', fillAlpha: 0.85, strokeWidth: 0,
    }),
    effects: [createEffect('dropShadow', { x: 0, y: 6, blur: 18, color: '#34d3c0', alpha: 0.45 })],
  });
  keys(pill, 'transform.x', [[0, 0.68], [5, 0.62], [10, 0.7]]);
  keys(pill, 'transform.y', [[0, 0.62], [5, 0.58], [10, 0.64]]);
  keys(pill, 'transform.rotation', [[0, -8], [10, 8]]);
  keys(pill, 'opacity', [[0, 0], [1, 1], [9, 1], [10, 0, 'easeIn']]);
  shapes.clips.push(pill);

  // ---- titles -------------------------------------------------------------
  const title = titleClip('Qelvoryn', {
    start: 0.35, duration: 4.9, fontSize: 0.17, y: 0.42, shadowY: 6, shadowBlur: 24,
  });
  keys(title, 'opacity', [[0, 0], [0.6, 1, 'easeOut'], [4.35, 1], [4.9, 0, 'easeIn']]);
  keys(title, 'transform.scaleX', [[0, 0.94], [0.9, 1, 'easeOut']]);
  keys(title, 'transform.scaleY', [[0, 0.94], [0.9, 1, 'easeOut']]);
  titles.clips.push(title);

  const tagline = titleClip('ブラウザだけで完結する動画編集', {
    start: 1.0, duration: 4.0, fontSize: 0.045, fontWeight: 600, color: '#9fb3c8', y: 0.53, shadowBlur: 10,
  });
  keys(tagline, 'opacity', [[0, 0], [0.7, 1, 'easeOut'], [3.6, 1], [4.0, 0, 'easeIn']]);
  titles.clips.push(tagline);

  const endTitle = titleClip('Qelvoryn', {
    start: DURATION_SEC - 3.4, duration: 3.4, fontSize: 0.11, y: 0.44,
  });
  keys(endTitle, 'opacity', [[0, 0], [0.8, 1, 'easeOut']]);
  keys(endTitle, 'transform.scaleX', [[0, 0.96], [1, 1, 'easeOut']]);
  keys(endTitle, 'transform.scaleY', [[0, 0.96], [1, 1, 'easeOut']]);
  titles.clips.push(endTitle);

  const url = titleClip('github.com/rinderdragon0823/Qelvoryn', {
    start: DURATION_SEC - 3.0, duration: 3.0, fontSize: 0.032, fontWeight: 500, color: '#8fa3b8',
    y: 0.545, shadowBlur: 0, shadowY: 0,
  });
  keys(url, 'opacity', [[0, 0], [0.9, 1, 'easeOut']]);
  titles.clips.push(url);

  // ---- subtitles ----------------------------------------------------------
  subtitles.clips.push(subtitle('YMM4 方式のレイヤー編集', 2.1, 5.5));
  subtitles.clips.push(subtitle('キーフレームで自由にアニメーション', 5.9, 9.3));
  subtitles.clips.push(subtitle('字幕もワンクリックで追加', 9.7, 12.9));
  subtitles.clips.push(subtitle('カメラズームで自動演出', 13.3, 16.4));
  subtitles.clips.push(subtitle('そのまま動画に書き出し', 16.8, 19.5));

  // ---- frame effects ------------------------------------------------------
  grading.clips.push(createClip('effect', {
    name: 'ビネット',
    startTicks: 0,
    durationTicks: sec(DURATION_SEC),
    effects: [createEffect('frameVignette')],
  }));

  const zoom = createClip('effect', {
    name: 'カメラズーム',
    startTicks: sec(12.4),
    durationTicks: sec(3.2),
    effects: [createEffect('cameraTransform', { scale: 1.28, x: 0.62, y: 0.44 })],
  });
  const fxId = zoom.effects[0].id;
  keys(zoom, `effects.${fxId}.scale`, [[0, 1], [0.6, 1.28], [2.6, 1.28], [3.2, 1]]);
  camera.clips.push(zoom);

  for (const track of project.tracks) {
    track.clips.sort((a, b) => a.startTicks - b.startTicks);
  }

  project.markers = [
    { tick: sec(0.4), name: 'タイトル' },
    { tick: sec(4.8), name: '図形アニメーション' },
    { tick: sec(9.7), name: '字幕' },
    { tick: sec(12.4), name: 'カメラズーム' },
    { tick: sec(16.6), name: 'エンドカード' },
  ];
  project.settings.workArea = { inTicks: 0, outTicks: sec(DURATION_SEC) };

  normalizeProject(project);
  return project;
}

// ---------------------------------------------------------------------------
// 2. Soundtrack (synthesised so the demo needs no external assets)
// ---------------------------------------------------------------------------

function buildSoundtrack() {
  const sampleRate = 44100;
  const total = Math.floor(sampleRate * DURATION_SEC);
  const left = new Float32Array(total);
  const right = new Float32Array(total);

  const chords = [
    [220.0, 261.63, 329.63], // A minor
    [174.61, 220.0, 261.63], // F major
    [261.63, 329.63, 392.0], // C major
    [196.0, 246.94, 293.66], // G major
  ];
  const arpOrder = [0, 1, 2, 1];
  const padGain = 0.055;
  const arpGain = 0.07;
  const bassGain = 0.055;
  const noiseAt = (i) => Math.sin(i * 12.9898) * 43758.5453 - Math.floor(Math.sin(i * 12.9898) * 43758.5453);

  const envelope = (t, attack, release, length) => {
    if (t < 0 || t > length) return 0;
    const a = Math.min(1, t / attack);
    const r = Math.min(1, (length - t) / release);
    return Math.max(0, Math.min(a, r));
  };

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const bar = Math.min(3, Math.floor(t / 5));
    const chord = chords[bar];
    const inBar = t - bar * 5;

    let pad = 0;
    for (let n = 0; n < chord.length; n += 1) {
      const f = chord[n];
      pad += Math.sin(2 * Math.PI * f * t + n * 0.7) * 0.6;
      pad += Math.sin(2 * Math.PI * f * 1.003 * t + 1.3) * 0.25;
    }
    const padEnv = envelope(inBar, 0.6, 0.8, 5) * (0.75 + 0.25 * Math.sin(Math.PI * Math.min(1, inBar / 5)));
    const padSample = (pad / chord.length) * padGain * padEnv;

    const bassEnv = envelope(inBar % 2.5, 0.02, 0.4, 2.5);
    const bassSample = Math.sin(2 * Math.PI * (chord[0] / 2) * t) * bassGain * bassEnv;

    const step = Math.floor(t / 0.25);
    const stepT = t - step * 0.25;
    const note = chord[arpOrder[step % arpOrder.length]] * 2;
    const pluckEnv = Math.exp(-stepT * 7) * (1 - Math.exp(-stepT * 120));
    const arpSample = (Math.sin(2 * Math.PI * note * t) + 0.35 * Math.sin(2 * Math.PI * note * 2 * t))
      * arpGain * pluckEnv;

    const air = (noiseAt(i) - 0.5) * 0.008 * envelope(inBar, 0.5, 0.6, 5);

    const sample = padSample + bassSample + arpSample + air;
    const fade = Math.min(1, t / 0.8) * Math.min(1, (DURATION_SEC - t) / 1.6);
    left[i] = Math.tanh(sample * 1.2) * fade * 0.92;
    right[i] = Math.tanh(sample * 1.2) * fade * (0.88 + 0.08 * Math.sin(t * 0.7));
  }

  const bytes = Buffer.alloc(44 + total * 4);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + total * 4, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(total * 4, 40);
  for (let i = 0; i < total; i += 1) {
    bytes.writeInt16LE(Math.max(-1, Math.min(1, left[i])) * 0x7fff, 44 + i * 4);
    bytes.writeInt16LE(Math.max(-1, Math.min(1, right[i])) * 0x7fff, 44 + i * 4 + 2);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// 3. Headless rendering with the real editor
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/vnd.microsoft.icon',
  '.md': 'text/plain; charset=utf-8',
};

function startServer(framesDir) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/__frame') {
        if (!framesDir) {
          res.writeHead(400);
          res.end('probe mode');
          return;
        }
        const name = url.searchParams.get('name') || '';
        if (!/^\d{5}\.png$/.test(name)) {
          res.writeHead(400);
          res.end('bad name');
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        fs.writeFileSync(path.join(framesDir, name), Buffer.concat(chunks));
        res.writeHead(200);
        res.end('ok');
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.resolve(root, `.${rel}`);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome または Edge が見つかりません (CHROME_PATH で指定できます)');
}

async function waitFor(fn, { timeout = 20000, interval = 200 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, interval));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
      else resolve(data.result);
      return;
    }
    if (data.method) {
      for (const callback of listeners.get(data.method) || []) callback(data.params);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (nextId += 1);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, callback) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(callback);
  };
  return { ws, ready, send, on };
}

async function runInPage({ framesDir = null, totalFrames = 1, expression = null } = {}) {
  const server = await startServer(framesDir);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const debugPort = 9333 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qelvoryn-demo-profile-'));
  const browser = findBrowser();
  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const target = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return list.find((t) => t.type === 'page');
    }, { timeout: 30000 });

    const { ws, ready, send, on } = cdpSession(target.webSocketDebuggerUrl);
    await ready;
    await send('Runtime.enable');
    await send('Page.enable');
    const loaded = new Promise((resolve) => on('Page.loadEventFired', resolve));
    await send('Page.navigate', { url: base });
    await Promise.race([loaded, sleep(20000)]);

    const expr = expression || `(async () => {
      const waitApp = await new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (window.qelvoryn) { clearInterval(timer); resolve('ok'); }
          else if (Date.now() - started > 20000) { clearInterval(timer); resolve('timeout'); }
        }, 100);
      });
      if (waitApp !== 'ok') return { error: 'app did not boot' };
      const app = window.qelvoryn;
      const res = await fetch('demo/demo.qelvoryn.json');
      const payload = await res.json();
      const project = payload.project || payload;
      app.playback.stop({ silent: true });
      app.store.load(project, { label: 'デモ' });
      const { exportStill } = await import('./src/export/exporter.js');
      const tps = ${TPS};
      const total = ${totalFrames};
      for (let i = 0; i < total; i += 1) {
        const ticks = Math.round((i * tps) / ${FPS});
        const dataUrl = await exportStill(app.mediaPool, app.store.state, ticks, 1);
        const blob = await (await fetch(dataUrl)).blob();
        const up = await fetch('/__frame?name=' + String(i).padStart(5, '0') + '.png', { method: 'POST', body: blob });
        if (!up.ok) throw new Error('frame upload failed: ' + up.status);
      }
      return { frames: total };
    })()`;

    let value = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await send('Runtime.evaluate', {
          expression: expr,
          awaitPromise: true,
          returnByValue: true,
          timeout: 900000,
        });
        if (result.exceptionDetails) {
          const detail = result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails);
          throw new Error(`レンダリング失敗: ${detail}`);
        }
        value = result.result?.value;
        break;
      } catch (err) {
        const retryable = /context was destroyed|Cannot find context|Execution context/i.test(String(err.message));
        if (attempt === 4 || !retryable) throw err;
        console.warn(`レンダリングを再試行します (${attempt}/4): ${err.message}`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(1500);
      }
    }
    if (!value || value.error) throw new Error(`レンダリング失敗: ${JSON.stringify(value)}`);
    ws.close();
    return value;
  } finally {
    try {
      child.kill();
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function renderFrames(framesDir, totalFrames) {
  return runInPage({ framesDir, totalFrames });
}

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(demoDir, { recursive: true });

  const project = buildProject();
  const projectFile = path.join(demoDir, 'demo.qelvoryn.json');
  fs.writeFileSync(projectFile, JSON.stringify({
    format: PROJECT_FILE_FORMAT,
    version: PROJECT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'Qelvoryn',
    project,
  }, null, 2), 'utf8');
  const clipCount = project.tracks.reduce((sum, t) => sum + t.clips.length, 0);
  console.log(`project: ${path.relative(root, projectFile)} (${project.tracks.length} layers, ${clipCount} clips)`);

  const audioFile = path.join(os.tmpdir(), 'qelvoryn-demo-audio.wav');
  fs.writeFileSync(audioFile, buildSoundtrack());
  console.log(`soundtrack: ${(fs.statSync(audioFile).size / 1e6).toFixed(1)} MB (temp)`);

  if (projectOnly) return;

  if (args.has('--probe')) {
    const probeExpr = `(async () => {
      const app = window.qelvoryn;
      if (!app) return { error: 'app did not boot' };
      const payload = await (await fetch('demo/demo.qelvoryn.json')).json();
      app.playback.stop({ silent: true });
      app.store.load(payload.project || payload, { label: 'デモ' });
      const p = app.store.state;
      const info = {
        size: [p.settings.width, p.settings.height],
        fps: p.settings.fps,
        bg: p.settings.backgroundColor,
        workArea: p.settings.workArea || null,
        duration: app.projectDuration(),
        layers: p.tracks.map((t) => ({ name: t.name, clips: t.clips.length })),
      };
      const { exportStill } = await import('./src/export/exporter.js');
      const dataUrl = await exportStill(app.mediaPool, app.store.state, Math.round(18.4 * 120000), 1);
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      info.row = [130, 150, 160, 400, 640, 1000, 1180, 1200].map((x) => ({ x, p: px(x, 400) }));
      return info;
    })()`;
    const value = await runInPage({ expression: probeExpr });
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  const totalFrames = Math.round(FPS * renderSeconds);
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qelvoryn-demo-frames-'));
  console.log(`rendering ${totalFrames} frames with headless Chrome...`);
  const started = Date.now();
  await renderFrames(framesDir, totalFrames);
  console.log(`rendered in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (framesOnly) {
    console.log(`frames kept in ${framesDir}`);
    return;
  }

  const videoFile = path.join(demoDir, 'demo.mp4');
  console.log('encoding demo.mp4...');
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', path.join(framesDir, '%05d.png'),
    '-i', audioFile,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-shortest',
    videoFile,
  ], { stdio: 'inherit' });

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-ss', '1.6', '-i', videoFile, '-frames:v', '1', '-update', '1', '-q:v', '3',
    path.join(demoDir, 'poster.jpg'),
  ], { stdio: 'inherit' });

  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.rmSync(audioFile, { force: true });
  const size = fs.statSync(videoFile).size;
  console.log(`video: ${path.relative(root, videoFile)} (${(size / 1e6).toFixed(2)} MB)`);
  void round3;
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
