/**
 * Qelvoryn audio engine.
 *
 * Every audible sample comes from a decoded AudioBuffer (real file data), is
 * routed through a per-clip graph and scheduled against the WebAudio clock,
 * which doubles as the master clock for video playback.  That is what keeps
 * picture and sound locked together during preview and export.
 *
 *   source -> clip gain (automation) -> EQ -> delay -> panner -> track gain
 *          -> master -> destination
 */

import { evaluateParam } from '../core/keyframes.js';
import { TICKS_PER_SECOND } from '../core/time.js';
import { getEffectDef } from '../engine/effectdefs.js';

const LOOKAHEAD = 0.12; // seconds of scheduling headroom

export function ticksToSec(ticks) {
  return ticks / TICKS_PER_SECOND;
}

export function isAudioClipAudible(clip, track) {
  if (!clip.enabled) return false;
  if (track.muted) return false;
  if (track.kind === 'video' || track.kind === 'image' || track.kind === 'overlay') {
    // video tracks carry audio when the asset has a sound track
  }
  return true;
}

/**
 * Automation breakpoints for a clip's volume, expressed in *source* ticks
 * relative to the clip's in-point (0 == first audible sample).
 * Keyframes are sampled with 12 subdivisions per segment so eased curves are
 * reproduced faithfully.
 */
export function buildVolumeAutomation(clip, subdivisions = 12) {
  const points = [];
  const kfs = clip.keyframes?.volume;
  const base = clip.volume ?? 1;
  const span = Math.max(1, Math.round(clip.durationTicks * (clip.speed || 1)));
  if (!kfs || kfs.length === 0) {
    points.push({ t: 0, v: base });
    points.push({ t: span, v: base });
  } else {
    if (kfs[0].t > 0) points.push({ t: 0, v: kfs[0].v });
    for (let i = 0; i < kfs.length - 1; i += 1) {
      const a = kfs[i];
      const b = kfs[i + 1];
      points.push({ t: a.t, v: a.v });
      const steps = a.interp === 'hold' ? 1 : subdivisions;
      for (let s = 1; s < steps; s += 1) {
        const tt = a.t + ((b.t - a.t) * s) / steps;
        points.push({ t: tt, v: evaluateParam(clip, 'volume', tt, base) });
      }
    }
    points.push({ t: kfs[kfs.length - 1].t, v: kfs[kfs.length - 1].v });
    if (points[points.length - 1].t < span) points.push({ t: span, v: kfs[kfs.length - 1].v });
  }

  // Built-in fade handles (same as the triangles drawn on the clip).
  const fadeIn = Math.max(0, Math.round(clip.fades?.inTicks || 0));
  const fadeOut = Math.max(0, Math.round(clip.fades?.outTicks || 0));
  if (fadeIn > 0) {
    points.push({ t: 0, v: 0 });
    points.push({ t: fadeIn, v: 1, multiply: true });
  }
  if (fadeOut > 0) {
    points.push({ t: Math.max(0, span - fadeOut), v: 1, multiply: true });
    points.push({ t: span, v: 0 });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

function fadeMultiplierAt(clip, localTicks) {
  const span = Math.max(1, Math.round(clip.durationTicks * (clip.speed || 1)));
  let m = 1;
  const fadeIn = Math.max(0, clip.fades?.inTicks || 0);
  const fadeOut = Math.max(0, clip.fades?.outTicks || 0);
  if (fadeIn > 0 && localTicks < fadeIn) m *= Math.max(0, localTicks / fadeIn);
  if (fadeOut > 0 && localTicks > span - fadeOut) m *= Math.max(0, (span - localTicks) / fadeOut);
  return m;
}

/**
 * Schedule one audio clip on a WebAudio context.
 *
 * @param {AudioContext} ctx
 * @param {object} opts
 * @param {AudioNode} opts.destination
 * @param {AudioBuffer} opts.buffer
 * @param {object} opts.clip
 * @param {object} opts.track
 * @param {number} opts.when         context time at which the clip should start
 * @param {number} opts.offsetSec    offset inside the source buffer
 * @param {number} opts.wallDuration wall-clock duration to play
 * @param {number} opts.localStart   source-relative local tick corresponding to `when`
 * @returns {{stop:(when?:number)=>void, nodes:object[]}|null}
 */
export function scheduleAudioClip(ctx, opts) {
  const { destination, buffer, clip, track, when, offsetSec, wallDuration, localStart } = opts;
  if (!buffer || wallDuration <= 0.001) return null;

  const nodes = [];
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = Math.max(0.0625, Math.min(16, clip.speed || 1));
  nodes.push(source);

  const gain = ctx.createGain();
  nodes.push(gain);

  const trackGain = ctx.createGain();
  const trackMute = track.muted ? 0 : 1;
  const trackVolume = Math.max(0, track.volume ?? 1) * trackMute;
  trackGain.gain.value = trackVolume;
  nodes.push(trackGain);

  const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
  if (panner) nodes.push(panner);

  // Gain automation -------------------------------------------------------
  const automation = buildVolumeAutomation(clip);
  const speed = Math.max(0.0625, clip.speed || 1);
  const endLocal = localStart + wallDuration * TICKS_PER_SECOND * speed;
  const relevant = automation.filter((p) => p.t >= localStart - 1 && p.t <= endLocal + 1);
  if (!relevant.length) relevant.push({ t: localStart, v: evaluateParam(clip, 'volume', localStart, clip.volume ?? 1) });
  gain.gain.cancelScheduledValues(when);
  const first = relevant[0];
  const startValue = Math.max(0, (first.v ?? 1) * fadeMultiplierAt(clip, first.t));
  gain.gain.setValueAtTime(startValue, when);
  for (let i = 1; i < relevant.length; i += 1) {
    const p = relevant[i];
    const at = when + ticksToSec(p.t - localStart) / speed;
    const value = Math.max(0, Math.min(4, (p.v ?? 1) * fadeMultiplierAt(clip, p.t)));
    gain.gain.linearRampToValueAtTime(value, Math.max(when + 0.001, at));
  }

  // Effect chain ----------------------------------------------------------
  let tail = gain;
  const eqFx = clip.effects?.find((f) => f.enabled && f.type === 'audioEQ');
  if (eqFx) {
    const def = getEffectDef('audioEQ');
    const p = (key) => evaluateParam(clip, `effects.${eqFx.id}.${key}`, localStart, eqFx.params[key] ?? def.params.find((d) => d.key === key).default);
    const specs = [
      { type: 'lowshelf', freq: 200, gain: p('low') },
      { type: 'peaking', freq: 1000, Q: 0.9, gain: p('mid') },
      { type: 'highshelf', freq: 6000, gain: p('high') },
    ];
    for (const spec of specs) {
      if (Math.abs(spec.gain) < 0.01) continue;
      const filter = ctx.createBiquadFilter();
      filter.type = spec.type;
      filter.frequency.value = spec.freq;
      if (spec.Q) filter.Q.value = spec.Q;
      filter.gain.value = Math.max(-40, Math.min(40, spec.gain));
      nodes.push(filter);
      tail.connect(filter);
      tail = filter;
    }
  }

  const gainFx = clip.effects?.find((f) => f.enabled && f.type === 'audioGain');
  if (gainFx) {
    const g = evaluateParam(clip, `effects.${gainFx.id}.gain`, localStart, gainFx.params.gain ?? 1);
    const pan = evaluateParam(clip, `effects.${gainFx.id}.pan`, localStart, gainFx.params.pan ?? 0);
    const fxGain = ctx.createGain();
    fxGain.gain.value = Math.max(0, Math.min(4, g));
    nodes.push(fxGain);
    tail.connect(fxGain);
    tail = fxGain;
    if (panner) panner.pan.value = Math.max(-1, Math.min(1, pan));
  }

  const delayFx = clip.effects?.find((f) => f.enabled && f.type === 'audioDelay');
  if (delayFx) {
    const dTime = evaluateParam(clip, `effects.${delayFx.id}.time`, localStart, delayFx.params.time ?? 0.25);
    const fb = evaluateParam(clip, `effects.${delayFx.id}.feedback`, localStart, delayFx.params.feedback ?? 0.25);
    const mix = evaluateParam(clip, `effects.${delayFx.id}.mix`, localStart, delayFx.params.mix ?? 0.3);
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const delay = ctx.createDelay(2);
    const feedback = ctx.createGain();
    delay.delayTime.value = Math.max(0.01, Math.min(1.9, dTime));
    feedback.gain.value = Math.max(0, Math.min(0.9, fb));
    dry.gain.value = 1 - Math.max(0, Math.min(1, mix));
    wet.gain.value = Math.max(0, Math.min(1, mix));
    tail.connect(dry);
    tail.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    const merge = ctx.createGain();
    dry.connect(merge);
    wet.connect(merge);
    nodes.push(dry, wet, delay, feedback, merge);
    tail = merge;
  }

  if (panner) {
    tail.connect(panner);
    tail = panner;
  }
  tail.connect(trackGain);
  trackGain.connect(destination);

  source.start(when, Math.max(0, offsetSec));
  const stopAt = when + Math.max(0.01, wallDuration);
  try {
    source.stop(stopAt);
  } catch {
    /* ignore */
  }

  return {
    nodes,
    stop(at) {
      try {
        source.stop(at ?? ctx.currentTime);
      } catch {
        /* already stopped */
      }
    },
    stopAt,
  };
}

/**
 * Schedule every audible clip of the project that overlaps [fromTicks, toTicks).
 * Returns a list of handles that can be stopped together.
 */
export function scheduleProjectAudio(ctx, { project, destination, mediaPool, fromTicks, toTicks, timeOffset = LOOKAHEAD }) {
  const handles = [];
  const missing = [];
  const soloTracks = project.tracks.filter((t) => t.solo);
  const anySolo = soloTracks.length > 0;

  for (const track of project.tracks) {
    if (track.muted) continue;
    if (anySolo && !track.solo) continue;
    for (const clip of track.clips) {
      if (!clip.enabled || clip.type === 'text' || clip.type === 'shape' || clip.type === 'effect') continue;
      const clipEnd = clip.startTicks + clip.durationTicks;
      if (clipEnd <= fromTicks || clip.startTicks >= toTicks) continue;
      const asset = project.assets[clip.assetId];
      if (!asset) continue;
      const buffer = mediaPool.getAudioBufferSync?.(clip.assetId) || mediaPool.audioBuffers.get(clip.assetId);
      if (!buffer) {
        // Assets already known to be silent (no audio track / undecodable
        // codec) are skipped without a warning; only unexpected gaps are
        // reported so playback never spams the user.
        if (asset.hasAudio !== false) {
          missing.push({ clipId: clip.id, assetId: clip.assetId, name: asset.name });
        }
        continue;
      }
      const startTicks = Math.max(clip.startTicks, fromTicks);
      const skipTicks = startTicks - clip.startTicks;
      const wallDuration = ticksToSec(clipEnd - startTicks);
      if (wallDuration <= 0.002) continue;
      const speed = Math.max(0.0625, clip.speed || 1);
      const offsetSec = (clip.inTicks + skipTicks * speed) / TICKS_PER_SECOND;
      const when = ctx.currentTime + timeOffset + ticksToSec(startTicks - fromTicks);
      const handle = scheduleAudioClip(ctx, {
        destination,
        buffer,
        clip,
        track,
        when,
        offsetSec,
        wallDuration,
        localStart: Math.round(skipTicks * speed),
      });
      if (handle) handles.push(handle);
    }
  }
  return { handles, missing };
}

/** Which audio assets still need decoding before playback can be exact. */
export function pendingAudioAssets(project, mediaPool) {
  const pending = [];
  const seen = new Set();
  const soloTracks = project.tracks.filter((t) => t.solo);
  const anySolo = soloTracks.length > 0;
  for (const track of project.tracks) {
    if (track.muted) continue;
    if (anySolo && !track.solo) continue;
    for (const clip of track.clips) {
      if (!clip.assetId || seen.has(clip.assetId)) continue;
      if (clip.type === 'text' || clip.type === 'shape' || clip.type === 'effect') continue;
      seen.add(clip.assetId);
      const asset = project.assets[clip.assetId];
      if (!asset) continue;
      if (!mediaPool.audioBuffers.has(clip.assetId) && asset.hasAudio !== false) {
        pending.push({ assetId: clip.assetId, name: asset.name });
      }
    }
  }
  return pending;
}
