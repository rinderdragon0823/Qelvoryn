/**
 * Reusable canvas buffers.
 *
 * Rendering a frame needs a handful of full-size canvases (accumulated frame,
 * clip layer, ping-pong buffers, mask).  They are pooled by tag+size so a
 * long preview session does not allocate megabytes every frame.
 */

const pool = new Map();

/** @returns {HTMLCanvasElement} */
export function acquireCanvas(width, height, tag = 'tmp') {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const key = `${tag}:${w}x${h}`;
  let entry = pool.get(key);
  if (!entry) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    entry = canvas;
    pool.set(key, canvas);
  }
  return entry;
}

export function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return ctx;
}

export function releaseAllBuffers() {
  for (const canvas of pool.values()) {
    canvas.width = 1;
    canvas.height = 1;
  }
  pool.clear();
}

/**
 * A double-buffered drawing surface used by the effect chain.
 *
 *   layer.begin()      -> context of the back buffer (cleared)
 *   layer.srcCanvas    -> the current front buffer (input pixels)
 *   layer.swap()       -> make the back buffer the new front
 */
export class Layer {
  constructor(width, height, tag = 'layer') {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.front = acquireCanvas(this.width, this.height, `${tag}A`);
    this.back = acquireCanvas(this.width, this.height, `${tag}B`);
  }

  get canvas() {
    return this.front;
  }

  get ctx() {
    return this.front.getContext('2d');
  }

  get srcCanvas() {
    return this.front;
  }

  /** Cleared back-buffer context ready to receive the next operation. */
  begin() {
    const ctx = clearCanvas(this.back);
    return ctx;
  }

  swap() {
    const tmp = this.front;
    this.front = this.back;
    this.back = tmp;
    return this;
  }

  clear() {
    clearCanvas(this.front);
    clearCanvas(this.back);
    return this;
  }

  /** Draw the front buffer into an arbitrary context. */
  drawInto(ctx, ...args) {
    ctx.drawImage(this.front, ...args);
  }

  cloneFrontToBack() {
    const ctx = clearCanvas(this.back);
    ctx.drawImage(this.front, 0, 0);
    this.swap();
    return this;
  }
}
