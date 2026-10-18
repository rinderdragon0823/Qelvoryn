/**
 * Qelvoryn effect definitions.
 *
 * Pure data (no DOM access) so the same definitions are shared by:
 *   - the project model (default parameter values)
 *   - the compositor   (how to render them)
 *   - the inspector UI (generated property editors)
 *
 * scope:
 *   'clip'  -> applied to the pixels of a single clip, in order
 *   'frame' -> applied to everything composited below the track the clip
 *              lives on (camera moves, full-frame grades, ...)
 *   'audio' -> applied to the audio graph of a clip / track
 */

/** @typedef {'number'|'int'|'color'|'bool'|'select'|'point'|'text'} ParamType */

const P = {
  number: (key, label, def, min, max, step = 0.01, unit = '') => ({
    key, label, type: 'number', default: def, min, max, step, unit,
  }),
  int: (key, label, def, min, max, unit = '') => ({
    key, label, type: 'int', default: def, min, max, step: 1, unit,
  }),
  color: (key, label, def) => ({ key, label, type: 'color', default: def }),
  bool: (key, label, def) => ({ key, label, type: 'bool', default: def }),
  select: (key, label, def, options) => ({ key, label, type: 'select', default: def, options }),
  point: (key, label, def) => ({ key, label, type: 'point', default: def }),
  text: (key, label, def) => ({ key, label, type: 'text', default: def }),
};

/** @type {Record<string, any>} */
export const EFFECT_DEFS = {
  // ---------------------------------------------------------------- clip ---
  colorCorrect: {
    label: '色調整',
    scope: 'clip',
    category: '色',
    animated: true,
    params: [
      P.number('brightness', '明るさ', 1, 0, 4, 0.01),
      P.number('contrast', 'コントラスト', 1, 0, 4, 0.01),
      P.number('saturation', '彩度', 1, 0, 4, 0.01),
      P.number('hue', '色相', 0, -180, 180, 1, '°'),
      P.number('exposure', '露出', 1, 0, 4, 0.01),
    ],
  },
  blur: {
    label: 'ぼかし',
    scope: 'clip',
    category: 'ぼかし',
    animated: true,
    params: [
      P.number('radius', '半径', 6, 0, 80, 0.5, 'px'),
      P.number('quality', '品質', 1, 0.2, 2, 0.1),
    ],
  },
  grayscale: {
    label: 'グレースケール',
    scope: 'clip',
    category: '色',
    animated: true,
    params: [P.number('amount', '適用度', 1, 0, 1, 0.01)],
  },
  sepia: {
    label: 'セピア',
    scope: 'clip',
    category: '色',
    animated: true,
    params: [P.number('amount', '適用度', 1, 0, 1, 0.01)],
  },
  invert: {
    label: '階調反転',
    scope: 'clip',
    category: '色',
    animated: true,
    params: [P.number('amount', '適用度', 1, 0, 1, 0.01)],
  },
  vignette: {
    label: 'ビネット',
    scope: 'clip',
    category: 'スタイライズ',
    animated: true,
    params: [
      P.number('strength', '強さ', 0.6, 0, 1, 0.01),
      P.number('radius', '半径', 0.65, 0.05, 1.5, 0.01),
      P.number('softness', 'ぼかし', 0.45, 0.01, 1.5, 0.01),
      P.color('color', '色', '#000000'),
    ],
  },
  chromaKey: {
    label: 'クロマキー',
    scope: 'clip',
    category: '合成',
    animated: true,
    params: [
      P.color('keyColor', 'キー色', '#00ff00'),
      P.number('tolerance', '許容範囲', 0.25, 0, 1, 0.01),
      P.number('softness', '境界のぼかし', 0.08, 0, 1, 0.01),
      P.number('spill', '色かぶり除去', 0.3, 0, 1, 0.01),
    ],
  },
  pixelate: {
    label: 'ピクセレート',
    scope: 'clip',
    category: 'スタイライズ',
    animated: true,
    params: [P.number('size', 'ブロックサイズ', 12, 2, 200, 1, 'px')],
  },
  sharpen: {
    label: 'シャープ',
    scope: 'clip',
    category: 'スタイライズ',
    animated: true,
    params: [
      P.number('amount', '強さ', 0.6, 0, 3, 0.01),
      P.int('radius', '半径', 1, 1, 3),
    ],
  },
  posterize: {
    label: 'ポスタライズ',
    scope: 'clip',
    category: '色',
    animated: true,
    params: [P.int('levels', '階調数', 6, 2, 32)],
  },
  threshold: {
    label: '2値化',
    scope: 'clip',
    category: '色',
    animated: true,
    params: [P.number('level', 'しきい値', 0.5, 0, 1, 0.01)],
  },
  mirror: {
    label: 'ミラー',
    scope: 'clip',
    category: '変形',
    animated: true,
    params: [
      P.bool('horizontal', '左右反転', true),
      P.number('splitX', '分割位置X', 0.5, 0, 1, 0.01),
    ],
  },
  dropShadow: {
    label: 'ドロップシャドウ',
    scope: 'clip',
    category: 'スタイライズ',
    animated: true,
    params: [
      P.number('x', 'X', 8, -200, 200, 1, 'px'),
      P.number('y', 'Y', 8, -200, 200, 1, 'px'),
      P.number('blur', 'ぼかし', 12, 0, 100, 1, 'px'),
      P.color('color', '色', '#000000'),
      P.number('alpha', '不透明度', 0.6, 0, 1, 0.01),
    ],
  },
  glow: {
    label: 'グロー',
    scope: 'clip',
    category: 'スタイライズ',
    animated: true,
    params: [
      P.number('strength', '強さ', 0.5, 0, 2, 0.01),
      P.number('radius', '半径', 18, 0, 100, 1, 'px'),
    ],
  },
  maskRect: {
    label: '矩形マスク',
    scope: 'clip',
    category: 'マスク',
    animated: true,
    params: [
      P.number('x', 'X', 0.5, -1, 2, 0.005),
      P.number('y', 'Y', 0.5, -1, 2, 0.005),
      P.number('w', '幅', 0.6, 0, 2, 0.005),
      P.number('h', '高さ', 0.6, 0, 2, 0.005),
      P.number('round', '角丸', 0, 0, 1, 0.01),
      P.number('feather', 'ぼかし', 0.02, 0, 0.5, 0.005),
      P.bool('invert', '反転', false),
    ],
  },
  maskEllipse: {
    label: '楕円マスク',
    scope: 'clip',
    category: 'マスク',
    animated: true,
    params: [
      P.number('x', 'X', 0.5, -1, 2, 0.005),
      P.number('y', 'Y', 0.5, -1, 2, 0.005),
      P.number('w', '幅', 0.6, 0, 2, 0.005),
      P.number('h', '高さ', 0.6, 0, 2, 0.005),
      P.number('feather', 'ぼかし', 0.02, 0, 0.5, 0.005),
      P.bool('invert', '反転', false),
    ],
  },

  // -------------------------------------------------------------- frame ---
  cameraTransform: {
    label: 'カメラ変形',
    scope: 'frame',
    category: 'カメラ',
    animated: true,
    params: [
      P.number('scale', 'スケール', 1.4, 0.05, 8, 0.005),
      P.number('x', 'X', 0.5, -1, 2, 0.005),
      P.number('y', 'Y', 0.5, -1, 2, 0.005),
      P.number('rotation', '回転', 0, -180, 180, 0.1, '°'),
    ],
  },
  frameColorCorrect: {
    label: '全体色調整',
    scope: 'frame',
    category: '色',
    animated: true,
    params: [
      P.number('brightness', '明るさ', 1, 0, 4, 0.01),
      P.number('contrast', 'コントラスト', 1, 0, 4, 0.01),
      P.number('saturation', '彩度', 1, 0, 4, 0.01),
      P.number('hue', '色相', 0, -180, 180, 1, '°'),
    ],
  },
  frameBlur: {
    label: '全体ぼかし',
    scope: 'frame',
    category: 'ぼかし',
    animated: true,
    params: [P.number('radius', '半径', 8, 0, 120, 0.5, 'px')],
  },
  frameVignette: {
    label: '全体ビネット',
    scope: 'frame',
    category: 'スタイライズ',
    animated: true,
    params: [
      P.number('strength', '強さ', 0.5, 0, 1, 0.01),
      P.number('radius', '半径', 0.6, 0.05, 1.5, 0.01),
      P.color('color', '色', '#000000'),
    ],
  },
  framePixelate: {
    label: '全体ピクセレート',
    scope: 'frame',
    category: 'スタイライズ',
    animated: true,
    params: [P.number('size', 'ブロックサイズ', 16, 2, 300, 1, 'px')],
  },
  frameGrain: {
    label: 'フィルムグレイン',
    scope: 'frame',
    category: 'スタイライズ',
    animated: true,
    params: [
      P.number('amount', '強さ', 0.25, 0, 1, 0.01),
      P.int('seed', 'シード', 7, 0, 9999),
      P.bool('monochrome', 'モノクロ', true),
    ],
  },

  // -------------------------------------------------------------- audio ---
  audioGain: {
    label: '音量(ゲイン)',
    scope: 'audio',
    category: '音声',
    animated: true,
    params: [
      P.number('gain', 'ゲイン', 1, 0, 4, 0.01),
      P.number('pan', 'パン', 0, -1, 1, 0.01),
    ],
  },
  audioEQ: {
    label: 'EQ',
    scope: 'audio',
    category: '音声',
    animated: true,
    params: [
      P.number('low', '低域', 0, -30, 30, 0.5, 'dB'),
      P.number('mid', '中域', 0, -30, 30, 0.5, 'dB'),
      P.number('high', '高域', 0, -30, 30, 0.5, 'dB'),
    ],
  },
  audioDelay: {
    label: 'ディレイ',
    scope: 'audio',
    category: '音声',
    animated: true,
    params: [
      P.number('time', '遅延', 0.25, 0.01, 1.5, 0.01, 's'),
      P.number('feedback', 'フィードバック', 0.25, 0, 0.9, 0.01),
      P.number('mix', 'ミックス', 0.3, 0, 1, 0.01),
    ],
  },
  audioFade: {
    label: 'フェード(自動)',
    scope: 'audio',
    category: '音声',
    animated: true,
    params: [
      P.number('inTicks', 'フェードイン', 0, 0, 10, 0.05, 's'),
      P.number('outTicks', 'フェードアウト', 0, 0, 10, 0.05, 's'),
    ],
  },
};

export function getEffectDef(type) {
  return EFFECT_DEFS[type] || null;
}

export function effectLabel(type) {
  return EFFECT_DEFS[type]?.label || type;
}

export function defaultEffectParams(type) {
  const def = EFFECT_DEFS[type];
  if (!def) return {};
  const params = {};
  for (const p of def.params) {
    params[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  }
  return params;
}

/** Effects that can be attached to a given clip type. */
export function effectsForClipType(clipType) {
  const isAudio = clipType === 'audio';
  const isEffectTrack = clipType === 'effect';
  const out = [];
  for (const [type, def] of Object.entries(EFFECT_DEFS)) {
    if (isEffectTrack) {
      if (def.scope === 'frame') out.push(type);
      continue;
    }
    if (isAudio) {
      if (def.scope === 'audio') out.push(type);
      continue;
    }
    if (def.scope === 'clip') out.push(type);
  }
  return out;
}

export const EFFECT_CATEGORIES = ['色', 'ぼかし', 'スタイライズ', '変形', 'マスク', '合成', 'カメラ', '音声'];
