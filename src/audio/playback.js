/**
 * Playback controller.
 *
 * The WebAudio clock is the master time source: audio is scheduled ahead of
 * time and the video elements are slaved to it, which keeps A/V sync stable
 * even when the browser drops video frames.
 */

import { Emitter } from '../core/events.js';
import { TICKS_PER_SECOND } from '../core/time.js';
import { sourceSecondsAt } from '../engine/compositor.js';
import { scheduleProjectAudio, pendingAudioAssets } from './audiograph.js';

const VIDEO_RESYNC_THRESHOLD = 0.12;

/**
 * Slave every video element of the project to the master clock.
 * Shared by preview playback and by the exporter so both stay in sync the
 * exact same way.
 */
export function syncVideoElements(mediaPool, project, timeTicks, opts = {}) {
  const { playing = true, threshold = VIDEO_RESYNC_THRESHOLD, activeKeys } = opts;
  const reach = opts.reachTicks ?? Math.round(1.5 * TICKS_PER_SECOND);
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type !== 'video' || !clip.assetId || !clip.enabled) continue;
      const end = clip.startTicks + clip.durationTicks;
      const isActive = timeTicks >= clip.startTicks - reach && timeTicks < end + reach;
      const el = mediaPool.videoFor(clip.assetId, clip.id);
      if (!isActive) {
        if (!el.paused) {
          try {
            el.pause();
          } catch {
            /* ignore */
          }
        }
        continue;
      }
      activeKeys?.add(`${clip.assetId}::${clip.id}`);
      const desired = sourceSecondsAt(clip, Math.max(clip.startTicks, Math.min(timeTicks, end - 1)));
      const speed = Math.max(0.0625, Math.min(16, clip.speed || 1));
      if (el.playbackRate !== speed) el.playbackRate = speed;
      const drift = Math.abs((el.currentTime || 0) - desired);
      if (drift > threshold) {
        try {
          el.currentTime = desired;
        } catch {
          /* ignore */
        }
      } else if (playing && el.paused) {
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
      }
    }
  }
}

export class PlaybackController extends Emitter {
  constructor({ mediaPool, store }) {
    super();
    this.mediaPool = mediaPool;
    this.store = store;
    this.ctx = null;
    this.destination = null;
    this.handles = [];
    this.playing = false;
    this.startTicks = 0;
    this.ctxStartTime = 0;
    this.endTicks = 0;
    this.rafId = 0;
    this.activeVideoKeys = new Set();
    this.volume = 1;
    this.reportMissing = true;
  }

  get audioContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ sampleRate: 48000 });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.destination = this.master;
    }
    return this.ctx;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(2, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  get isPlaying() {
    return this.playing;
  }

  /** Decode every audio asset the project references (called before play). */
  async prepareAudio(project) {
    const pending = pendingAudioAssets(project, this.mediaPool);
    if (!pending.length) return { ok: true, missing: [] };
    const results = await Promise.all(pending.map((p) => this.mediaPool.getAudioBuffer(p.assetId)));
    const missing = pending.filter((p, i) => !results[i]);
    return { ok: missing.length === 0, missing };
  }

  /** Seek all videos that will be needed right after `fromTicks`. */
  async primeVideos(project, fromTicks, window = 1.5) {
    const jobs = [];
    const horizon = fromTicks + Math.round(window * TICKS_PER_SECOND);
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.type !== 'video' || !clip.assetId) continue;
        const end = clip.startTicks + clip.durationTicks;
        if (end <= fromTicks || clip.startTicks > horizon) continue;
        const el = this.mediaPool.videoFor(clip.assetId, clip.id);
        const seconds = sourceSecondsAt(clip, Math.max(clip.startTicks, fromTicks));
        jobs.push(this.mediaPool.seekVideo(el, seconds).catch(() => false));
      }
    }
    return Promise.all(jobs);
  }

  async play(project, fromTicks, toTicks) {
    if (this.playing) this.stop();
    const ctx = this.audioContext;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const duration = Math.max(0, toTicks - fromTicks);
    if (duration <= 0) return false;

    await this.primeVideos(project, fromTicks);

    const startTime = ctx.currentTime + 0.08;
    const { handles, missing } = scheduleProjectAudio(ctx, {
      project,
      destination: this.destination,
      mediaPool: this.mediaPool,
      fromTicks,
      toTicks,
      timeOffset: 0.08,
    });

    this.handles = handles;
    this.playing = true;
    this.startTicks = fromTicks;
    this.ctxStartTime = startTime;
    this.endTicks = toTicks;
    this.videoSyncState = new Map();

    if (missing.length && this.reportMissing) {
      const names = [...new Set(missing.map((m) => m.name))].join(', ');
      this.emit('warning', { message: `音声を再生できません(デコード未対応): ${names}` });
    }

    this.emit('play', { fromTicks, toTicks });
    this._loop();
    return true;
  }

  currentTicks() {
    if (!this.playing) return this.startTicks;
    const ctx = this.ctx;
    const elapsed = ctx.currentTime - this.ctxStartTime;
    const ticks = this.startTicks + Math.round(elapsed * TICKS_PER_SECOND);
    return Math.min(ticks, this.endTicks);
  }

  seek(ticks) {
    if (this.playing) {
      const wasPlaying = this.playing;
      this.stop({ silent: true });
      this.startTicks = Math.max(0, Math.round(ticks));
      if (wasPlaying) {
        const project = this.store.state;
        this.play(project, this.startTicks, this.endTicks).catch(() => {});
      }
    } else {
      this.startTicks = Math.max(0, Math.round(ticks));
    }
  }

  stop(opts = {}) {
    const wasPlaying = this.playing;
    this.playing = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const handle of this.handles) {
      try {
        handle.stop(now);
      } catch {
        /* ignore */
      }
    }
    this.handles = [];
    this.pauseAllVideos();
    if (wasPlaying && !opts.silent) this.emit('stop', {});
  }

  pause() {
    if (!this.playing) return;
    const at = this.currentTicks();
    this.stop();
    this.startTicks = at;
    this.emit('paused', { at });
  }

  pauseAllVideos() {
    for (const key of this.activeVideoKeys) {
      const [assetId, owner] = key.split('::');
      const el = this.mediaPool.videoElements.get(`${assetId}::${owner}`);
      if (el) {
        try {
          el.pause();
        } catch {
          /* ignore */
        }
      }
    }
    this.activeVideoKeys.clear();
  }

  /** Keep every visible video element glued to the master clock. */
  syncVideos(project, timeTicks) {
    this.activeVideoKeys = new Set();
    syncVideoElements(this.mediaPool, project, timeTicks, {
      playing: this.playing,
      activeKeys: this.activeVideoKeys,
    });
  }

  _loop() {
    const tick = () => {
      if (!this.playing) return;
      const time = this.currentTicks();
      const project = this.store.state;
      this.syncVideos(project, time);
      this.emit('time', { timeTicks: time });
      if (time >= this.endTicks) {
        this.stop();
        this.emit('ended', { timeTicks: time });
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  dispose() {
    this.stop({ silent: true });
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
