/**
 * Qelvoryn compositor.
 *
 * ONE renderer is used by the preview, the thumbnail strip and the exporter.
 * Nothing in here knows whether it is drawing to the screen or to a video
 * encoder, which guarantees "preview == export".
 *
 * Layer order: `project.tracks` is ordered top-to-bottom in the UI, so the
 * compositor walks the array backwards (last item is the back-most layer).
 *
 * Per-clip pipeline:
 *   source pixels -> crop/fit -> effect chain (order = user order)
 *   -> mask -> transform/opacity/blend -> track buffer -> frame buffer
 *   -> frame effects of any effect track above it
 */

import { Layer, acquireCanvas, clearCanvas } from './layers.js';
import { applyEffectChain, applyFrameEffectChain, CLIP_APPLIERS, effectParamsAt } from './effects.js';
import { drawTextClip, drawShapeClip } from './primitives.js';
import { evaluateParam } from '../core/keyframes.js';
import { TRACK_KINDS } from '../core/model.js';

const VISUAL_KINDS = new Set(['video', 'image', 'text', 'overlay']);

export function clipLocalTicks(clip, timeTicks) {
  return Math.round((timeTicks - clip.startTicks) * (clip.speed || 1));
}

export function isClipActive(clip, timeTicks) {
  return timeTicks >= clip.startTicks && timeTicks < clip.startTicks + clip.durationTicks;
}

export function activeClips(track, timeTicks) {
  const out = [];
  for (const clip of track.clips) {
    if (clip.enabled && isClipActive(clip, timeTicks)) out.push(clip);
  }
  return out;
}

/** Source time (seconds) inside the asset for a given timeline position. */
export function sourceSecondsAt(clip, timeTicks) {
  const local = clipLocalTicks(clip, timeTicks);
  const media = clip.reversed ? Math.max(0, Math.round(clip.durationTicks * (clip.speed || 1)) - local) : local;
  return (clip.inTicks + media) / 120000;
}

/** Source-relative local time used for keyframe evaluation. */
export function keyframeLocalTicks(clip, timeTicks) {
  const local = clipLocalTicks(clip, timeTicks);
  return clip.reversed ? Math.max(0, Math.round(clip.durationTicks * (clip.speed || 1)) - local) : local;
}

/** Evaluate every visual parameter of a clip at a timeline position. */
export function evaluateClipVisual(clip, timeTicks) {
  const t = keyframeLocalTicks(clip, timeTicks);
  const P = (path, fallback) => evaluateParam(clip, path, t, fallback);
  const transform = {
    x: P('transform.x', clip.transform?.x ?? 0.5),
    y: P('transform.y', clip.transform?.y ?? 0.5),
    scaleX: P('transform.scaleX', clip.transform?.scaleX ?? 1),
    scaleY: P('transform.scaleY', clip.transform?.scaleY ?? 1),
    rotation: P('transform.rotation', clip.transform?.rotation ?? 0),
    anchorX: clip.transform?.anchorX ?? 0.5,
    anchorY: clip.transform?.anchorY ?? 0.5,
  };
  const crop = {
    left: P('crop.left', clip.crop?.left ?? 0),
    right: P('crop.right', clip.crop?.right ?? 0),
    top: P('crop.top', clip.crop?.top ?? 0),
    bottom: P('crop.bottom', clip.crop?.bottom ?? 0),
  };
  const opacity = P('opacity', clip.opacity ?? 1);
  const mask = clip.mask || {};
  const maskParams = mask.enabled
    ? {
      x: P('mask.x', mask.x ?? 0.5),
      y: P('mask.y', mask.y ?? 0.5),
      w: P('mask.w', mask.w ?? 0.5),
      h: P('mask.h', mask.h ?? 0.5),
      feather: P('mask.feather', mask.feather ?? 0.03),
      round: P('mask.round', mask.round ?? 0),
      invert: !!mask.invert,
      type: mask.type || 'rect',
    }
    : null;
  const volume = P('volume', clip.volume ?? 1);
  return { localTicks: t, transform, crop, opacity, maskParams, volume };
}

/**
 * A frame source provides the pixels for video/image clips.
 * `exact` sources seek to the precise frame (export); non-exact sources use
 * whatever frame the playing <video> currently holds (live preview).
 */
export class MediaFrameSource {
  constructor(mediaPool, opts = {}) {
    this.pool = mediaPool;
    this.exact = !!opts.exact;
    this.acquired = new Set();
    this.errors = [];
  }

  async videoFor(clip, seconds) {
    const el = this.pool.videoFor(clip.assetId, clip.id);
    if (!el) return null;
    if (this.exact) {
      const ok = await this.pool.seekVideo(el, seconds);
      if (!ok) {
        this.errors.push({ clipId: clip.id, message: '動画フレームの取得に失敗しました' });
        return null;
      }
      this.acquired.add(`${clip.assetId}::${clip.id}`);
      return el;
    }
    if (el.readyState < 2) {
      await this.pool.ensureVideoReady(el, 4000).catch(() => false);
      if (!this.exact) await this.pool.seekVideo(el, seconds).catch(() => false);
    }
    if (el.readyState < 2) return null;
    this.acquired.add(`${clip.assetId}::${clip.id}`);
    return el;
  }

  async imageFor(clip) {
    const img = await this.pool.getImage(clip.assetId);
    if (!img) this.errors.push({ clipId: clip.id, message: '画像の読み込みに失敗しました' });
    return img;
  }
}

function computePlacement(clip, sourceWidth, sourceHeight, outWidth, outHeight) {
  const crop = clip.crop || { left: 0, right: 0, top: 0, bottom: 0 };
  const sx = Math.max(0, Math.min(0.98, crop.left)) * sourceWidth;
  const sy = Math.max(0, Math.min(0.98, crop.top)) * sourceHeight;
  const sw = Math.max(1, sourceWidth * Math.max(0.02, 1 - crop.left - crop.right));
  const sh = Math.max(1, sourceHeight * Math.max(0.02, 1 - crop.top - crop.bottom));
  const fit = clip.fit || 'contain';
  let dw = outWidth;
  let dh = outHeight;
  let dx = 0;
  let dy = 0;
  if (fit === 'stretch') {
    dw = outWidth;
    dh = outHeight;
  } else if (fit === 'none') {
    dw = sw;
    dh = sh;
    dx = (outWidth - dw) / 2;
    dy = (outHeight - dh) / 2;
  } else {
    const containScale = Math.min(outWidth / sw, outHeight / sh);
    const coverScale = Math.max(outWidth / sw, outHeight / sh);
    const scale = fit === 'cover' ? coverScale : containScale;
    dw = sw * scale;
    dh = sh * scale;
    dx = (outWidth - dw) / 2;
    dy = (outHeight - dh) / 2;
  }
  return { sx, sy, sw, sh, dx, dy, dw, dh };
}

function drawMediaIntoLayer(layer, drawable, clip, info, extra = {}) {
  const ctx = layer.begin();
  const { width: w, height: h } = layer;
  const naturalW = drawable.videoWidth || drawable.naturalWidth || drawable.width || 0;
  const naturalH = drawable.videoHeight || drawable.naturalHeight || drawable.height || 0;
  if (!naturalW || !naturalH) return false;
  const p = computePlacement(clip, naturalW, naturalH, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const flipH = extra.flipH ? -1 : 1;
  const flipV = extra.flipV ? -1 : 1;
  if (flipH < 0 || flipV < 0) {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(flipH, flipV);
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(drawable, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
    ctx.restore();
  } else {
    ctx.drawImage(drawable, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
  }
  layer.swap();
  return true;
}

/**
 * Render one clip into a track layer.
 * @returns {Promise<boolean>} whether anything was drawn
 */
async function drawClipIntoTrackLayer(trackLayer, clip, timeTicks, project, source, info) {
  if (clip.type === 'audio' || clip.type === 'effect') return false;
  const visual = evaluateClipVisual(clip, timeTicks);
  const clipLayer = new Layer(info.width, info.height, 'clip');
  clipLayer.clear();
  let drew = false;

  if (clip.type === 'text') {
    const def = clip.text || {};
    const params = { ...def };
    for (const key of ['fontSize', 'lineHeight', 'letterSpacing', 'strokeWidth', 'maxWidth']) {
      params[key] = evaluateParam(clip, `text.${key}`, visual.localTicks, def[key]);
    }
    params.background = {
      ...def.background,
      alpha: evaluateParam(clip, 'text.background.alpha', visual.localTicks, def.background?.alpha ?? 0.6),
      padding: evaluateParam(clip, 'text.background.padding', visual.localTicks, def.background?.padding ?? 0.4),
      radius: evaluateParam(clip, 'text.background.radius', visual.localTicks, def.background?.radius ?? 0.15),
    };
    params.shadow = {
      ...def.shadow,
      x: evaluateParam(clip, 'text.shadow.x', visual.localTicks, def.shadow?.x ?? 0),
      y: evaluateParam(clip, 'text.shadow.y', visual.localTicks, def.shadow?.y ?? 3),
      blur: evaluateParam(clip, 'text.shadow.blur', visual.localTicks, def.shadow?.blur ?? 8),
      alpha: evaluateParam(clip, 'text.shadow.alpha', visual.localTicks, def.shadow?.alpha ?? 0.65),
    };
    drawTextClip(clipLayer, params, info);
    drew = true;
  } else if (clip.type === 'shape') {
    const def = clip.shape || {};
    const params = { ...def };
    for (const key of ['width', 'height', 'radius', 'points', 'strokeWidth', 'fillAlpha']) {
      params[key] = evaluateParam(clip, `shape.${key}`, visual.localTicks, def[key]);
    }
    drawShapeClip(clipLayer, params, info);
    drew = true;
  } else if (clip.assetId) {
    const seconds = sourceSecondsAt(clip, timeTicks);
    const asset = project.assets[clip.assetId];
    const kind = asset?.kind || (clip.type === 'image' ? 'image' : 'video');
    if (kind === 'image' || clip.type === 'image') {
      const img = await source.imageFor(clip);
      if (img) drew = drawMediaIntoLayer(clipLayer, img, clip, info);
    } else {
      const el = await source.videoFor(clip, seconds);
      if (el) drew = drawMediaIntoLayer(clipLayer, el, clip, info, { flipH: !!clip.metadata?.flipH, flipV: !!clip.metadata?.flipV });
    }
    if (!drew && clip.assetId) {
      // Draw a "missing media" placeholder so the timeline stays meaningful.
      const ctx = clipLayer.begin();
      ctx.fillStyle = 'rgba(255,90,90,0.25)';
      ctx.fillRect(0, 0, info.width, info.height);
      ctx.fillStyle = '#ffb4b4';
      ctx.font = `bold ${Math.round(info.height * 0.04)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`素材を読み込めません: ${clip.name}`, info.width / 2, info.height / 2);
      clipLayer.swap();
      drew = true;
    }
  }

  if (!drew) return false;

  applyEffectChain(clipLayer, clip, visual.localTicks, info);

  if (visual.maskParams) {
    const applier = visual.maskParams.type === 'ellipse' ? CLIP_APPLIERS.maskEllipse : CLIP_APPLIERS.maskRect;
    applier(clipLayer, visual.maskParams, info);
  }

  const dst = trackLayer.begin();
  dst.drawImage(trackLayer.srcCanvas, 0, 0);
  dst.save();
  dst.globalAlpha = Math.max(0, Math.min(1, visual.opacity));
  dst.globalCompositeOperation = clip.blendMode || 'source-over';
  const { width: w, height: h } = trackLayer;
  const tr = visual.transform;
  dst.translate(tr.x * w, tr.y * h);
  if (tr.rotation) dst.rotate((tr.rotation * Math.PI) / 180);
  dst.scale(tr.scaleX || 1, tr.scaleY || 1);
  dst.translate(-tr.anchorX * w, -tr.anchorY * h);
  dst.drawImage(clipLayer.canvas, 0, 0, w, h);
  dst.restore();
  trackLayer.swap();
  return true;
}

/**
 * Rendering is serialised: the scratch canvases are pooled by tag+size, so two
 * concurrent renders (e.g. an export plus a preview redraw) must not interleave.
 */
let renderChain = Promise.resolve();

function withRenderLock(fn) {
  const run = renderChain.then(fn, fn);
  renderChain = run.then(() => {}, () => {});
  return run;
}

/**
 * Render a complete frame.
 *
 * @param {object} opts
 * @param {CanvasRenderingContext2D} opts.ctx      destination context
 * @param {object} opts.project
 * @param {number} opts.timeTicks
 * @param {MediaFrameSource} opts.source
 * @param {number} [opts.scale]   render scale (preview quality)
 * @returns {Promise<{drawn:number, errors:Array}>}
 */
export function renderFrame(opts) {
  return withRenderLock(() => renderFrameUnlocked(opts));
}

async function renderFrameUnlocked({ ctx, project, timeTicks, source, scale = 1 }) {
  const W = Math.max(16, Math.round(project.settings.width * scale));
  const H = Math.max(16, Math.round(project.settings.height * scale));
  const frameLayer = new Layer(W, H, 'frame');
  const fctx = frameLayer.begin();
  fctx.fillStyle = project.settings.backgroundColor || '#000000';
  fctx.fillRect(0, 0, W, H);
  frameLayer.swap();

  const info = { width: W, height: H, scale, project, timeTicks };
  let drawn = 0;
  const errors = source.errors;

  for (let ti = project.tracks.length - 1; ti >= 0; ti -= 1) {
    const track = project.tracks[ti];
    if (track.hidden) continue;
    const clips = activeClips(track, timeTicks);
    if (!clips.length) continue;

    if (track.kind === 'effect') {
      for (const clip of clips) {
        const local = keyframeLocalTicks(clip, timeTicks);
        applyFrameEffectChain(frameLayer, clip, local, info);
        drawn += 1;
      }
      continue;
    }
    if (!VISUAL_KINDS.has(track.kind)) continue;

    const trackLayer = new Layer(W, H, 'track');
    trackLayer.clear();
    let trackDrew = false;
    const ordered = [...clips].sort((a, b) => {
      const ai = track.clips.indexOf(a);
      const bi = track.clips.indexOf(b);
      return bi - ai;
    });
    for (const clip of ordered) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await drawClipIntoTrackLayer(trackLayer, clip, timeTicks, project, source, info);
      if (ok) trackDrew = true;
    }
    if (!trackDrew) continue;
    drawn += 1;

    const dst = frameLayer.begin();
    dst.drawImage(frameLayer.srcCanvas, 0, 0);
    dst.save();
    dst.globalAlpha = Math.max(0, Math.min(1, track.opacity ?? 1));
    dst.globalCompositeOperation = track.blendMode || 'source-over';
    dst.drawImage(trackLayer.canvas, 0, 0);
    dst.restore();
    frameLayer.swap();
  }

  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(frameLayer.canvas, 0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  return { drawn, errors, frame: frameLayer.canvas };
}

/** Render a single frame into a standalone canvas (thumbnails, tests). */
export async function renderToCanvas({ project, timeTicks, source, scale = 1, canvas }) {
  const W = Math.max(16, Math.round(project.settings.width * scale));
  const H = Math.max(16, Math.round(project.settings.height * scale));
  const target = canvas || acquireCanvas(W, H, `out-${W}x${H}`);
  target.width = W;
  target.height = H;
  const ctx = target.getContext('2d');
  await renderFrame({ ctx, project, timeTicks, source, scale });
  return target;
}

export { clearCanvas, acquireCanvas, TRACK_KINDS };
