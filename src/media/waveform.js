/**
 * Waveform peak extraction.
 *
 * Peaks are computed from the *decoded* audio buffer, so every waveform the
 * editor draws is real data taken from the imported file (never a placeholder
 * shape).  min/max/rms are kept per bucket so the timeline can render both a
 * classic envelope and an RMS body.
 */

const cache = new WeakMap();

export const DEFAULT_PEAKS_PER_SECOND = 400;

/**
 * @param {AudioBuffer} buffer
 * @param {number} peaksPerSecond
 * @returns {{peaksPerSecond:number, frames:number, duration:number, min:Float32Array, max:Float32Array, rms:Float32Array, channels:number}}
 */
export function computePeaks(buffer, peaksPerSecond = DEFAULT_PEAKS_PER_SECOND) {
  const cached = buffer ? cache.get(buffer) : null;
  if (cached && cached.peaksPerSecond === peaksPerSecond) return cached;

  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const totalFrames = buffer.length;
  const samplesPerBucket = Math.max(1, Math.floor(sampleRate / peaksPerSecond));
  const bucketCount = Math.max(1, Math.ceil(totalFrames / samplesPerBucket));

  const min = new Float32Array(bucketCount);
  const max = new Float32Array(bucketCount);
  const rms = new Float32Array(bucketCount);

  const data = [];
  for (let c = 0; c < channels; c += 1) data.push(buffer.getChannelData(c));

  for (let b = 0; b < bucketCount; b += 1) {
    const start = b * samplesPerBucket;
    const end = Math.min(start + samplesPerBucket, totalFrames);
    let lo = 0;
    let hi = 0;
    let sumSq = 0;
    let count = 0;
    for (let c = 0; c < channels; c += 1) {
      const ch = data[c];
      for (let i = start; i < end; i += 1) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sumSq += v * v;
        count += 1;
      }
    }
    min[b] = lo;
    max[b] = hi;
    rms[b] = count ? Math.sqrt(sumSq / count) : 0;
  }

  const peaks = {
    peaksPerSecond,
    frames: totalFrames,
    duration: totalFrames / sampleRate,
    sampleRate,
    channels,
    min,
    max,
    rms,
  };
  if (buffer) cache.set(buffer, peaks);
  return peaks;
}

/** Peak range covering [startSeconds, endSeconds). */
export function peaksRange(peaks, startSeconds, endSeconds) {
  const from = Math.max(0, Math.floor(startSeconds * peaks.peaksPerSecond));
  const to = Math.min(peaks.min.length, Math.ceil(endSeconds * peaks.peaksPerSecond));
  if (to <= from) return { min: 0, max: 0, rms: 0, count: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  let sumRms = 0;
  for (let i = from; i < to; i += 1) {
    if (peaks.min[i] < lo) lo = peaks.min[i];
    if (peaks.max[i] > hi) hi = peaks.max[i];
    sumRms += peaks.rms[i] * peaks.rms[i];
  }
  const count = to - from;
  return { min: lo, max: hi, rms: Math.sqrt(sumRms / count), count };
}

/**
 * Build a min/max envelope adapted to a pixel column count.
 * @returns {{min:Float32Array, max:Float32Array, rms:Float32Array}}
 */
export function envelopeForWidth(peaks, startSeconds, endSeconds, columns) {
  const out = {
    min: new Float32Array(columns),
    max: new Float32Array(columns),
    rms: new Float32Array(columns),
  };
  if (!peaks || columns <= 0) return out;
  const span = Math.max(1e-6, endSeconds - startSeconds);
  const perColumn = span / columns;
  for (let c = 0; c < columns; c += 1) {
    const s = startSeconds + c * perColumn;
    const e = s + perColumn;
    const r = peaksRange(peaks, s, e);
    out.min[c] = Number.isFinite(r.min) ? r.min : 0;
    out.max[c] = Number.isFinite(r.max) ? r.max : 0;
    out.rms[c] = Number.isFinite(r.rms) ? r.rms : 0;
  }
  return out;
}
