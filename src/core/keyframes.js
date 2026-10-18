/**
 * Qelvoryn keyframe system.
 *
 * A clip holds `keyframes: { "<paramPath>": [ {id, t, v, interp, bezier} ] }`
 * where `t` is expressed in *source* ticks relative to the clip's in-point,
 * so animations stay glued to the media when clips are moved or trimmed.
 *
 * Supported interpolations: hold, linear, easeIn, easeOut, easeInOut, bezier.
 * The easing curves are the same cubic-bezier definitions used by CSS so the
 * inspector preview matches the rendered result exactly.
 */

import { uid } from './model.js';
import { TICKS_PER_SECOND } from './time.js';

export const INTERPOLATIONS = [
  { value: 'linear', label: '直線 (Linear)' },
  { value: 'easeIn', label: 'Ease In' },
  { value: 'easeOut', label: 'Ease Out' },
  { value: 'easeInOut', label: 'Ease In Out' },
  { value: 'bezier', label: 'Cubic Bezier' },
  { value: 'hold', label: '保持 (Hold)' },
];

const EASE_CURVES = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** Cubic bezier basis. */
function bezierComponent(t, p1, p2) {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
}

function bezierDerivative(t, p1, p2) {
  const mt = 1 - t;
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/**
 * Evaluate the y of a cubic-bezier(x1,y1,x2,y2) at the given x (0..1).
 * Solves x(t)=x with Newton-Raphson, falling back to bisection.
 */
export function cubicBezierEase(x1, y1, x2, y2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const currentX = bezierComponent(t, x1, x2) - x;
    if (Math.abs(currentX) < 1e-6) return bezierComponent(t, y1, y2);
    const d = bezierDerivative(t, x1, x2);
    if (Math.abs(d) < 1e-6) break;
    t -= currentX / d;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 32; i += 1) {
    const currentX = bezierComponent(t, x1, x2);
    if (Math.abs(currentX - x) < 1e-7) break;
    if (currentX < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return bezierComponent(t, y1, y2);
}

/** Eased progress 0..1 for a keyframe segment. */
export function easeProgress(u, interp, bezier) {
  switch (interp) {
    case 'hold':
      return 0;
    case 'bezier': {
      const b = Array.isArray(bezier) && bezier.length === 4 ? bezier : [0.33, 0, 0.67, 1];
      return cubicBezierEase(b[0], b[1], b[2], b[3], u);
    }
    case 'easeIn':
    case 'easeOut':
    case 'easeInOut':
    case 'linear':
    default: {
      const c = EASE_CURVES[interp] || EASE_CURVES.linear;
      if (interp === 'linear') return u;
      return cubicBezierEase(c[0], c[1], c[2], c[3], u);
    }
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [0, 0, 0];
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]) {
  const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function interpolateValue(a, b, u) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * u;
  if (typeof a === 'boolean' || typeof b === 'boolean') return u >= 1 ? b : a;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.map((v, i) => (typeof v === 'number' && typeof b[i] === 'number' ? v + (b[i] - v) * u : (u >= 1 ? b[i] : v)));
  }
  if (typeof a === 'string' && typeof b === 'string' && a.startsWith('#') && b.startsWith('#')) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    return rgbToHex([0, 1, 2].map((i) => ca[i] + (cb[i] - ca[i]) * u));
  }
  return u >= 1 ? b : a;
}

// ---------------------------------------------------------------------------
// Static parameter access
// ---------------------------------------------------------------------------

const NUMERIC_PARAM_PATHS = new Set([
  'transform.x', 'transform.y', 'transform.scaleX', 'transform.scaleY',
  'transform.rotation', 'transform.anchorX', 'transform.anchorY',
  'opacity', 'volume', 'speed',
  'crop.left', 'crop.right', 'crop.top', 'crop.bottom',
  'mask.x', 'mask.y', 'mask.w', 'mask.h', 'mask.feather', 'mask.round',
  'text.fontSize', 'text.lineHeight', 'text.letterSpacing', 'text.strokeWidth', 'text.maxWidth',
  'text.background.alpha', 'text.background.padding', 'text.background.radius',
  'text.shadow.x', 'text.shadow.y', 'text.shadow.blur', 'text.shadow.alpha',
  'shape.width', 'shape.height', 'shape.radius', 'shape.points', 'shape.strokeWidth', 'shape.fillAlpha',
  'fades.inTicks', 'fades.outTicks',
]);

export function isNumericParamPath(path) {
  if (NUMERIC_PARAM_PATHS.has(path)) return true;
  if (path.startsWith('effects.')) {
    const [, , param] = path.split('.');
    return !['keyColor', 'color', 'enabled'].includes(param);
  }
  return false;
}

/** Read the non-animated value of a parameter path from a clip. */
export function getStaticValue(clip, path) {
  if (!clip) return undefined;
  const segs = path.split('.');
  if (segs[0] === 'effects') {
    const fx = (clip.effects || []).find((e) => e.id === segs[1]);
    if (!fx) return undefined;
    let cur = fx.params;
    for (let i = 2; i < segs.length; i += 1) cur = cur?.[segs[i]];
    return cur;
  }
  let cur = clip;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function setStaticValue(clip, path, value) {
  const segs = path.split('.');
  if (segs[0] === 'effects') {
    const fx = (clip.effects || []).find((e) => e.id === segs[1]);
    if (!fx) return false;
    let cur = fx.params;
    for (let i = 2; i < segs.length - 1; i += 1) cur = cur[segs[i]];
    cur[segs.at(-1)] = value;
    return true;
  }
  let cur = clip;
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (cur[segs[i]] == null) cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs.at(-1)] = value;
  return true;
}

// ---------------------------------------------------------------------------
// Keyframe operations
// ---------------------------------------------------------------------------

export function getKeyframeList(clip, path) {
  if (!clip?.keyframes) return null;
  const list = clip.keyframes[path];
  return Array.isArray(list) && list.length ? list : null;
}

export function isAnimated(clip, path) {
  return !!getKeyframeList(clip, path);
}

/** Paths that currently have keyframes. */
export function animatedPaths(clip) {
  return Object.keys(clip?.keyframes || {});
}

export function isEffectAnimated(clip, effectId) {
  return Object.keys(clip?.keyframes || {}).some((p) => p.startsWith(`effects.${effectId}.`));
}

export function addKeyframe(clip, path, t, value, interp = 'linear', opts = {}) {
  if (!clip.keyframes) clip.keyframes = {};
  const list = clip.keyframes[path] || (clip.keyframes[path] = []);
  const rounded = Math.max(0, Math.round(t));
  const existing = list.find((kf) => Math.abs(kf.t - rounded) < (opts.tolerance ?? 1));
  const v = value !== undefined ? value : getStaticValue(clip, path);
  if (existing) {
    existing.v = v;
    if (opts.interp) existing.interp = interp;
    return existing;
  }
  const kf = {
    id: uid('kf'),
    t: rounded,
    v,
    interp,
    bezier: opts.bezier ? [...opts.bezier] : [0.33, 0, 0.67, 1],
  };
  list.push(kf);
  list.sort((a, b) => a.t - b.t);
  return kf;
}

export function removeKeyframe(clip, path, kfId) {
  const list = clip.keyframes?.[path];
  if (!list) return false;
  const idx = list.findIndex((kf) => kf.id === kfId);
  if (idx < 0) return false;
  list.splice(idx, 1);
  if (!list.length) delete clip.keyframes[path];
  return true;
}

export function moveKeyframe(clip, path, kfId, newT) {
  const list = clip.keyframes?.[path];
  if (!list) return false;
  const kf = list.find((k) => k.id === kfId);
  if (!kf) return false;
  const target = Math.max(0, Math.round(newT));
  // Reject a move that would land exactly on another keyframe.
  if (list.some((k) => k.id !== kfId && Math.abs(k.t - target) < 1)) return false;
  kf.t = target;
  list.sort((a, b) => a.t - b.t);
  return true;
}

export function setKeyframeInterp(clip, path, kfId, interp, bezier) {
  const kf = clip.keyframes?.[path]?.find((k) => k.id === kfId);
  if (!kf) return false;
  kf.interp = interp;
  if (bezier) kf.bezier = [...bezier];
  return true;
}

export function clearKeyframes(clip, path) {
  if (!clip.keyframes) return;
  if (path) delete clip.keyframes[path];
  else clip.keyframes = {};
}

/** Drop keyframes that point at removed effects. */
export function pruneOrphanKeyframes(clip) {
  if (!clip.keyframes) return;
  const fxIds = new Set((clip.effects || []).map((e) => e.id));
  for (const path of Object.keys(clip.keyframes)) {
    if (path.startsWith('effects.')) {
      const id = path.split('.')[1];
      if (!fxIds.has(id)) delete clip.keyframes[path];
    }
  }
}

/**
 * Evaluate an animated parameter at a local (source-relative) time.
 * Returns the animated value when keyframes exist, otherwise the static value.
 */
export function evaluateParam(clip, path, localTicks, fallback) {
  const list = getKeyframeList(clip, path);
  if (!list) {
    const v = getStaticValue(clip, path);
    return v === undefined ? fallback : v;
  }
  if (list.length === 1) return list[0].v;
  const t = localTicks;
  if (t <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < list.length - 1 && list[i + 1].t <= t) i += 1;
  const a = list[i];
  const b = list[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = (t - a.t) / span;
  if (a.interp === 'hold') return a.v;
  const eased = easeProgress(u, a.interp, a.bezier);
  return interpolateValue(a.v, b.v, eased);
}

/** Human readable time inside a clip, in seconds. */
export function kfTimeLabel(t) {
  return `${(t / TICKS_PER_SECOND).toFixed(2)}s`;
}

/**
 * Sample a keyframe list into a polyline for the inspector curve editor.
 * @returns {{x:number,y:number}[]} progress/value pairs normalised to 0..1
 */
export function sampleKeyframes(list, samples = 64) {
  if (!list || list.length < 2) return [];
  const first = list[0];
  const last = list[list.length - 1];
  const span = last.t - first.t || 1;
  const values = list.map((k) => Number(k.v)).filter((v) => Number.isFinite(v));
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;
  const out = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = first.t + (span * i) / samples;
    const v = evaluateList(list, t);
    out.push({ x: i / samples, y: (v - minV) / range, value: v, t });
  }
  return out;
}

function evaluateList(list, t) {
  if (t <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < list.length - 1 && list[i + 1].t <= t) i += 1;
  const a = list[i];
  const b = list[i + 1];
  const span = b.t - a.t;
  if (span <= 0 || a.interp === 'hold') return a.v;
  const eased = easeProgress((t - a.t) / span, a.interp, a.bezier);
  return interpolateValue(a.v, b.v, eased);
}
