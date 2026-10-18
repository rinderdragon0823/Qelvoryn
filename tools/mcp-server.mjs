/**
 * Qelvoryn MCP server (stdio transport, zero dependencies).
 *
 * Exposes the Qelvoryn editing core (projects, layers, clips, keyframes,
 * subtitles, effects) as MCP tools so AI assistants can open a project file,
 * edit it and save it back - all through the exact same code the browser app
 * and the test-suite use.
 *
 *   node tools/mcp-server.mjs
 *
 * Wire it into an MCP client (opencode: see opencode.json in this repo,
 * Claude Desktop: mcpServers entry with command ["node", ".../mcp-server.mjs"]).
 * Messages are newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to
 * stderr only.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { ProjectStore } from '../src/core/store.js';
import {
  createProject, createTrack, createClip, normalizeProject, projectDuration,
  subtitleTextStyle,
} from '../src/core/model.js';
import { secondsToTicks, formatTimecode, TICKS_PER_SECOND } from '../src/core/time.js';
import { PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION } from '../src/core/persist.js';
import { parseSubtitleFile } from '../src/auto/subtitles.js';
import { addKeyframe } from '../src/core/keyframes.js';
import * as cmd from '../src/core/commands.js';

const SERVER_NAME = 'qelvoryn';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createSession() {
  return { store: null, filePath: null };
}

function needStore(session) {
  if (!session.store) throw new Error('プロジェクトが開かれていません。先に qelvoryn_open_project を呼んでください。');
  return session.store;
}

function num(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} は数値で指定してください`);
  return n;
}

function ticks(value, label = '時刻') {
  return Math.max(0, Math.round(secondsToTicks(num(value, label))));
}

function localTicks(clip, timelineTicks) {
  return Math.round((timelineTicks - clip.startTicks) * (clip.speed || 1));
}

function layerName(store) {
  return `レイヤー ${store.state.tracks.length + 1}`;
}

/** Find a free layer for a clip (same spill rule as the app), else add one. */
function pickLayer(store, clipType, startTicks, durationTicks, preferredId) {
  let preferredIndex = -1;
  if (preferredId) {
    preferredIndex = store.state.tracks.findIndex((t) => t.id === preferredId);
    if (preferredIndex < 0) throw new Error(`レイヤーが見つかりません: ${preferredId}`);
  }
  const track = cmd.findTrackForClip(store.state, clipType, {
    ticks: startTicks,
    durationTicks,
    preferredIndex,
  });
  if (track) return track;
  if (preferredIndex >= 0) return store.state.tracks[preferredIndex];
  return cmd.addTrack(store, 'video', { name: layerName(store), index: 0, label: 'レイヤーを追加' });
}

function clipInfo(store, track, clip) {
  return {
    clipId: clip.id,
    layerId: track.id,
    layer: track.name,
    type: clip.type,
    name: clip.name,
    startSec: round3(clip.startTicks / TICKS_PER_SECOND),
    durationSec: round3(clip.durationTicks / TICKS_PER_SECOND),
    endSec: round3((clip.startTicks + clip.durationTicks) / TICKS_PER_SECOND),
    enabled: clip.enabled,
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function summary(session) {
  const store = session.store;
  const project = store.state;
  const duration = projectDuration(project);
  return {
    name: project.name,
    file: session.filePath,
    fps: project.settings.fps,
    resolution: `${project.settings.width}x${project.settings.height}`,
    durationSec: round3(duration / TICKS_PER_SECOND),
    duration: formatTimecode(duration, project.settings.fps),
    layers: project.tracks.map((t) => ({
      layerId: t.id, name: t.name, kind: t.kind, clips: t.clips.length,
    })),
    assets: Object.keys(project.assets).length,
    markers: (project.markers || []).length,
    workArea: project.settings.workArea && project.settings.workArea.outTicks > project.settings.workArea.inTicks
      ? {
        inSec: round3(project.settings.workArea.inTicks / TICKS_PER_SECOND),
        outSec: round3(project.settings.workArea.outTicks / TICKS_PER_SECOND),
      }
      : null,
  };
}

const ok = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

const fail = (message) => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
});

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function openProject(session, args = {}) {
  const abs = path.resolve(String(args.path || '').trim());
  if (!abs) throw new Error('path を指定してください');
  let project;
  if (fs.existsSync(abs)) {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    project = parsed && parsed.project && Array.isArray(parsed.project.tracks) ? parsed.project : parsed;
    if (!project || !Array.isArray(project.tracks)) {
      throw new Error('プロジェクトファイルの形式が不正です (tracks 配列が見つかりません)');
    }
  } else if (args.createIfMissing !== false) {
    project = createProject({ name: path.basename(abs).replace(/\.(qelvoryn\.)?json$/i, '') || '無題のプロジェクト' });
    project.tracks.push(createTrack('video', { name: 'レイヤー 1' }));
  } else {
    throw new Error(`ファイルが見つかりません: ${abs}`);
  }
  normalizeProject(project);
  session.store = new ProjectStore(project);
  session.filePath = abs;
  return summary(session);
}

function saveProject(session, args = {}) {
  const store = needStore(session);
  const target = path.resolve(String(args.path || session.filePath || '').trim());
  if (!target) throw new Error('保存先の path を指定してください (qelvoryn_open_project で開いた場合は省略可)');
  const payload = {
    format: PROJECT_FILE_FORMAT,
    version: PROJECT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'Qelvoryn',
    project: store.state,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = JSON.stringify(payload, null, 2);
  fs.writeFileSync(target, text, 'utf8');
  session.filePath = target;
  return { saved: target, bytes: Buffer.byteLength(text, 'utf8') };
}

function listTracks(session) {
  const store = needStore(session);
  return store.state.tracks.map((t, index) => ({
    layerId: t.id, index, name: t.name, kind: t.kind, clips: t.clips.length,
    locked: t.locked, hidden: t.hidden, muted: t.muted,
  }));
}

function addLayer(session, args = {}) {
  const store = needStore(session);
  const name = args.name ? String(args.name) : layerName(store);
  const index = args.index != null ? Math.max(0, Math.round(num(args.index, 'index'))) : 0;
  const track = cmd.addTrack(store, 'video', { name, index: Math.min(index, store.state.tracks.length) });
  return { layerId: track.id, name: track.name, index: store.state.tracks.indexOf(track) };
}

function listClips(session, args = {}) {
  const store = needStore(session);
  const out = [];
  for (const track of store.state.tracks) {
    if (args.layerId && track.id !== args.layerId) continue;
    for (const clip of track.clips) out.push(clipInfo(store, track, clip));
  }
  return out;
}

function getClip(session, args = {}) {
  const store = needStore(session);
  const found = store.findClip(String(args.clipId || ''));
  if (!found) throw new Error(`クリップが見つかりません: ${args.clipId}`);
  return { ...clipInfo(store, found.track, found.clip), clip: found.clip };
}

function addText(session, args = {}) {
  const store = needStore(session);
  const text = String(args.text || '').trim();
  if (!text) throw new Error('text を指定してください');
  const subtitle = args.subtitle !== false;
  const startTicks = ticks(args.startSec ?? 0, 'startSec');
  const durationTicks = Math.max(1, ticks(args.durationSec ?? 3, 'durationSec'));
  const clip = createClip('text', {
    name: args.name ? String(args.name) : text.slice(0, 18),
    startTicks,
    durationTicks,
    text: subtitle
      ? subtitleTextStyle(text, { fontSize: args.fontSize != null ? num(args.fontSize, 'fontSize') : 0.062 })
      : {
        content: text,
        fontSize: args.fontSize != null ? num(args.fontSize, 'fontSize') : 0.09,
        fontWeight: 700,
        color: '#ffffff',
        strokeColor: '#000000',
        strokeWidth: 0.004,
        align: 'center',
        valign: 'middle',
        maxWidth: 0.9,
        shadow: { enabled: true, x: 0, y: 3, blur: 8, color: '#000000', alpha: 0.6 },
      },
    transform: {
      x: args.x != null ? num(args.x, 'x') : 0.5,
      y: args.y != null ? num(args.y, 'y') : (subtitle ? 0.86 : 0.5),
    },
  });
  const track = pickLayer(store, 'text', startTicks, durationTicks, args.layerId);
  cmd.insertClip(store, track.id, clip, { resolveOverlap: false, label: 'テキストを追加' });
  return { clipId: clip.id, layerId: track.id, layer: track.name, startSec: round3(startTicks / TICKS_PER_SECOND), durationSec: round3(durationTicks / TICKS_PER_SECOND) };
}

function addSubtitles(session, args = {}) {
  const store = needStore(session);
  let cues;
  if (args.file) {
    const filePath = path.resolve(String(args.file));
    if (!fs.existsSync(filePath)) throw new Error(`字幕ファイルが見つかりません: ${filePath}`);
    const parsed = parseSubtitleFile(fs.readFileSync(filePath, 'utf8'), path.basename(filePath), {
      secondsPerLine: num(args.secondsPerLine ?? 2.5, 'secondsPerLine'),
    });
    cues = parsed.map((c) => ({ startSec: c.startMs / 1000, endSec: c.endMs / 1000, text: c.text }));
  } else if (Array.isArray(args.cues)) {
    cues = args.cues.map((c, i) => ({
      startSec: num(c.startSec, `cues[${i}].startSec`),
      endSec: num(c.endSec ?? c.startSec + 3, `cues[${i}].endSec`),
      text: String(c.text || '').trim(),
    }));
  } else {
    throw new Error('cues 配列か file パスのどちらかを指定してください');
  }
  const offsetSec = args.offsetSec != null ? num(args.offsetSec, 'offsetSec') : 0;
  const created = [];
  for (const cue of cues) {
    if (!cue.text) continue;
    const startTicks = ticks(Math.max(0, cue.startSec + offsetSec), 'startSec');
    const durationTicks = Math.max(1, ticks(Math.max(0.2, cue.endSec - cue.startSec), 'durationSec'));
    const clip = createClip('text', {
      name: cue.text.slice(0, 18),
      startTicks,
      durationTicks,
      text: subtitleTextStyle(cue.text, { fontSize: args.fontSize != null ? num(args.fontSize, 'fontSize') : 0.062 }),
      transform: { x: 0.5, y: args.y != null ? num(args.y, 'y') : 0.86 },
      metadata: { source: 'mcp' },
    });
    const track = pickLayer(store, 'text', startTicks, durationTicks, args.layerId);
    cmd.insertClip(store, track.id, clip, { resolveOverlap: false, label: '字幕を追加' });
    created.push({ clipId: clip.id, layer: track.name, startSec: round3(startTicks / TICKS_PER_SECOND), text: cue.text });
  }
  return { count: created.length, subtitles: created };
}

function addCameraZoom(session, args = {}) {
  const store = needStore(session);
  const startTicks = ticks(args.startSec ?? 0, 'startSec');
  const durationTicks = Math.max(1, ticks(args.durationSec ?? 3, 'durationSec'));
  const scale = num(args.scale ?? 1.6, 'scale');
  if (scale < 0.05 || scale > 8) throw new Error('scale は 0.05〜8 で指定してください');
  const easeTicks = Math.max(1, ticks(args.easeSec ?? 0.6, 'easeSec'));
  const clip = createClip('effect', {
    name: `自動ズーム x${scale}`,
    startTicks,
    durationTicks,
  });
  const fx = clip.effects[0];
  fx.params.scale = scale;
  if (args.x != null) fx.params.x = num(args.x, 'x');
  if (args.y != null) fx.params.y = num(args.y, 'y');
  const path = `effects.${fx.id}.scale`;
  addKeyframe(clip, path, 0, 1, 'easeInOut');
  addKeyframe(clip, path, Math.min(easeTicks, durationTicks), scale, 'easeInOut');
  addKeyframe(clip, path, Math.max(1, durationTicks - easeTicks), scale, 'easeInOut');
  addKeyframe(clip, path, durationTicks, 1, 'easeInOut');

  let track;
  if (args.layerId) {
    track = pickLayer(store, 'effect', startTicks, durationTicks, args.layerId);
  } else {
    // Frame effects must sit above the footage to affect it.
    track = cmd.addTrack(store, 'video', { name: 'ズーム', index: 0, label: 'ズームレイヤーを追加' });
  }
  cmd.insertClip(store, track.id, clip, { resolveOverlap: false, label: '自動ズーム' });
  return {
    clipId: clip.id,
    layerId: track.id,
    layer: track.name,
    effect: 'cameraTransform',
    scale,
    startSec: round3(startTicks / TICKS_PER_SECOND),
    durationSec: round3(durationTicks / TICKS_PER_SECOND),
  };
}

function splitClip(session, args = {}) {
  const store = needStore(session);
  const found = store.findClip(String(args.clipId || ''));
  if (!found) throw new Error(`クリップが見つかりません: ${args.clipId}`);
  const at = ticks(args.atSec, 'atSec');
  if (at <= found.clip.startTicks || at >= found.clip.startTicks + found.clip.durationTicks) {
    throw new Error('atSec はクリップの範囲内 (開始より後、終了より前) にしてください');
  }
  cmd.splitAt(store, at, [found.clip.id], { label: 'クリップを分割' });
  return { clips: listClips(session, { layerId: found.track.id }) };
}

function trimClip(session, args = {}) {
  const store = needStore(session);
  const found = store.findClip(String(args.clipId || ''));
  if (!found) throw new Error(`クリップが見つかりません: ${args.clipId}`);
  const edge = args.edge === 'left' ? 'left' : 'right';
  const deltaTicks = Math.round(secondsToTicks(num(args.deltaSec, 'deltaSec')));
  cmd.trimClipEdge(store, found.clip.id, edge, deltaTicks, { label: 'クリップをトリミング' });
  return clipInfo(store, found.track, found.clip);
}

function setClipTiming(session, args = {}) {
  const store = needStore(session);
  const found = store.findClip(String(args.clipId || ''));
  if (!found) throw new Error(`クリップが見つかりません: ${args.clipId}`);
  const patch = {};
  if (args.startSec != null) patch.startTicks = ticks(args.startSec, 'startSec');
  if (args.durationSec != null) patch.durationTicks = Math.max(1, ticks(args.durationSec, 'durationSec'));
  if (args.inSec != null) patch.inTicks = ticks(args.inSec, 'inSec');
  if (!Object.keys(patch).length) throw new Error('startSec / durationSec / inSec のいずれかを指定してください');
  cmd.setClipTiming(store, found.clip.id, patch, {});
  return clipInfo(store, found.track, found.clip);
}

function setClipProp(session, args = {}) {
  const store = needStore(session);
  const clipId = String(args.clipId || '');
  const found = store.findClip(clipId);
  if (!found) throw new Error(`クリップが見つかりません: ${args.clipId}`);
  const path = String(args.path || '');
  if (!path) throw new Error('path を指定してください (例: transform.x, opacity, text.fontSize, shape.fill)');
  const playheadTicks = args.atSec != null ? ticks(args.atSec, 'atSec') : found.clip.startTicks;
  cmd.setParamValue(store, [clipId], path, args.value, { playheadTicks, label: 'パラメータを変更' });
  return { clipId, path, value: args.value, atSec: round3(playheadTicks / TICKS_PER_SECOND) };
}

function addKeyframeTool(session, args = {}) {
  const store = needStore(session);
  const found = store.findClip(String(args.clipId || ''));
  if (!found) throw new Error(`クリップが見つかりません: ${args.clipId}`);
  const path = String(args.path || '');
  if (!path) throw new Error('path を指定してください');
  const value = num(args.value, 'value');
  const timelineTicks = ticks(args.atSec ?? 0, 'atSec');
  const local = Math.max(0, localTicks(found.clip, timelineTicks));
  const interp = ['linear', 'ease', 'bezier', 'hold', 'easeInOut'].includes(args.interp) ? args.interp : 'linear';
  store.transact('キーフレームを追加', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex, 'keyframes']);
    addKeyframe(found.clip, path, local, value, interp);
  });
  return { clipId: found.clip.id, path, atSec: round3(timelineTicks / TICKS_PER_SECOND), localTicks: local, value, interp };
}

function deleteClipsTool(session, args = {}) {
  const store = needStore(session);
  const ids = Array.isArray(args.clipIds) ? args.clipIds.map(String) : [];
  if (!ids.length) throw new Error('clipIds を指定してください');
  cmd.deleteClips(store, ids, {});
  return { deleted: ids.length };
}

function duplicateClipsTool(session, args = {}) {
  const store = needStore(session);
  const ids = Array.isArray(args.clipIds) ? args.clipIds.map(String) : [];
  if (!ids.length) throw new Error('clipIds を指定してください');
  cmd.duplicateClips(store, ids, {});
  return { duplicated: ids.length, clips: listClips(session) };
}

function addMarkerTool(session, args = {}) {
  const store = needStore(session);
  const at = ticks(args.atSec, 'atSec');
  const name = args.name ? String(args.name) : 'マーカー';
  cmd.addMarker(store, at, name);
  return { atSec: round3(at / TICKS_PER_SECOND), name };
}

function setWorkArea(session, args = {}) {
  const store = needStore(session);
  let workArea = null;
  if (args.inSec != null && args.outSec != null) {
    const inTicks = ticks(args.inSec, 'inSec');
    const outTicks = ticks(args.outSec, 'outSec');
    if (outTicks <= inTicks) throw new Error('outSec は inSec より後にしてください');
    workArea = { inTicks, outTicks };
  }
  store.transact('ワークエリアを変更', () => {
    store.touch(['settings']);
    if (workArea) store.state.settings.workArea = workArea;
    else delete store.state.settings.workArea;
  });
  return { workArea: summary(session).workArea };
}

function setProject(session, args = {}) {
  const store = needStore(session);
  store.transact('プロジェクト設定を変更', () => {
    if (args.name != null) {
      store.touch(['name']);
      store.state.name = String(args.name);
    }
    const settingsPatch = {};
    if (args.fps != null) {
      const fps = num(args.fps, 'fps');
      if (fps < 1 || fps > 240) throw new Error('fps は 1〜240 で指定してください');
      settingsPatch.fps = fps;
    }
    if (args.width != null) settingsPatch.width = Math.max(16, Math.round(num(args.width, 'width')));
    if (args.height != null) settingsPatch.height = Math.max(16, Math.round(num(args.height, 'height')));
    if (args.backgroundColor != null) settingsPatch.backgroundColor = String(args.backgroundColor);
    if (Object.keys(settingsPatch).length) {
      store.touch(['settings']);
      Object.assign(store.state.settings, settingsPatch);
    }
  });
  return summary(session);
}

function listAssets(session) {
  const store = needStore(session);
  return Object.values(store.state.assets).map((a) => ({
    assetId: a.id,
    name: a.name,
    kind: a.kind,
    status: a.status,
    durationSec: round3((a.durationTicks || 0) / TICKS_PER_SECOND),
    hasVideo: a.hasVideo,
    hasAudio: a.hasAudio,
  }));
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const numProp = (description) => ({ type: 'number', description });

export const TOOLS = [
  {
    name: 'qelvoryn_open_project',
    description: 'Open a Qelvoryn project file (.qelvoryn.json) into the editor session. Creates a fresh project when the file does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the project JSON file' },
        createIfMissing: { type: 'boolean', description: 'Create a new project when the file is missing (default true)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'qelvoryn_save_project',
    description: 'Save the current project back to disk in .qelvoryn.json format.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Target path (defaults to the opened file)' } },
    },
  },
  {
    name: 'qelvoryn_project_summary',
    description: 'Summarise the open project: name, fps, resolution, duration, layers, assets, markers, work area.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'qelvoryn_list_tracks',
    description: 'List all layers (tracks) with their id, name, kind and clip count. Layer 0 renders on top.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'qelvoryn_add_layer',
    description: 'Add a new editing layer (YMM4-style stack; any clip type fits any layer).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Layer name (default レイヤー N)' },
        index: { type: 'number', description: 'Stack position, 0 = top (default 0)' },
      },
    },
  },
  {
    name: 'qelvoryn_list_clips',
    description: 'List clips (optionally of one layer) with id, layer, type, name and times in seconds.',
    inputSchema: {
      type: 'object',
      properties: { layerId: { type: 'string', description: 'Restrict to one layer id' } },
    },
  },
  {
    name: 'qelvoryn_get_clip',
    description: 'Get the full JSON of one clip (transform, effects, keyframes, text/shape settings, ...).',
    inputSchema: {
      type: 'object',
      properties: { clipId: { type: 'string' } },
      required: ['clipId'],
    },
  },
  {
    name: 'qelvoryn_add_text',
    description: 'Add a text clip. subtitle=true (default) uses the caption preset at the bottom of the frame; subtitle=false centres it as a title. Times in seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        startSec: numProp('Timeline start in seconds'),
        durationSec: numProp('Duration in seconds (default 3)'),
        subtitle: { type: 'boolean', description: 'Caption preset (default true)' },
        x: numProp('Horizontal position 0..1 (default 0.5)'),
        y: numProp('Vertical position 0..1 (default 0.86 subtitle / 0.5 title)'),
        fontSize: numProp('Font size relative to frame height'),
        layerId: { type: 'string', description: 'Force a specific layer' },
        name: { type: 'string' },
      },
      required: ['text', 'startSec'],
    },
  },
  {
    name: 'qelvoryn_add_subtitles',
    description: 'Add many subtitle clips at once from a cues array or from an SRT/VTT/plain-text file. Cue fields: startSec, endSec, text.',
    inputSchema: {
      type: 'object',
      properties: {
        cues: {
          type: 'array',
          items: {
            type: 'object',
            properties: { startSec: numProp(''), endSec: numProp(''), text: { type: 'string' } },
            required: ['startSec', 'text'],
          },
        },
        file: { type: 'string', description: 'SRT/VTT/TXT file to read instead of cues' },
        offsetSec: numProp('Shift every cue by this many seconds'),
        fontSize: numProp('Font size relative to frame height'),
        y: numProp('Vertical position 0..1 (default 0.86)'),
        layerId: { type: 'string' },
      },
    },
  },
  {
    name: 'qelvoryn_add_camera_zoom',
    description: 'Add a camera zoom (cameraTransform effect clip) on a dedicated layer above the footage, eased in and out. Times in seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        startSec: numProp('Timeline start in seconds'),
        durationSec: numProp('Duration in seconds'),
        scale: numProp('Peak zoom scale, e.g. 1.6 (default)'),
        easeSec: numProp('Ease-in/out length in seconds (default 0.6)'),
        x: numProp('Zoom centre x 0..1 (default 0.5)'),
        y: numProp('Zoom centre y 0..1 (default 0.5)'),
        layerId: { type: 'string', description: 'Use an existing layer instead of creating one' },
      },
      required: ['startSec', 'durationSec'],
    },
  },
  {
    name: 'qelvoryn_split_clip',
    description: 'Split one clip at a timeline position (keyframes are carried to both halves).',
    inputSchema: {
      type: 'object',
      properties: { clipId: { type: 'string' }, atSec: numProp('Timeline seconds inside the clip') },
      required: ['clipId', 'atSec'],
    },
  },
  {
    name: 'qelvoryn_trim_clip',
    description: 'Trim one edge of a clip by a delta in seconds (negative shortens, positive extends up to the source length).',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        edge: { type: 'string', enum: ['left', 'right'] },
        deltaSec: numProp('Signed seconds'),
      },
      required: ['clipId', 'edge', 'deltaSec'],
    },
  },
  {
    name: 'qelvoryn_set_clip_timing',
    description: 'Set clip start / duration / in-point (seconds) in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        startSec: numProp(''),
        durationSec: numProp(''),
        inSec: numProp('Media in-point'),
      },
      required: ['clipId'],
    },
  },
  {
    name: 'qelvoryn_set_clip_prop',
    description: 'Set a clip parameter (e.g. transform.x, transform.scaleX, opacity, volume, text.content, text.fontSize, shape.fill, fit, blendMode). When the parameter is animated the value is written as a keyframe at atSec.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        path: { type: 'string' },
        value: { description: 'New value (number, string or boolean)' },
        atSec: numProp('Timeline seconds for the keyframe when the parameter is animated'),
      },
      required: ['clipId', 'path', 'value'],
    },
  },
  {
    name: 'qelvoryn_add_keyframe',
    description: 'Add a keyframe to a clip parameter at a timeline position. Path examples: transform.x, opacity, effects.<effectId>.scale.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        path: { type: 'string' },
        atSec: numProp('Timeline seconds'),
        value: numProp('Keyframe value'),
        interp: { type: 'string', enum: ['linear', 'ease', 'easeInOut', 'bezier', 'hold'] },
      },
      required: ['clipId', 'path', 'atSec', 'value'],
    },
  },
  {
    name: 'qelvoryn_delete_clips',
    description: 'Delete clips by id.',
    inputSchema: {
      type: 'object',
      properties: { clipIds: { type: 'array', items: { type: 'string' } } },
      required: ['clipIds'],
    },
  },
  {
    name: 'qelvoryn_duplicate_clips',
    description: 'Duplicate clips (new ids, placed right after the originals).',
    inputSchema: {
      type: 'object',
      properties: { clipIds: { type: 'array', items: { type: 'string' } } },
      required: ['clipIds'],
    },
  },
  {
    name: 'qelvoryn_add_marker',
    description: 'Add a timeline marker.',
    inputSchema: {
      type: 'object',
      properties: { atSec: numProp('Timeline seconds'), name: { type: 'string' } },
      required: ['atSec'],
    },
  },
  {
    name: 'qelvoryn_set_work_area',
    description: 'Set (or with both omitted clear) the export work area.',
    inputSchema: {
      type: 'object',
      properties: { inSec: numProp(''), outSec: numProp('') },
    },
  },
  {
    name: 'qelvoryn_set_project',
    description: 'Change project name, fps, resolution or background colour.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        fps: numProp(''),
        width: numProp(''),
        height: numProp(''),
        backgroundColor: { type: 'string', description: 'CSS colour, e.g. #000000' },
      },
    },
  },
  {
    name: 'qelvoryn_list_assets',
    description: 'List imported media assets of the project.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const TOOL_HANDLERS = {
  qelvoryn_open_project: openProject,
  qelvoryn_save_project: saveProject,
  qelvoryn_project_summary: (s) => {
    needStore(s);
    return summary(s);
  },
  qelvoryn_list_tracks: listTracks,
  qelvoryn_add_layer: addLayer,
  qelvoryn_list_clips: listClips,
  qelvoryn_get_clip: getClip,
  qelvoryn_add_text: addText,
  qelvoryn_add_subtitles: addSubtitles,
  qelvoryn_add_camera_zoom: addCameraZoom,
  qelvoryn_split_clip: splitClip,
  qelvoryn_trim_clip: trimClip,
  qelvoryn_set_clip_timing: setClipTiming,
  qelvoryn_set_clip_prop: setClipProp,
  qelvoryn_add_keyframe: addKeyframeTool,
  qelvoryn_delete_clips: deleteClipsTool,
  qelvoryn_duplicate_clips: duplicateClipsTool,
  qelvoryn_add_marker: addMarkerTool,
  qelvoryn_set_work_area: setWorkArea,
  qelvoryn_set_project: setProject,
  qelvoryn_list_assets: listAssets,
};

// ---------------------------------------------------------------------------
// JSON-RPC / MCP dispatch
// ---------------------------------------------------------------------------

export async function handleMessage(session, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
  const id = msg.id;
  const isNotification = id === undefined || id === null;

  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (msg.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (msg.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    const handler = TOOL_HANDLERS[name];
    if (!handler) return { jsonrpc: '2.0', id, result: fail(`未知のツールです: ${name}`) };
    try {
      return { jsonrpc: '2.0', id, result: ok(handler(session, args)) };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: fail(String(err?.message || err)) };
    }
  }
  if (msg.method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (msg.method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (isNotification) return null;
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  };
}

export async function runStdio() {
  const session = createSession();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write('[qelvoryn-mcp] invalid JSON line ignored\n');
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const response = await handleMessage(session, msg);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runStdio().catch((err) => {
    process.stderr.write(`[qelvoryn-mcp] fatal: ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
}
