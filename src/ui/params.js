/**
 * Parameter metadata: which clip properties can be edited/animated, their
 * ranges, labels and how to read/write them.  Shared by the inspector, the
 * keyframe editor and the auto-director so every property behaves the same.
 */

import { evaluateParam, getStaticValue, isNumericParamPath } from '../core/keyframes.js';
import { getEffectDef } from '../engine/effectdefs.js';
import { TICKS_PER_SECOND } from '../core/time.js';

const SPECS = {
  'transform.x': { label: '位置 X', min: -2, max: 3, step: 0.002, digits: 3, group: '変形' },
  'transform.y': { label: '位置 Y', min: -2, max: 3, step: 0.002, digits: 3, group: '変形' },
  'transform.scaleX': { label: 'スケール X', min: 0.01, max: 8, step: 0.005, digits: 3, group: '変形' },
  'transform.scaleY': { label: 'スケール Y', min: 0.01, max: 8, step: 0.005, digits: 3, group: '変形' },
  'transform.rotation': { label: '回転', min: -360, max: 360, step: 0.2, digits: 1, unit: '°', group: '変形' },
  'transform.anchorX': { label: 'アンカー X', min: -1, max: 2, step: 0.005, digits: 3, group: '変形' },
  'transform.anchorY': { label: 'アンカー Y', min: -1, max: 2, step: 0.005, digits: 3, group: '変形' },
  opacity: { label: '不透明度', min: 0, max: 1, step: 0.01, digits: 2, group: '合成' },
  volume: { label: '音量', min: 0, max: 2, step: 0.01, digits: 2, group: '音声' },
  'crop.left': { label: '左', min: 0, max: 0.95, step: 0.002, digits: 3, group: 'クロップ' },
  'crop.right': { label: '右', min: 0, max: 0.95, step: 0.002, digits: 3, group: 'クロップ' },
  'crop.top': { label: '上', min: 0, max: 0.95, step: 0.002, digits: 3, group: 'クロップ' },
  'crop.bottom': { label: '下', min: 0, max: 0.95, step: 0.002, digits: 3, group: 'クロップ' },
  'mask.x': { label: 'マスク X', min: -1, max: 2, step: 0.005, digits: 3, group: 'マスク' },
  'mask.y': { label: 'マスク Y', min: -1, max: 2, step: 0.005, digits: 3, group: 'マスク' },
  'mask.w': { label: 'マスク幅', min: 0, max: 2, step: 0.005, digits: 3, group: 'マスク' },
  'mask.h': { label: 'マスク高さ', min: 0, max: 2, step: 0.005, digits: 3, group: 'マスク' },
  'mask.feather': { label: '境界ぼかし', min: 0, max: 0.5, step: 0.002, digits: 3, group: 'マスク' },
  'mask.round': { label: '角丸', min: 0, max: 1, step: 0.01, digits: 2, group: 'マスク' },
  'text.fontSize': { label: '文字サイズ', min: 0.005, max: 1, step: 0.002, digits: 3, group: 'テキスト' },
  'text.lineHeight': { label: '行間', min: 0.5, max: 3, step: 0.01, digits: 2, group: 'テキスト' },
  'text.letterSpacing': { label: '字間', min: -0.2, max: 1, step: 0.005, digits: 3, group: 'テキスト' },
  'text.strokeWidth': { label: '縁取り太さ', min: 0, max: 0.2, step: 0.002, digits: 3, group: 'テキスト' },
  'text.maxWidth': { label: '最大幅', min: 0.05, max: 1, step: 0.005, digits: 3, group: 'テキスト' },
  'text.background.alpha': { label: '背景の不透明度', min: 0, max: 1, step: 0.01, digits: 2, group: 'テキスト' },
  'text.background.padding': { label: '背景の余白', min: 0, max: 2, step: 0.01, digits: 2, group: 'テキスト' },
  'text.background.radius': { label: '背景の角丸', min: 0, max: 2, step: 0.01, digits: 2, group: 'テキスト' },
  'text.shadow.x': { label: '影 X', min: -50, max: 50, step: 0.5, digits: 1, group: 'テキスト' },
  'text.shadow.y': { label: '影 Y', min: -50, max: 50, step: 0.5, digits: 1, group: 'テキスト' },
  'text.shadow.blur': { label: '影のぼかし', min: 0, max: 100, step: 1, digits: 0, group: 'テキスト' },
  'text.shadow.alpha': { label: '影の不透明度', min: 0, max: 1, step: 0.01, digits: 2, group: 'テキスト' },
  'shape.width': { label: '幅', min: 0.005, max: 2, step: 0.005, digits: 3, group: '図形' },
  'shape.height': { label: '高さ', min: 0.005, max: 2, step: 0.005, digits: 3, group: '図形' },
  'shape.radius': { label: '角丸/星の内径', min: 0, max: 1, step: 0.01, digits: 2, group: '図形' },
  'shape.points': { label: '頂点数', min: 3, max: 24, step: 1, digits: 0, group: '図形' },
  'shape.strokeWidth': { label: '線の太さ', min: 0, max: 0.1, step: 0.001, digits: 3, group: '図形' },
  'shape.fillAlpha': { label: '塗りの不透明度', min: 0, max: 1, step: 0.01, digits: 2, group: '図形' },
};

const ORDER = [
  'transform.x', 'transform.y', 'transform.scaleX', 'transform.scaleY', 'transform.rotation',
  'transform.anchorX', 'transform.anchorY',
  'opacity',
  'crop.left', 'crop.right', 'crop.top', 'crop.bottom',
  'mask.x', 'mask.y', 'mask.w', 'mask.h', 'mask.feather', 'mask.round',
  'text.fontSize', 'text.lineHeight', 'text.letterSpacing', 'text.strokeWidth', 'text.maxWidth',
  'text.background.alpha', 'text.background.padding', 'text.background.radius',
  'text.shadow.x', 'text.shadow.y', 'text.shadow.blur', 'text.shadow.alpha',
  'shape.width', 'shape.height', 'shape.radius', 'shape.points', 'shape.strokeWidth', 'shape.fillAlpha',
  'volume',
];

/** Parameter spec for a path (falls back to a sane numeric default). */
export function paramSpec(path) {
  if (SPECS[path]) return SPECS[path];
  if (path.startsWith('effects.')) {
    const [, fxId, key] = path.split('.');
    const label = key;
    return { label, min: -100000, max: 100000, step: 0.01, digits: 2, fxId, key };
  }
  return { label: path, min: -100000, max: 100000, step: 0.01, digits: 2 };
}

export function paramLabel(path) {
  const spec = SPECS[path];
  if (spec) return spec.label;
  return path;
}

/** Every animatable parameter for a clip, with labels and ranges. */
export function animatableParams(clip) {
  const out = [];
  const push = (path, spec) => {
    const s = { ...spec, path, label: spec.label || paramLabel(path) };
    out.push(s);
  };
  const type = clip.type;
  for (const path of ORDER) {
    if (path.startsWith('text.') && type !== 'text') continue;
    if (path.startsWith('shape.') && type !== 'shape') continue;
    if (path === 'volume' && !(type === 'audio' || type === 'video')) continue;
    if (path.startsWith('mask.') && !clip.mask?.enabled) continue;
    push(path, paramSpec(path));
  }
  for (const fx of clip.effects || []) {
    const def = getEffectDef(fx.type);
    if (!def) continue;
    for (const p of def.params) {
      if (p.type !== 'number' && p.type !== 'int') continue;
      push(`effects.${fx.id}.${p.key}`, {
        label: `${def.label}: ${p.label}`,
        min: p.min, max: p.max, step: p.step, digits: p.type === 'int' ? 0 : 2, unit: p.unit,
      });
    }
  }
  return out;
}

/** Value of a parameter at the playhead (animated or static). */
export function paramValue(clip, path, playheadTicks) {
  const local = Math.round((playheadTicks - clip.startTicks) * (clip.speed || 1));
  const value = evaluateParam(clip, path, local, undefined);
  if (value !== undefined) return value;
  const fallback = getStaticValue(clip, path);
  return isNumericParamPath(path) ? (fallback ?? 0) : fallback;
}

export function localTicksFor(clip, playheadTicks) {
  return Math.round((playheadTicks - clip.startTicks) * (clip.speed || 1));
}

export function ticksToSecondsLabel(ticks) {
  return ticks / TICKS_PER_SECOND;
}

export { SPECS, ORDER };
