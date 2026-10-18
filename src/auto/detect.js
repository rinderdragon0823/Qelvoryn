/**
 * Real content analysis for the auto-director.
 *
 * Nothing here is faked: frames are actually decoded from the recording,
 * downscaled and compared pixel by pixel.  A "click" is a sharp, localised
 * change between two consecutive samples - which is exactly what a cursor
 * click looks like in a screen recording.
 */

const ANALYSIS_W = 160;
const ANALYSIS_H = 90;

/**
 * Sample frames of an asset and return the inter-frame difference signal.
 *
 * @param {object} opts
 * @param {MediaPool} opts.mediaPool
 * @param {string} opts.assetId
 * @param {number} opts.fromSeconds
 * @param {number} opts.toSeconds
 * @param {number} [opts.sampleFps]
 * @param {(p:number)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.shouldCancel]
 * @returns {Promise<Array<{time:number, meanDiff:number, changedRatio:number, cx:number, cy:number, diff:Float32Array}>>}
 */
export async function sampleFrameDifferences(opts) {
  const {
    mediaPool, assetId, fromSeconds, toSeconds, sampleFps = 8, onProgress = () => {}, shouldCancel = () => false,
  } = opts;
  const url = await mediaPool.getURL(assetId);
  if (!url) throw new Error('素材を読み込めません');

  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('動画をデコードできません')), { once: true });
    setTimeout(() => reject(new Error('動画の読み込みがタイムアウトしました')), 30000);
  });

  const canvas = document.createElement('canvas');
  canvas.width = ANALYSIS_W;
  canvas.height = ANALYSIS_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const duration = Math.min(Number.isFinite(video.duration) ? video.duration : toSeconds, toSeconds);
  const span = Math.max(0, duration - fromSeconds);
  const step = 1 / Math.max(1, sampleFps);
  const samples = [];
  let previous = null;
  const total = Math.ceil(span / step) || 1;
  let count = 0;

  for (let t = fromSeconds; t < duration; t += step) {
    if (shouldCancel()) break;
    // eslint-disable-next-line no-await-in-loop
    await seek(video, Math.min(t, Math.max(0, duration - 0.02)));
    ctx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
    const data = ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H).data;
    const luminance = new Float32Array(ANALYSIS_W * ANALYSIS_H);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      luminance[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    }
    if (previous) {
      const diff = new Float32Array(luminance.length);
      let sum = 0;
      let changed = 0;
      let wx = 0;
      let wy = 0;
      let wsum = 0;
      for (let p = 0; p < luminance.length; p += 1) {
        const d = Math.abs(luminance[p] - previous[p]);
        diff[p] = d;
        sum += d;
        if (d > 0.12) {
          changed += 1;
          const x = p % ANALYSIS_W;
          const y = Math.floor(p / ANALYSIS_W);
          wx += x * d;
          wy += y * d;
          wsum += d;
        }
      }
      samples.push({
        time: t,
        meanDiff: sum / luminance.length,
        changedRatio: changed / luminance.length,
        cx: wsum > 0 ? wx / wsum / ANALYSIS_W : 0.5,
        cy: wsum > 0 ? wy / wsum / ANALYSIS_H : 0.5,
        diff,
      });
    }
    previous = luminance;
    count += 1;
    if (count % 5 === 0) onProgress(Math.min(1, count / total));
  }
  onProgress(1);
  video.removeAttribute('src');
  video.load();
  return samples;
}

function seek(video, time) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 2500);
    video.addEventListener('seeked', finish);
    try {
      video.currentTime = time;
    } catch {
      finish();
    }
  });
}

/**
 * Turn the difference signal into click candidates: sharp peaks that affect
 * only a small part of the screen (a cursor / button, not a scroll).
 */
export function detectClicks(samples, opts = {}) {
  const {
    sensitivity = 1.6,
    minInterval = 0.35,
    maxChangedRatio = 0.22,
    minChangedRatio = 0.0008,
  } = opts;
  if (samples.length < 3) return [];
  const means = samples.map((s) => s.meanDiff);
  const avg = means.reduce((a, b) => a + b, 0) / means.length;
  const variance = means.reduce((a, b) => a + (b - avg) ** 2, 0) / means.length;
  const std = Math.sqrt(variance);
  const threshold = Math.max(avg * 1.15, avg + std * sensitivity * 0.5);

  const candidates = [];
  for (let i = 1; i < samples.length - 1; i += 1) {
    const s = samples[i];
    const isPeak = s.meanDiff >= samples[i - 1].meanDiff && s.meanDiff >= samples[i + 1].meanDiff;
    if (!isPeak) continue;
    if (s.meanDiff < threshold) continue;
    if (s.changedRatio > maxChangedRatio) continue; // too much of the screen changed (scroll / scene change)
    if (s.changedRatio < minChangedRatio) continue;
    candidates.push({
      time: s.time,
      strength: s.meanDiff / (avg || 1),
      x: s.cx,
      y: s.cy,
      changedRatio: s.changedRatio,
    });
  }
  candidates.sort((a, b) => a.time - b.time);
  const merged = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last && c.time - last.time < minInterval) {
      if (c.strength > last.strength) merged[merged.length - 1] = c;
      continue;
    }
    merged.push(c);
  }
  return merged;
}
