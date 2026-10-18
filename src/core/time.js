/**
 * Qelvoryn time model.
 *
 * All timeline positions are stored as *integer ticks* to avoid accumulating
 * floating point error.  TICKS_PER_SECOND is chosen so that every common
 * frame rate (including the 1000/1001 pulldown rates) maps to a whole number
 * of ticks per frame:
 *
 *   24      -> 5000 ticks
 *   23.976  -> 5005 ticks   (24000/1001)
 *   25      -> 4800 ticks
 *   29.97   -> 4004 ticks   (30000/1001)
 *   30      -> 4000 ticks
 *   50      -> 2400 ticks
 *   59.94   -> 2002 ticks   (60000/1001)
 *   60      -> 2000 ticks
 *
 * Because ticks are integers, every edit operation (move, trim, split,
 * ripple) is exact: adding and subtracting durations never drifts.
 */

export const TICKS_PER_SECOND = 120000;

/** Frame rate presets expressed as exact rationals. */
const RATE_TABLE = [
  { num: 24000, den: 1001, label: '23.976' },
  { num: 24, den: 1, label: '24' },
  { num: 25, den: 1, label: '25' },
  { num: 30000, den: 1001, label: '29.97' },
  { num: 30, den: 1, label: '30' },
  { num: 50, den: 1, label: '50' },
  { num: 60000, den: 1001, label: '59.94' },
  { num: 60, den: 1, label: '60' },
];

/** Resolve a (possibly fractional) frame rate to an exact rational. */
export function rateRational(fps) {
  const rounded = Math.round(fps * 1000) / 1000;
  for (const r of RATE_TABLE) {
    // Tolerance wide enough for the usual shorthand spellings ("23.98" for
    // 23.976, "29.97" for 29.97003, ...) but too tight to confuse two presets.
    if (Math.abs(r.num / r.den - rounded) < 0.012) return { num: r.num, den: r.den };
  }
  // Fall back to a rational with at most 3 decimals of precision.
  const num = Math.round(rounded * 1000);
  return { num, den: 1000 };
}

/** Number of ticks in a single frame at the given frame rate. */
export function ticksPerFrame(fps) {
  const { num, den } = rateRational(fps);
  return (TICKS_PER_SECOND * den) / num;
}

export function secondsToTicks(seconds) {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks) {
  return ticks / TICKS_PER_SECOND;
}

export function framesToTicks(frames, fps) {
  return Math.round(frames * ticksPerFrame(fps));
}

export function ticksToFrames(ticks, fps) {
  return ticks / ticksPerFrame(fps);
}

export function snapTicksToFrame(ticks, fps) {
  const tpf = ticksPerFrame(fps);
  return Math.round(ticks / tpf) * tpf;
}

export function floorTicksToFrame(ticks, fps) {
  const tpf = ticksPerFrame(fps);
  return Math.floor(ticks / tpf) * tpf;
}

export function ceilTicksToFrame(ticks, fps) {
  const tpf = ticksPerFrame(fps);
  return Math.ceil(ticks / tpf) * tpf;
}

/**
 * Format ticks as a non-drop-frame timecode HH:MM:SS:FF.
 * @param {number} ticks
 * @param {number} fps
 * @param {{frames?: boolean}} [opts]
 */
export function formatTimecode(ticks, fps, opts = {}) {
  const negative = ticks < 0;
  let t = Math.abs(Math.round(ticks));
  const tpf = ticksPerFrame(fps);
  const totalFrames = Math.round(t / tpf);
  const framesPerSecond = Math.round(TICKS_PER_SECOND / tpf);
  const frames = totalFrames % framesPerSecond;
  const totalSeconds = Math.floor(totalFrames / framesPerSecond);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const base = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
  if (opts.frames) return `${negative ? '-' : ''}${totalFrames}`;
  return `${negative ? '-' : ''}${base}`;
}

/** Short human readable duration, e.g. "1:23.4" */
export function formatDuration(ticks) {
  const s = ticksToSeconds(ticks);
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(s);
  const m = Math.floor(a / 60);
  const rest = a - m * 60;
  return `${sign}${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** Parse "HH:MM:SS:FF", "MM:SS", "12.5s" or a raw number of seconds. */
export function parseTimecode(input, fps) {
  if (typeof input === 'number') return secondsToTicks(input);
  const text = String(input).trim();
  if (!text) return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return secondsToTicks(parseFloat(text));
  if (/^-?\d+(\.\d+)?s$/i.test(text)) return secondsToTicks(parseFloat(text));
  const parts = text.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 4) return null;
  if (parts.some((p) => p !== '' && !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map((p) => (p === '' ? 0 : parseFloat(p)));
  let seconds = 0;
  let frames = 0;
  if (parts.length === 2) {
    seconds = nums[0] * 60 + nums[1];
  } else if (parts.length === 3) {
    seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
  } else {
    seconds = nums[0] * 3600 + nums[1] * 60 + nums[2] + (nums[3] || 0) / fps;
  }
  if (parts.length === 4) {
    const framePart = nums[3] || 0;
    return secondsToTicks(nums[0] * 3600 + nums[1] * 60 + nums[2]) + framesToTicks(framePart, fps);
  }
  return secondsToTicks(seconds);
}

export function clampTicks(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Greatest common divisor helper used when reducing tick ratios for zoom UI. */
export function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}
