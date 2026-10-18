/**
 * Generators for the two vector clip types (text / shape).
 * They draw into a layer canvas that is the size of the composited frame.
 */

import { roundRect } from './effects.js';

let measureCtx = null;

/** Lazily created 2D context used only for text metrics (no DOM needed in tests). */
function getMeasureCtx() {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    measureCtx = canvas.getContext('2d');
  }
  return measureCtx;
}

export function fontString(weight, sizePx, family, italic = false) {
  return `${italic ? 'italic ' : ''}${weight || 700} ${sizePx}px ${family || 'sans-serif'}`;
}

/** Break text into lines that respect explicit \n and a max width. */
export function wrapText(ctx, text, maxWidthPx) {
  const paragraphs = String(text ?? '').split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    if (!maxWidthPx || maxWidthPx <= 0) {
      lines.push(paragraph);
      continue;
    }
    const words = paragraph.split(/(\s+)/);
    let current = '';
    for (const word of words) {
      const candidate = current + word;
      if (ctx.measureText(candidate).width > maxWidthPx && current.trim()) {
        lines.push(current.replace(/\s+$/, ''));
        current = word.replace(/^\s+/, '');
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

function drawLineWithSpacing(ctx, line, x, y, spacing) {
  if (!spacing) {
    ctx.fillText(line, x, y);
    return;
  }
  const chars = [...line];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cx = x - total / 2;
  for (let i = 0; i < chars.length; i += 1) {
    ctx.fillText(chars[i], cx + widths[i] / 2, y);
    cx += widths[i] + spacing;
  }
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {object} clip
 * @param {object} params evaluated text params
 * @param {{width:number,height:number,scale:number}} info
 */
export function drawTextClip(layer, params, info) {
  const { width: w, height: h } = layer;
  const ctx = layer.begin();
  const t = { ...params };
  const sizePx = Math.max(1, (t.fontSize ?? 0.09) * h);
  const family = t.fontFamily || 'sans-serif';
  ctx.font = fontString(t.fontWeight, sizePx, family, t.italic);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxWidthPx = Math.max(0, (t.maxWidth ?? 0.9) * w);
  const lines = wrapText(ctx, t.content ?? '', maxWidthPx);
  const lineHeight = sizePx * (t.lineHeight ?? 1.25);
  const spacing = (t.letterSpacing ?? 0) * sizePx;
  const totalHeight = lineHeight * lines.length;
  const boxWidth = maxWidthPx > 0
    ? Math.min(maxWidthPx, Math.max(...lines.map((l) => ctx.measureText(l).width + spacing * Math.max(0, l.length - 1)), 1))
    : Math.max(...lines.map((l) => ctx.measureText(l).width), 1);

  const anchorX = w / 2;
  const anchorY = h / 2;
  let startY = anchorY - totalHeight / 2 + lineHeight / 2;
  if (t.valign === 'top') startY = anchorY - totalHeight / 2 + lineHeight / 2;

  if (t.background?.enabled) {
    const pad = sizePx * (t.background.padding ?? 0.4);
    const bx = anchorX - boxWidth / 2 - pad;
    const by = startY - lineHeight / 2 - pad;
    const bw = boxWidth + pad * 2;
    const bh = totalHeight + pad * 2;
    const radius = sizePx * (t.background.radius ?? 0.15);
    ctx.save();
    ctx.globalAlpha = t.background.alpha ?? 0.6;
    ctx.fillStyle = t.background.color || '#000000';
    ctx.beginPath();
    roundRect(ctx, bx, by, bw, bh, radius);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (t.shadow?.enabled) {
    ctx.shadowColor = hexToRgba(t.shadow.color || '#000000', t.shadow.alpha ?? 0.65);
    ctx.shadowBlur = (t.shadow.blur ?? 8) * info.scale;
    ctx.shadowOffsetX = (t.shadow.x ?? 0) * info.scale;
    ctx.shadowOffsetY = (t.shadow.y ?? 3) * info.scale;
  }
  ctx.fillStyle = t.color || '#ffffff';
  const strokeWidth = (t.strokeWidth ?? 0) * sizePx;
  if (strokeWidth > 0) {
    ctx.strokeStyle = t.strokeColor || '#000000';
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
  }
  for (let i = 0; i < lines.length; i += 1) {
    const y = startY + i * lineHeight;
    if (strokeWidth > 0) drawLineWithSpacingStroke(ctx, lines[i], anchorX, y, spacing);
    drawLineWithSpacing(ctx, lines[i], anchorX, y, spacing);
  }
  ctx.restore();
  layer.swap();
}

function drawLineWithSpacingStroke(ctx, line, x, y, spacing) {
  if (!spacing) {
    ctx.strokeText(line, x, y);
    return;
  }
  const chars = [...line];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cx = x - total / 2;
  for (let i = 0; i < chars.length; i += 1) {
    ctx.strokeText(chars[i], cx + widths[i] / 2, y);
    cx += widths[i] + spacing;
  }
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return `rgba(0,0,0,${alpha})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {object} params evaluated shape params
 */
export function drawShapeClip(layer, params, info) {
  const { width: w, height: h } = layer;
  const ctx = layer.begin();
  const s = params;
  const cx = w / 2;
  const cy = h / 2;
  const sw = Math.max(1, (s.width ?? 0.3) * w);
  const sh = Math.max(1, (s.height ?? 0.3) * h);
  const strokeWidth = (s.strokeWidth ?? 0) * Math.min(w, h);

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, s.fillAlpha ?? 1));
  ctx.fillStyle = s.fill || '#ffffff';
  ctx.strokeStyle = s.stroke || '#000000';
  ctx.lineWidth = strokeWidth;
  ctx.beginPath();

  switch (s.kind) {
    case 'ellipse':
      ctx.ellipse(cx, cy, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      break;
    case 'line':
      ctx.moveTo(cx - sw / 2, cy);
      ctx.lineTo(cx + sw / 2, cy);
      break;
    case 'arrow': {
      const x0 = cx - sw / 2;
      const x1 = cx + sw / 2;
      const head = Math.min(Math.max(6, sh * 0.4), sw * 0.3);
      ctx.moveTo(x0, cy);
      ctx.lineTo(x1 - head, cy);
      ctx.lineTo(x1 - head, cy - head * 0.7);
      ctx.lineTo(x1, cy);
      ctx.lineTo(x1 - head, cy + head * 0.7);
      ctx.lineTo(x1 - head, cy);
      break;
    }
    case 'star': {
      const points = Math.max(3, Math.round(s.points ?? 5));
      const outer = Math.min(sw, sh) / 2;
      const inner = outer * 0.45;
      for (let i = 0; i < points * 2; i += 1) {
        const r = i % 2 === 0 ? outer : inner;
        const angle = (Math.PI * i) / points - Math.PI / 2;
        const px = cx + Math.cos(angle) * r;
        const py = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'rect':
    default: {
      const radius = Math.max(0, Math.min(1, s.radius ?? 0)) * (Math.min(sw, sh) / 2);
      if (radius > 0) roundRect(ctx, cx - sw / 2, cy - sh / 2, sw, sh, radius);
      else ctx.rect(cx - sw / 2, cy - sh / 2, sw, sh);
      break;
    }
  }
  if (s.kind === 'line' || s.kind === 'arrow') {
    ctx.strokeStyle = s.fill || '#ffffff';
    ctx.lineWidth = Math.max(1, strokeWidth || Math.min(w, h) * 0.01);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  } else {
    ctx.fill();
    if (strokeWidth > 0) ctx.stroke();
  }
  ctx.restore();
  layer.swap();
}

export { getMeasureCtx };
