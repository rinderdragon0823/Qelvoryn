/**
 * Qelvoryn project data model.
 *
 * Everything the editor manipulates lives in one serialisable plain-object
 * tree so that saving, undo/redo and rendering all speak the same language:
 *
 *   Project
 *     settings   : output format
 *     assets     : media pool metadata (bytes live in IndexedDB)
 *     tracks[]   : ordered list; top of the list == topmost layer
 *     markers[]
 *     ui         : non-undoable view state (playhead, zoom, ...)
 *
 * All clips (video/image/text/audio/overlay/effect) share the same shape so
 * that generic timeline operations (move/trim/split/keyframe/effect) work
 * uniformly on every kind of content.
 */

import { secondsToTicks, TICKS_PER_SECOND } from './time.js';
import { defaultEffectParams, getEffectDef } from '../engine/effectdefs.js';

let uidCounter = 0;

/** Collision-resistant short id (no external dependency). */
export function uid(prefix = 'id') {
  uidCounter = (uidCounter + 1) % 0xffff;
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  const time = Date.now().toString(36);
  return `${prefix}_${time}${rand}${uidCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Track kinds
// ---------------------------------------------------------------------------

export const TRACK_KINDS = {
  video: { label: '動画', accepts: ['video', 'image', 'shape'], visual: true, icon: 'V' },
  image: { label: '画像', accepts: ['image', 'video', 'shape'], visual: true, icon: 'I' },
  text: { label: 'テキスト', accepts: ['text', 'shape'], visual: true, icon: 'T' },
  audio: { label: '音声', accepts: ['audio'], visual: false, icon: 'A' },
  overlay: { label: 'オーバーレイ', accepts: ['video', 'image', 'text', 'shape', 'audio'], visual: true, icon: 'O' },
  effect: { label: 'エフェクト', accepts: ['effect'], visual: true, icon: 'F' },
};

export const TRACK_KIND_ORDER = ['video', 'image', 'text', 'audio', 'overlay', 'effect'];

export const BLEND_MODES = [
  { value: 'source-over', label: '通常' },
  { value: 'multiply', label: '乗算' },
  { value: 'screen', label: 'スクリーン' },
  { value: 'overlay', label: 'オーバーレイ' },
  { value: 'darken', label: '比較(暗)' },
  { value: 'lighten', label: '比較(明)' },
  { value: 'color-dodge', label: '覆い焼き' },
  { value: 'color-burn', label: '焼き込み' },
  { value: 'hard-light', label: 'ハードライト' },
  { value: 'soft-light', label: 'ソフトライト' },
  { value: 'difference', label: '差の絶対値' },
  { value: 'exclusion', label: '除外' },
  { value: 'hue', label: '色相' },
  { value: 'saturation', label: '彩度' },
  { value: 'color', label: 'カラー' },
  { value: 'luminosity', label: '輝度' },
];

export const CLIP_TYPES = {
  video: { label: '動画', color: '#2b6cb0' },
  image: { label: '画像', color: '#2f855a' },
  text: { label: 'テキスト', color: '#b7791f' },
  shape: { label: '図形', color: '#805ad5' },
  audio: { label: '音声', color: '#2c7a7b' },
  effect: { label: 'エフェクト', color: '#9b2c2c' },
};

export const ASSET_KINDS = {
  video: { label: '動画' },
  audio: { label: '音声' },
  image: { label: '画像' },
};

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createProject(opts = {}) {
  const now = Date.now();
  const project = {
    schema: 1,
    id: uid('proj'),
    name: opts.name || '無題のプロジェクト',
    createdAt: now,
    modifiedAt: now,
    settings: {
      width: opts.width || 1920,
      height: opts.height || 1080,
      fps: opts.fps || 30,
      sampleRate: 48000,
      backgroundColor: '#000000',
    },
    assets: {},
    assetOrder: [],
    tracks: [],
    markers: [],
  };
  return project;
}

export function createTrack(kind = 'video', opts = {}) {
  const def = TRACK_KINDS[kind] || TRACK_KINDS.video;
  return {
    id: uid('trk'),
    kind,
    name: opts.name || `${def.label} ${opts.index != null ? opts.index + 1 : ''}`.trim(),
    clips: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    height: opts.height || (kind === 'audio' ? 72 : 84),
    volume: 1,
    opacity: 1,
    blendMode: 'source-over',
    color: opts.color || null,
  };
}

/** Create a fully-formed default transform. */
function defaultTransform() {
  return {
    x: 0.5,
    y: 0.5,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
  };
}

function defaultText() {
  return {
    content: 'テキスト',
    fontFamily: 'Noto Sans JP, sans-serif',
    fontSize: 0.09,
    fontWeight: 700,
    italic: false,
    color: '#ffffff',
    align: 'center',
    valign: 'middle',
    lineHeight: 1.25,
    letterSpacing: 0,
    strokeColor: '#000000',
    strokeWidth: 0,
    background: { enabled: false, color: '#000000', alpha: 0.6, padding: 0.4, radius: 0.15 },
    shadow: { enabled: true, x: 0, y: 3, blur: 8, color: '#000000', alpha: 0.65 },
    maxWidth: 0.9,
  };
}

function defaultShape() {
  return {
    kind: 'rect',
    width: 0.3,
    height: 0.3,
    radius: 0.2,
    fill: '#ffffff',
    fillAlpha: 1,
    stroke: '#000000',
    strokeWidth: 0,
    points: 5,
  };
}

function defaultMask() {
  return {
    enabled: false,
    type: 'rect',
    x: 0.5,
    y: 0.5,
    w: 0.5,
    h: 0.5,
    feather: 0.03,
    round: 0,
    invert: false,
  };
}

/**
 * @param {'video'|'image'|'text'|'shape'|'audio'|'effect'} type
 * @param {object} props
 */
export function createClip(type, props = {}) {
  const base = {
    id: uid('clip'),
    type,
    trackId: props.trackId || null,
    assetId: props.assetId || null,
    name: props.name || CLIP_TYPES[type]?.label || 'クリップ',
    color: props.color || null,
    startTicks: Math.max(0, Math.round(props.startTicks || 0)),
    durationTicks: Math.max(1, Math.round(props.durationTicks || secondsToTicks(5))),
    inTicks: Math.max(0, Math.round(props.inTicks || 0)),
    speed: props.speed != null ? props.speed : 1,
    reversed: !!props.reversed,
    enabled: props.enabled !== false,
    locked: !!props.locked,
    opacity: props.opacity != null ? props.opacity : 1,
    blendMode: props.blendMode || 'source-over',
    transform: { ...defaultTransform(), ...(props.transform || {}) },
    crop: { left: 0, right: 0, top: 0, bottom: 0, ...(props.crop || {}) },
    mask: { ...defaultMask(), ...(props.mask || {}) },
    fit: props.fit || 'contain',
    volume: props.volume != null ? props.volume : 1,
    fades: { inTicks: 0, outTicks: 0, ...(props.fades || {}) },
    effects: props.effects ? props.effects.map((e) => ({ ...e })) : [],
    keyframes: props.keyframes ? JSON.parse(JSON.stringify(props.keyframes)) : {},
    metadata: { ...(props.metadata || {}) },
  };

  if (type === 'text') base.text = { ...defaultText(), ...(props.text || {}) };
  if (type === 'shape') base.shape = { ...defaultShape(), ...(props.shape || {}) };
  if (type === 'effect') {
    base.effects = props.effects ? props.effects.map((e) => ({ ...e })) : [createEffect('cameraTransform')];
    base.opacity = 1;
    base.blendMode = 'source-over';
  }
  return base;
}

export function createEffect(type, params = {}) {
  const def = getEffectDef(type);
  return {
    id: uid('fx'),
    type,
    enabled: true,
    params: { ...defaultEffectParams(type), ...params },
    _missing: !def,
  };
}

export function createAsset(props = {}) {
  return {
    id: props.id || uid('asset'),
    name: props.name || '素材',
    kind: props.kind || 'video',
    mimeType: props.mimeType || '',
    size: props.size || 0,
    durationTicks: props.durationTicks || 0,
    width: props.width || 0,
    height: props.height || 0,
    hasVideo: props.hasVideo !== false,
    hasAudio: !!props.hasAudio,
    frameRate: props.frameRate || 0,
    sampleRate: props.sampleRate || 0,
    channels: props.channels || 0,
    addedAt: Date.now(),
    status: props.status || 'ready',
    sourceName: props.sourceName || props.name || '',
    colorSpace: props.colorSpace || '',
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findTrack(project, trackId) {
  const index = project.tracks.findIndex((t) => t.id === trackId);
  if (index < 0) return null;
  return { track: project.tracks[index], index };
}

export function findClip(project, clipId) {
  for (let ti = 0; ti < project.tracks.length; ti += 1) {
    const track = project.tracks[ti];
    for (let ci = 0; ci < track.clips.length; ci += 1) {
      if (track.clips[ci].id === clipId) {
        return { track, trackIndex: ti, clip: track.clips[ci], clipIndex: ci };
      }
    }
  }
  return null;
}

export function trackClips(track) {
  return [...track.clips].sort((a, b) => a.startTicks - b.startTicks);
}

export function clipEnd(clip) {
  return clip.startTicks + clip.durationTicks;
}

/** Duration of source material consumed by the clip (in source ticks). */
export function clipSourceSpan(clip) {
  return Math.round(clip.durationTicks * (clip.speed || 1));
}

/** Source out point (exclusive) in source time. */
export function clipSourceOut(clip) {
  return clip.inTicks + clipSourceSpan(clip);
}

/** Longest possible duration for a clip given its asset. */
export function maxDurationForClip(clip, asset) {
  if (!asset || !asset.durationTicks || clip.type === 'text' || clip.type === 'shape' || clip.type === 'effect') {
    return Infinity;
  }
  const remaining = Math.max(0, asset.durationTicks - clip.inTicks);
  return Math.round(remaining / (clip.speed || 1));
}

export function projectDuration(project) {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const end = clipEnd(clip);
      if (end > max) max = end;
    }
  }
  return max;
}

export function canTrackAcceptClip(track, clipType) {
  const def = TRACK_KINDS[track.kind];
  if (!def) return false;
  return def.accepts.includes(clipType);
}

export function tracksAcceptingKind(project, clipType) {
  const primary = {
    video: 'video',
    image: 'image',
    text: 'text',
    audio: 'audio',
    shape: 'overlay',
    effect: 'effect',
  }[clipType];
  return project.tracks.filter((t) => canTrackAcceptClip(t, clipType) && t.kind === primary)
    .concat(project.tracks.filter((t) => canTrackAcceptClip(t, clipType) && t.kind !== primary));
}

// ---------------------------------------------------------------------------
// Normalisation / migration
// ---------------------------------------------------------------------------

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Make a project safe to render no matter what was loaded from disk.
 * Missing fields get defaults, out-of-range values are clamped, orphan
 * clips are dropped.
 */
export function normalizeProject(project) {
  if (!project || typeof project !== 'object') return createProject();
  const out = project;
  out.schema = 1;
  out.name = typeof out.name === 'string' && out.name ? out.name : '無題のプロジェクト';
  out.assets = out.assets && typeof out.assets === 'object' ? out.assets : {};
  out.assetOrder = Array.isArray(out.assetOrder) ? out.assetOrder.filter((id) => !!out.assets[id]) : Object.keys(out.assets);
  for (const asset of Object.values(out.assets)) {
    asset.id = asset.id || uid('asset');
    asset.kind = ASSET_KINDS[asset.kind] ? asset.kind : 'video';
    asset.durationTicks = Math.max(0, Math.round(asset.durationTicks || 0));
  }
  const s = out.settings || {};
  out.settings = {
    width: Math.max(16, Math.round(s.width || 1920)),
    height: Math.max(16, Math.round(s.height || 1080)),
    fps: clampNumber(s.fps, 1, 240, 30),
    sampleRate: Math.round(s.sampleRate || 48000),
    backgroundColor: s.backgroundColor || '#000000',
  };
  out.tracks = Array.isArray(out.tracks) ? out.tracks.filter((t) => t && typeof t === 'object') : [];
  const seenTrackIds = new Set();
  for (const track of out.tracks) {
    track.id = track.id && !seenTrackIds.has(track.id) ? track.id : uid('trk');
    seenTrackIds.add(track.id);
    if (!TRACK_KINDS[track.kind]) track.kind = 'video';
    track.name = track.name || TRACK_KINDS[track.kind].label;
    track.clips = Array.isArray(track.clips) ? track.clips : [];
    track.locked = !!track.locked;
    track.hidden = !!track.hidden;
    track.muted = !!track.muted;
    track.solo = !!track.solo;
    track.height = clampNumber(track.height, 40, 400, 84);
    track.volume = clampNumber(track.volume, 0, 4, 1);
    track.opacity = clampNumber(track.opacity, 0, 1, 1);
    track.blendMode = track.blendMode || 'source-over';
    const seenClipIds = new Set();
    track.clips = track.clips.filter((clip) => clip && typeof clip === 'object');
    for (const clip of track.clips) {
      clip.id = clip.id && !seenClipIds.has(clip.id) ? clip.id : uid('clip');
      seenClipIds.add(clip.id);
      clip.trackId = track.id;
      if (!CLIP_TYPES[clip.type]) clip.type = 'video';
      clip.startTicks = Math.max(0, Math.round(clip.startTicks || 0));
      clip.durationTicks = Math.max(1, Math.round(clip.durationTicks || 1));
      clip.inTicks = Math.max(0, Math.round(clip.inTicks || 0));
      clip.speed = clampNumber(clip.speed, 0.1, 16, 1);
      clip.opacity = clampNumber(clip.opacity, 0, 1, 1);
      clip.volume = clampNumber(clip.volume, 0, 4, 1);
      clip.blendMode = clip.blendMode || 'source-over';
      clip.enabled = clip.enabled !== false;
      clip.locked = !!clip.locked;
      clip.reversed = !!clip.reversed;
      clip.transform = { ...defaultTransform(), ...(clip.transform || {}) };
      clip.crop = { left: 0, right: 0, top: 0, bottom: 0, ...(clip.crop || {}) };
      clip.mask = { ...defaultMask(), ...(clip.mask || {}) };
      clip.fades = { inTicks: 0, outTicks: 0, ...(clip.fades || {}) };
      clip.effects = Array.isArray(clip.effects) ? clip.effects : [];
      for (const fx of clip.effects) {
        fx.id = fx.id || uid('fx');
        fx.enabled = fx.enabled !== false;
        const def = getEffectDef(fx.type);
        if (def) fx.params = { ...defaultEffectParams(fx.type), ...(fx.params || {}) };
        else fx.params = fx.params || {};
      }
      clip.keyframes = clip.keyframes && typeof clip.keyframes === 'object' ? clip.keyframes : {};
      const effectIds = new Set(clip.effects.map((fx) => fx.id));
      for (const key of Object.keys(clip.keyframes)) {
        const list = clip.keyframes[key];
        if (!Array.isArray(list)) {
          delete clip.keyframes[key];
          continue;
        }
        // Drop keyframes that point at an effect which no longer exists.
        if (key.startsWith('effects.')) {
          const fxId = key.split('.')[1];
          if (fxId && !effectIds.has(fxId)) {
            delete clip.keyframes[key];
            continue;
          }
        }
        clip.keyframes[key] = list
          .filter((kf) => kf && Number.isFinite(Number(kf.t)))
          .map((kf) => ({
            id: kf.id || uid('kf'),
            t: Math.round(kf.t),
            v: kf.v,
            interp: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'bezier', 'hold'].includes(kf.interp) ? kf.interp : 'linear',
            bezier: Array.isArray(kf.bezier) && kf.bezier.length === 4 ? kf.bezier.map(Number) : [0.33, 0, 0.67, 1],
          }))
          .sort((a, b) => a.t - b.t);
        if (!clip.keyframes[key].length) delete clip.keyframes[key];
      }
      if (clip.type === 'text') clip.text = { ...defaultText(), ...(clip.text || {}) };
      if (clip.type === 'shape') clip.shape = { ...defaultShape(), ...(clip.shape || {}) };
      if (clip.type === 'effect' && !clip.effects.length) clip.effects = [createEffect('cameraTransform')];
      if (!clip.metadata) clip.metadata = {};
    }
    track.clips.sort((a, b) => a.startTicks - b.startTicks);
  }
  out.markers = Array.isArray(out.markers)
    ? out.markers
      .filter((m) => m && typeof m === 'object' && Number.isFinite(Number(m.tick)))
      .map((m) => ({
        id: m.id || uid('mk'),
        tick: Math.max(0, Math.round(m.tick)),
        name: m.name || 'マーカー',
        color: m.color || '#f6ad55',
      }))
    : [];
  if (out.settings.workArea) {
    const wa = out.settings.workArea;
    const inTicks = Math.max(0, Math.round(wa.inTicks || 0));
    const outTicks = Math.round(wa.outTicks || 0);
    if (outTicks > inTicks) out.settings.workArea = { inTicks, outTicks };
    else delete out.settings.workArea;
  }
  return out;
}

export const DEFAULT_CLIP_SECONDS = 5;
export { TICKS_PER_SECOND };
