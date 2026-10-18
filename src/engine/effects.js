/**
 * Effect rendering.
 *
 * Every effect is a pure function `(layer, params, info) => void` that
 * transforms a double-buffered canvas in place.  The exact same functions are
 * used by the preview and by the exporter, so what you see is what you get.
 *
 * Pipeline per clip:  source pixels -> clip effects (in list order) ->
 * mask -> transform/opacity/blend onto the frame.
 */

import { getEffectDef } from './effectdefs.js';
import { acquireCanvas, clearCanvas } from './layers.js';
import { evaluateParam, hexToRgb } from '../core/keyframes.js';

export { hexToRgb };

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Render the front buffer through `drawFn` into the back buffer and swap. */
function blit(layer, drawFn) {
  const dst = layer.begin();
  const src = layer.srcCanvas;
  drawFn(dst, src, layer.width, layer.height);
  layer.swap();
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function withImageData(canvas, fn) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  fn(img.data, canvas.width, canvas.height, img);
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// Clip-scope effects
// ---------------------------------------------------------------------------

export const CLIP_APPLIERS = {
  colorCorrect(layer, p) {
    const brightness = (p.brightness ?? 1) * (p.exposure ?? 1);
    blit(layer, (dst, src) => {
      dst.filter = `brightness(${brightness}) contrast(${p.contrast ?? 1}) saturate(${p.saturation ?? 1}) hue-rotate(${p.hue ?? 0}deg)`;
      dst.drawImage(src, 0, 0);
    });
  },

  blur(layer, p, info) {
    const passes = Math.max(1, Math.min(3, Math.round(p.quality ?? 1)));
    const radius = ((p.radius ?? 0) * info.scale) / Math.sqrt(passes);
    if (radius <= 0.05) return;
    for (let i = 0; i < passes; i += 1) {
      blit(layer, (dst, src) => {
        dst.filter = `blur(${radius}px)`;
        dst.drawImage(src, 0, 0);
      });
    }
  },

  grayscale(layer, p) {
    const amount = Math.max(0, Math.min(1, p.amount ?? 1));
    if (amount <= 0) return;
    blit(layer, (dst, src) => {
      dst.filter = `grayscale(${amount * 100}%)`;
      dst.drawImage(src, 0, 0);
    });
  },

  sepia(layer, p) {
    const amount = Math.max(0, Math.min(1, p.amount ?? 1));
    if (amount <= 0) return;
    blit(layer, (dst, src) => {
      dst.filter = `sepia(${amount * 100}%)`;
      dst.drawImage(src, 0, 0);
    });
  },

  invert(layer, p) {
    const amount = Math.max(0, Math.min(1, p.amount ?? 1));
    if (amount <= 0) return;
    blit(layer, (dst, src) => {
      dst.filter = `invert(${amount * 100}%)`;
      dst.drawImage(src, 0, 0);
    });
  },

  vignette(layer, p, info) {
    const { width: w, height: h } = layer;
    blit(layer, (dst, src) => {
      dst.drawImage(src, 0, 0);
      const cx = w / 2;
      const cy = h / 2;
      const inner = Math.max(1, (p.radius ?? 0.65) * (Math.min(w, h) / 2));
      const outer = inner * (1 + Math.max(0.01, (p.softness ?? 0.45) * 2));
      const grad = dst.createRadialGradient(cx, cy, inner, cx, cy, outer);
      grad.addColorStop(0, rgba(p.color || '#000000', 0));
      grad.addColorStop(1, rgba(p.color || '#000000', Math.max(0, Math.min(1, p.strength ?? 0.6))));
      dst.fillStyle = grad;
      dst.fillRect(0, 0, w, h);
    });
  },

  chromaKey(layer, p) {
    const key = hexToRgb(p.keyColor || '#00ff00');
    const maxDist = 441.673;
    const tol = Math.max(0, Math.min(1, p.tolerance ?? 0.25)) * maxDist;
    const soft = Math.max(0.5, Math.max(0, Math.min(1, p.softness ?? 0.08)) * maxDist);
    const spill = Math.max(0, Math.min(1, p.spill ?? 0.3));
    // index of the channel to de-spill (green screen -> green channel)
    const spillChannel = key[1] > key[0] && key[1] > key[2] ? 1 : key[0] > key[2] ? 0 : 2;
    withImageData(layer.canvas, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const dr = d[i] - key[0];
        const dg = d[i + 1] - key[1];
        const db = d[i + 2] - key[2];
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist <= tol) {
          d[i + 3] = 0;
        } else if (dist < tol + soft) {
          d[i + 3] = Math.round(d[i + 3] * ((dist - tol) / soft));
        }
        if (spill > 0 && d[i + 3] > 0) {
          const others = (d[i + (spillChannel + 1) % 3] + d[i + (spillChannel + 2) % 3]) / 2;
          if (d[i + spillChannel] > others) {
            d[i + spillChannel] = Math.round(d[i + spillChannel] - (d[i + spillChannel] - others) * spill);
          }
        }
      }
    });
  },

  pixelate(layer, p, info) {
    const { width: w, height: h } = layer;
    const size = Math.max(2, (p.size ?? 12) * info.scale);
    const sw = Math.max(1, Math.round(w / size));
    const sh = Math.max(1, Math.round(h / size));
    const small = acquireCanvas(sw, sh, 'px');
    const sctx = clearCanvas(small);
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(layer.srcCanvas, 0, 0, w, h, 0, 0, sw, sh);
    blit(layer, (dst) => {
      dst.imageSmoothingEnabled = false;
      dst.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);
    });
  },

  sharpen(layer, p, info) {
    const { width: w, height: h } = layer;
    const amount = Math.max(0, p.amount ?? 0.6);
    if (amount <= 0) return;
    const radius = Math.max(0.5, (p.radius ?? 1) * 1.6 * info.scale);
    const blurCanvas = acquireCanvas(w, h, 'sharp');
    const bctx = clearCanvas(blurCanvas);
    bctx.filter = `blur(${radius}px)`;
    bctx.drawImage(layer.srcCanvas, 0, 0);
    const srcCtx = layer.ctx;
    const src = srcCtx.getImageData(0, 0, w, h);
    const blurred = bctx.getImageData(0, 0, w, h);
    const d = src.data;
    const b = blurred.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        d[i + c] = clamp255(d[i + c] + amount * (d[i + c] - b[i + c]));
      }
    }
    srcCtx.putImageData(src, 0, 0);
  },

  posterize(layer, p) {
    const levels = Math.max(2, Math.round(p.levels ?? 6));
    const step = 255 / (levels - 1);
    withImageData(layer.canvas, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp255(Math.round(d[i] / step) * step);
        d[i + 1] = clamp255(Math.round(d[i + 1] / step) * step);
        d[i + 2] = clamp255(Math.round(d[i + 2] / step) * step);
      }
    });
  },

  threshold(layer, p) {
    const level = Math.max(0, Math.min(1, p.level ?? 0.5)) * 255;
    withImageData(layer.canvas, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = lum >= level ? 255 : 0;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      }
    });
  },

  mirror(layer, p) {
    const { width: w, height: h } = layer;
    const axis = Math.max(0, Math.min(1, p.splitX ?? 0.5)) * w;
    blit(layer, (dst, src) => {
      dst.drawImage(src, 0, 0);
      if (p.horizontal) {
        dst.save();
        dst.beginPath();
        dst.rect(axis, 0, w - axis, h);
        dst.clip();
        dst.translate(axis * 2, 0);
        dst.scale(-1, 1);
        dst.drawImage(src, 0, 0);
        dst.restore();
      }
    });
  },

  dropShadow(layer, p, info) {
    const { width: w, height: h } = layer;
    blit(layer, (dst, src) => {
      dst.save();
      dst.shadowColor = rgba(p.color || '#000000', p.alpha ?? 0.6);
      dst.shadowBlur = (p.blur ?? 12) * info.scale;
      dst.shadowOffsetX = (p.x ?? 8) * info.scale;
      dst.shadowOffsetY = (p.y ?? 8) * info.scale;
      dst.drawImage(src, 0, 0);
      dst.restore();
    });
  },

  glow(layer, p, info) {
    const { width: w, height: h } = layer;
    const strength = Math.max(0, p.strength ?? 0.5);
    if (strength <= 0) return;
    blit(layer, (dst, src) => {
      dst.save();
      dst.globalCompositeOperation = 'lighter';
      dst.globalAlpha = Math.min(1, strength);
      dst.filter = `blur(${Math.max(0.5, (p.radius ?? 18) * info.scale)}px)`;
      dst.drawImage(src, 0, 0);
      dst.restore();
      dst.drawImage(src, 0, 0);
    });
  },

  maskRect(layer, p, info) {
    applyMask(layer, p, info, (ctx, w, h, grow) => {
      const cx = (p.x ?? 0.5) * w;
      const cy = (p.y ?? 0.5) * h;
      const rw = Math.max(0, (p.w ?? 0.6) * w) + grow;
      const rh = Math.max(0, (p.h ?? 0.6) * h) + grow;
      const radius = Math.max(0, Math.min(1, p.round ?? 0)) * (Math.min(rw, rh) / 2);
      ctx.beginPath();
      roundRect(ctx, cx - rw / 2, cy - rh / 2, rw, rh, radius);
      ctx.fill();
    });
  },

  maskEllipse(layer, p, info) {
    applyMask(layer, p, info, (ctx, w, h, grow) => {
      const cx = (p.x ?? 0.5) * w;
      const cy = (p.y ?? 0.5) * h;
      const rw = Math.max(0, (p.w ?? 0.6) * w) / 2 + grow;
      const rh = Math.max(0, (p.h ?? 0.6) * h) / 2 + grow;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  },
};

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function applyMask(layer, p, info, shapeFn) {
  const { width: w, height: h } = layer;
  const feather = Math.max(0, p.feather ?? 0);
  const mask = acquireCanvas(w, h, 'mask');
  const mctx = clearCanvas(mask);
  const grow = feather > 0 ? feather * w * 0.6 : 0;
  if (feather > 0) mctx.filter = `blur(${Math.max(0.5, feather * w)}px)`;
  mctx.fillStyle = '#ffffff';
  shapeFn(mctx, w, h, grow);
  const dst = layer.begin();
  dst.drawImage(layer.srcCanvas, 0, 0);
  dst.globalCompositeOperation = p.invert ? 'destination-out' : 'destination-in';
  dst.drawImage(mask, 0, 0);
  dst.globalCompositeOperation = 'source-over';
  layer.swap();
}

// ---------------------------------------------------------------------------
// Frame-scope effects (apply to everything composited below the track)
// ---------------------------------------------------------------------------

export const FRAME_APPLIERS = {
  cameraTransform(layer, p) {
    const { width: w, height: h } = layer;
    const scale = Math.max(0.01, p.scale ?? 1);
    blit(layer, (dst, src) => {
      dst.save();
      dst.translate((p.x ?? 0.5) * w, (p.y ?? 0.5) * h);
      if (p.rotation) dst.rotate((p.rotation * Math.PI) / 180);
      dst.scale(scale, scale);
      dst.translate(-w / 2, -h / 2);
      dst.imageSmoothingEnabled = true;
      dst.imageSmoothingQuality = 'high';
      dst.drawImage(src, 0, 0);
      dst.restore();
    });
  },

  frameGrain(layer, p) {
    const amount = Math.max(0, Math.min(1, p.amount ?? 0.25));
    if (amount <= 0) return;
    const seed = Math.round(p.seed ?? 7);
    const mono = p.monochrome !== false;
    let state = (seed * 9301 + 49297) % 233280 || 1;
    const rand = () => {
      state = (state * 9301 + 49297) % 233280;
      return state / 233280;
    };
    withImageData(layer.canvas, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        const n = (rand() - 0.5) * 255 * amount;
        if (mono) {
          d[i] = clamp255(d[i] + n);
          d[i + 1] = clamp255(d[i + 1] + n);
          d[i + 2] = clamp255(d[i + 2] + n);
        } else {
          d[i] = clamp255(d[i] + n);
          d[i + 1] = clamp255(d[i + 1] + (rand() - 0.5) * 255 * amount);
          d[i + 2] = clamp255(d[i + 2] + (rand() - 0.5) * 255 * amount);
        }
      }
    });
  },
};

/** Reuse clip appliers for whole-frame grades. */
const FRAME_ALIASES = {
  frameColorCorrect: 'colorCorrect',
  frameBlur: 'blur',
  frameVignette: 'vignette',
  framePixelate: 'pixelate',
};

export function applierFor(type) {
  if (FRAME_APPLIERS[type]) return FRAME_APPLIERS[type];
  if (FRAME_ALIASES[type]) return CLIP_APPLIERS[FRAME_ALIASES[type]];
  return CLIP_APPLIERS[type] || null;
}

/**
 * Evaluate an effect's parameters at a local time, honouring keyframes.
 * @param {object} clip
 * @param {object} fx
 * @param {number} localTicks
 */
export function effectParamsAt(clip, fx, localTicks) {
  const def = getEffectDef(fx.type);
  const params = {};
  if (!def) return { ...(fx.params || {}) };
  for (const p of def.params) {
    const path = `effects.${fx.id}.${p.key}`;
    const value = evaluateParam(clip, path, localTicks, fx.params?.[p.key] ?? p.default);
    params[p.key] = value === undefined ? p.default : value;
  }
  return params;
}

/** Apply the ordered effect chain of a clip to a layer. */
export function applyEffectChain(layer, clip, localTicks, info) {
  for (const fx of clip.effects || []) {
    if (!fx.enabled) continue;
    const def = getEffectDef(fx.type);
    if (!def || def.scope !== 'clip') continue;
    const applier = CLIP_APPLIERS[fx.type];
    if (!applier) continue;
    const params = effectParamsAt(clip, fx, localTicks);
    try {
      applier(layer, params, info);
    } catch (err) {
      console.warn(`[Qelvoryn] effect "${fx.type}" failed`, err);
    }
  }
}

/** Apply the ordered effect chain of an effect-track clip to the frame. */
export function applyFrameEffectChain(layer, clip, localTicks, info) {
  for (const fx of clip.effects || []) {
    if (!fx.enabled) continue;
    const def = getEffectDef(fx.type);
    if (!def || def.scope !== 'frame') continue;
    const applier = applierFor(fx.type);
    if (!applier) continue;
    const params = effectParamsAt(clip, fx, localTicks);
    try {
      applier(layer, params, info);
    } catch (err) {
      console.warn(`[Qelvoryn] frame effect "${fx.type}" failed`, err);
    }
  }
}

export { roundRect };
