/**
 * AutoDirector - "AI編集" support for Qelvoryn.
 *
 * Design rule: the director only ever *creates* objects.  Zooms become a
 * cameraTransform effect clip with keyframes on a dedicated effect track,
 * click marks become shape clips, subtitles become text clips.  Manual edits
 * are never rewritten, manual clips are never moved, and a whole run is a
 * single undoable transaction.
 *
 * Every generated object carries metadata.auto so the UI can label it and the
 * user can find/delete the whole batch.
 */

import { addTrack, insertClip } from '../core/commands.js';
import { createClip, createEffect, subtitleTextStyle } from '../core/model.js';
import { addKeyframe } from '../core/keyframes.js';
import { TICKS_PER_SECOND, secondsToTicks, formatTimecode } from '../core/time.js';
import { sourceSecondsAt } from '../engine/compositor.js';
import { sampleFrameDifferences, detectClicks } from './detect.js';

export const AUTO_META = {
  zoom: 'auto-zoom',
  click: 'auto-click',
  subtitle: 'auto-subtitle',
};

export const AUTO_OPTIONS = {
  sampleFps: 8,
  sensitivity: 1.6,
  zoomLevel: 1.6,
  leadInSeconds: 0.55,
  holdSeconds: 1.1,
  tailSeconds: 0.8,
  mergeGapSeconds: 1.4,
  ringColor: '#ffd166',
  ringSeconds: 0.75,
  subtitleFontSize: 0.062,
  intervalSeconds: 6,
};

/** Map a source time (seconds) back to a timeline position inside a clip. */
export function timelineTicksForSource(clip, sourceSeconds) {
  const span = Math.round(clip.durationTicks * (clip.speed || 1));
  const media = Math.round(sourceSeconds * TICKS_PER_SECOND) - clip.inTicks;
  const local = clip.reversed ? span - media : media;
  return Math.round(clip.startTicks + local / (clip.speed || 1));
}

/** Source windows of every video clip intersecting a timeline range. */
export function sourceWindows(project, range) {
  const out = [];
  for (const track of project.tracks) {
    if (track.kind !== 'video' && track.kind !== 'image') continue;
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (!clip.enabled || clip.type !== 'video' || !clip.assetId) continue;
      const start = Math.max(clip.startTicks, range.inTicks);
      const end = Math.min(clip.startTicks + clip.durationTicks, range.outTicks);
      if (end <= start) continue;
      const a = sourceSecondsAt(clip, start);
      const b = sourceSecondsAt(clip, end);
      out.push({
        clip,
        track,
        timelineIn: start,
        timelineOut: end,
        fromSeconds: Math.min(a, b),
        toSeconds: Math.max(a, b),
      });
    }
  }
  out.sort((x, y) => x.timelineIn - y.timelineIn);
  return out;
}

export class AutoDirector {
  constructor(app) {
    this.app = app;
    this.busy = false;
    this.cancelled = false;
    this.lastClicks = [];
  }

  get store() {
    return this.app.store;
  }

  // ------------------------------------------------------------- analysis --

  /**
   * Analyse the real video content and return click candidates in timeline
   * coordinates.
   */
  async analyzeClicks(opts = {}) {
    const range = opts.range || this.defaultRange();
    const windows = sourceWindows(this.store.state, range);
    if (!windows.length) throw new Error('解析できる動画クリップが範囲内にありません');
    const sampleFps = opts.sampleFps || AUTO_OPTIONS.sampleFps;
    const sensitivity = opts.sensitivity ?? AUTO_OPTIONS.sensitivity;
    const onProgress = opts.onProgress || (() => {});
    this.cancelled = false;

    const clicks = [];
    let wi = 0;
    for (const win of windows) {
      if (this.cancelled) break;
      if (win.toSeconds - win.fromSeconds < 0.3) continue;
      // eslint-disable-next-line no-await-in-loop
      const samples = await sampleFrameDifferences({
        mediaPool: this.app.mediaPool,
        assetId: win.clip.assetId,
        fromSeconds: win.fromSeconds,
        toSeconds: win.toSeconds,
        sampleFps,
        onProgress: (p) => onProgress((wi + p) / windows.length, 'フレームを解析しています…'),
        shouldCancel: () => this.cancelled,
      });
      const found = detectClicks(samples, { sensitivity });
      for (const hit of found) {
        const tick = timelineTicksForSource(win.clip, hit.time);
        if (tick < range.inTicks || tick >= range.outTicks) continue;
        clicks.push({
          ticks: tick,
          x: Math.max(0.12, Math.min(0.88, hit.x)),
          y: Math.max(0.12, Math.min(0.88, hit.y)),
          strength: hit.strength,
          assetId: win.clip.assetId,
        });
      }
      wi += 1;
    }

    clicks.sort((a, b) => a.ticks - b.ticks);
    this.lastClicks = this.mergeClicks(clicks);
    onProgress(1, `${this.lastClicks.length} 件のクリックを検出しました`);
    return this.lastClicks;
  }

  /** Merge detections that are close in time (same click seen twice). */
  mergeClicks(clicks, gapTicks = Math.round(0.4 * TICKS_PER_SECOND)) {
    const out = [];
    for (const c of clicks) {
      const last = out[out.length - 1];
      if (last && c.ticks - last.ticks < gapTicks) {
        const w1 = last.strength;
        const w2 = c.strength;
        last.ticks = Math.round((last.ticks * w1 + c.ticks * w2) / (w1 + w2));
        last.x = (last.x * w1 + c.x * w2) / (w1 + w2);
        last.y = (last.y * w1 + c.y * w2) / (w1 + w2);
        last.strength = Math.max(last.strength, c.strength);
        continue;
      }
      out.push({ ...c });
    }
    return out;
  }

  /** Regular grid of zoom points (explicit user choice, not fake analysis). */
  intervalClicks(range, everySeconds = AUTO_OPTIONS.intervalSeconds) {
    const step = Math.max(1, Math.round(everySeconds * TICKS_PER_SECOND));
    const out = [];
    const positions = [
      { x: 0.5, y: 0.5 },
      { x: 0.36, y: 0.44 },
      { x: 0.64, y: 0.56 },
      { x: 0.5, y: 0.38 },
    ];
    let i = 0;
    for (let t = range.inTicks; t < range.outTicks; t += step) {
      out.push({ ticks: t, ...positions[i % positions.length], strength: 1, synthetic: true });
      i += 1;
    }
    return out;
  }

  defaultRange() {
    const work = this.store.state.settings?.workArea;
    if (work && work.outTicks > work.inTicks) return { inTicks: work.inTicks, outTicks: work.outTicks };
    const dur = this.app.projectDuration();
    return { inTicks: 0, outTicks: Math.max(TICKS_PER_SECOND, dur) };
  }

  // ------------------------------------------------------------ generation --

  /**
   * Run the director.
   *
   * @param {object} opts
   * @param {{inTicks:number,outTicks:number}} opts.range
   * @param {boolean} [opts.zooms]
   * @param {boolean} [opts.rings]
   * @param {Array|null} [opts.cues]     subtitle cues ({startMs,endMs,text})
   * @param {number} [opts.subtitleOffsetMs]
   * @param {'clicks'|'interval'|'preview'} [opts.mode]
   * @param {Array} [opts.clicks]        pre-analysed clicks (preview mode)
   * @param {number} [opts.zoomLevel]
   * @param {number} [opts.intervalSeconds]
   * @returns {{zooms:number, rings:number, subtitles:number, trackIds:string[]}}
   */
  apply(opts = {}) {
    const range = opts.range || this.defaultRange();
    const fps = this.store.state.settings.fps;
    const summary = { zooms: 0, rings: 0, subtitles: 0, trackIds: [] };

    this.store.transact('自動演出を適用', () => {
      const clicks = this.prepareClicks(opts, range);
      if (opts.zooms !== false && clicks.length) {
        const result = this.buildZoomTrack(clicks, { ...opts, range, fps });
        summary.zooms = result.count;
        if (result.trackId) summary.trackIds.push(result.trackId);
      }
      if (opts.rings && clicks.length) {
        const result = this.buildRingTrack(clicks, { ...opts, range, fps });
        summary.rings = result.count;
        if (result.trackId) summary.trackIds.push(result.trackId);
      }
      if (opts.cues && opts.cues.length) {
        const result = this.buildSubtitleTrack(opts.cues, {
          ...opts, range, fps,
        });
        summary.subtitles = result.count;
        if (result.trackId) summary.trackIds.push(result.trackId);
      }
    });
    // The whole batch is selected so the user can inspect or delete it at once.
    if (summary.trackIds.length && this.app.selectTrack) {
      this.app.selectTrack(summary.trackIds[0]);
    }
    return summary;
  }

  prepareClicks(opts, range) {
    if (opts.clicks) return opts.clicks;
    if (opts.mode === 'interval') return this.intervalClicks(range, opts.intervalSeconds);
    return this.lastClicks;
  }

  /** A dedicated effect track with one cameraTransform clip per zoom. */
  buildZoomTrack(clicks, opts) {
    const { fps } = opts;
    const level = opts.zoomLevel ?? AUTO_OPTIONS.zoomLevel;
    const leadIn = secondsToTicks(opts.leadInSeconds ?? AUTO_OPTIONS.leadInSeconds);
    const hold = secondsToTicks(opts.holdSeconds ?? AUTO_OPTIONS.holdSeconds);
    const tail = secondsToTicks(opts.tailSeconds ?? AUTO_OPTIONS.tailSeconds);
    const mergeGap = secondsToTicks(opts.mergeGapSeconds ?? AUTO_OPTIONS.mergeGapSeconds);

    const groups = [];
    for (const click of clicks) {
      const last = groups[groups.length - 1];
      if (last && click.ticks - last.ticks < mergeGap) {
        const w1 = last.strength || 1;
        const w2 = click.strength || 1;
        last.x = (last.x * w1 + click.x * w2) / (w1 + w2);
        last.y = (last.y * w1 + click.y * w2) / (w1 + w2);
        last.strength = Math.max(w1, w2);
        continue;
      }
      groups.push({ ...click });
    }

    // Tracks are ordered top-row-first; index 0 is drawn last (on top of the
    // composite).  Frame effects must sit above the footage they affect, so
    // every AI track is inserted at the top.
    const track = addTrack(this.store, 'effect', { name: '自動演出: ズーム（AI）', index: 0 });
    const trackId = track?.id;
    if (!trackId) return { count: 0, trackId: null };

    let count = 0;
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i];
      const next = groups[i + 1];
      let start = Math.max(0, g.ticks - leadIn);
      const naturalEnd = g.ticks + hold + tail;
      // Never let two zoom segments fight over the same moment.
      const maxEnd = next ? Math.min(naturalEnd, next.ticks - Math.round(0.15 * TICKS_PER_SECOND) + hold) : naturalEnd;
      const end = Math.max(g.ticks + Math.round(0.3 * TICKS_PER_SECOND), maxEnd);
      if (end <= start) continue;

      const fx = createEffect('cameraTransform', {
        scale: level, x: g.x, y: g.y, rotation: 0,
      });
      const clip = createClip('effect', {
        name: `自動ズーム ${formatTimecode(Math.max(0, g.ticks), fps)}`,
        startTicks: start,
        durationTicks: end - start,
        effects: [fx],
        metadata: {
          auto: AUTO_META.zoom,
          autoStrength: g.strength,
          autoSource: g.synthetic ? 'interval' : 'clicks',
        },
      });
      const inT = g.ticks - start;
      const holdT = inT + hold;
      const endT = end - start;
      const path = (key) => `effects.${fx.id}.${key}`;
      const interp = 'easeInOut';
      addKeyframe(clip, path('scale'), 0, 1, interp);
      addKeyframe(clip, path('x'), 0, 0.5, interp);
      addKeyframe(clip, path('y'), 0, 0.5, interp);
      addKeyframe(clip, path('scale'), inT, level, interp);
      addKeyframe(clip, path('x'), inT, g.x, interp);
      addKeyframe(clip, path('y'), inT, g.y, interp);
      addKeyframe(clip, path('scale'), holdT, level, interp);
      addKeyframe(clip, path('x'), holdT, g.x, interp);
      addKeyframe(clip, path('y'), holdT, g.y, interp);
      addKeyframe(clip, path('scale'), endT, 1, interp);
      addKeyframe(clip, path('x'), endT, 0.5, interp);
      addKeyframe(clip, path('y'), endT, 0.5, interp);

      insertClip(this.store, trackId, clip, { resolveOverlap: false, label: '自動ズーム' });
      count += 1;
    }
    return { count, trackId };
  }

  /** Ring/ripple markers for every click on an overlay track. */
  buildRingTrack(clicks, opts) {
    const { fps } = opts;
    const color = opts.ringColor || AUTO_OPTIONS.ringColor;
    const duration = secondsToTicks(opts.ringSeconds ?? AUTO_OPTIONS.ringSeconds);
    const ratio = this.store.state.settings.height
      ? this.store.state.settings.width / this.store.state.settings.height
      : 1.7777;

    const track = addTrack(this.store, 'overlay', { name: '自動演出: クリック（AI）', index: 0 });
    const trackId = track?.id;
    if (!trackId) return { count: 0, trackId: null };

    let count = 0;
    for (const g of clicks) {
      const clip = createClip('shape', {
        name: `クリック ${formatTimecode(Math.max(0, g.ticks), fps)}`,
        startTicks: Math.max(0, g.ticks),
        durationTicks: duration,
        transform: { x: g.x, y: g.y },
        shape: {
          kind: 'ellipse',
          width: 0.05,
          height: 0.05 * ratio,
          stroke: color,
          strokeWidth: 0.01,
          fill: color,
          fillAlpha: 0.22,
        },
        metadata: { auto: AUTO_META.click, autoStrength: g.strength },
      });
      addKeyframe(clip, 'shape.width', 0, 0.03, 'easeOut');
      addKeyframe(clip, 'shape.height', 0, 0.03 * ratio, 'easeOut');
      addKeyframe(clip, 'shape.width', duration, 0.3, 'easeOut');
      addKeyframe(clip, 'shape.height', duration, 0.3 * ratio, 'easeOut');
      addKeyframe(clip, 'opacity', 0, 0.95, 'easeOut');
      addKeyframe(clip, 'opacity', duration, 0, 'easeOut');
      addKeyframe(clip, 'shape.strokeWidth', 0, 0.01, 'easeOut');
      addKeyframe(clip, 'shape.strokeWidth', duration, 0.002, 'easeOut');
      insertClip(this.store, trackId, clip, { resolveOverlap: false, label: 'クリック演出' });
      count += 1;
    }
    return { count, trackId };
  }

  /**
   * Turn subtitle cues (source time) into timeline text clips.  A cue that
   * spans a cut is split - the text still appears over the right footage.
   */
  buildSubtitleTrack(cues, opts) {
    const { range } = opts;
    const offsetMs = opts.subtitleOffsetMs || 0;
    const windows = sourceWindows(this.store.state, range);
    const track = addTrack(this.store, 'text', { name: '字幕（AI）', index: 0 });
    const trackId = track?.id;
    if (!trackId) return { count: 0, trackId: null };

    let count = 0;
    for (const cue of cues) {
      const fromSec = Math.max(0, (cue.startMs + offsetMs) / 1000);
      const toSec = Math.max(fromSec + 0.2, (cue.endMs + offsetMs) / 1000);
      for (const win of windows) {
        const a = Math.max(fromSec, win.fromSeconds);
        const b = Math.min(toSec, win.toSeconds);
        if (b - a < 0.12) continue;
        let t0 = timelineTicksForSource(win.clip, a);
        let t1 = timelineTicksForSource(win.clip, b);
        if (t0 > t1) [t0, t1] = [t1, t0];
        t1 = Math.max(t1, t0 + Math.round(0.15 * TICKS_PER_SECOND));
        const clip = createClip('text', {
          name: cue.text.slice(0, 18) || '字幕',
          startTicks: t0,
          durationTicks: t1 - t0,
          text: subtitleTextStyle(cue.text, {
            fontSize: opts.subtitleFontSize ?? AUTO_OPTIONS.subtitleFontSize,
          }),
          transform: { x: 0.5, y: 0.86 },
          metadata: { auto: AUTO_META.subtitle, cueStartMs: cue.startMs, cueEndMs: cue.endMs },
        });
        insertClip(this.store, trackId, clip, { resolveOverlap: false, label: '字幕を追加' });
        count += 1;
      }
    }
    return { count, trackId };
  }

  /**
   * Remove objects created by a previous run of the director.
   *
   * @param {string} [kind] one of AUTO_META.* - when given only that kind is
   *   removed, otherwise every auto object on an AI track is deleted.
   * @returns {number} number of clips removed
   */
  removeAutoObjects(kind) {
    const store = this.store;
    const removed = [];
    for (const track of store.state.tracks) {
      for (const clip of track.clips) {
        if (!clip.metadata?.auto) continue;
        if (kind && clip.metadata.auto !== kind) continue;
        if (!kind && !track.name?.includes('（AI）')) continue;
        removed.push(clip.id);
      }
    }
    if (!removed.length) return 0;
    const ids = new Set(removed);
    store.transact('自動演出を削除', () => {
      for (let i = store.state.tracks.length - 1; i >= 0; i -= 1) {
        const track = store.state.tracks[i];
        const isAutoTrack = !!track.name?.includes('（AI）');
        if (!isAutoTrack) {
          const keep = track.clips.filter((c) => !ids.has(c.id));
          if (keep.length !== track.clips.length) {
            store.touch(['tracks', i, 'clips']);
            track.clips = keep;
          }
          continue;
        }
        if (track.clips.length > 0 && track.clips.every((c) => ids.has(c.id))) {
          store.touch(['tracks', i]);
          store.state.tracks.splice(i, 1);
        } else {
          store.touch(['tracks', i, 'clips']);
          track.clips = track.clips.filter((c) => !ids.has(c.id));
        }
      }
    });
    return removed.length;
  }
}
