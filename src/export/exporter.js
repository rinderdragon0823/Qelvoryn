/**
 * Exporter: composes the whole project into a single video file.
 *
 * The frames come from the *same* compositor the preview uses, driven by a
 * dedicated AudioContext that also renders the mixed soundtrack into a
 * MediaStreamAudioDestinationNode.  Picture and sound are therefore scheduled
 * against one clock and stay locked together.
 *
 * Output containers:
 *   - WebM (VP9/VP8 + Opus) - available in every Chromium/Firefox build
 *   - MP4  (H.264 + AAC)    - used automatically where MediaRecorder supports it
 *
 * MediaRecorder timestamps frames in real time, so the export runs at 1x
 * speed and the tab must stay in the foreground.
 */

import { renderFrame, MediaFrameSource, sourceSecondsAt, clipLocalTicks } from '../engine/compositor.js';
import { scheduleProjectAudio, pendingAudioAssets } from '../audio/audiograph.js';
import { syncVideoElements } from '../audio/playback.js';
import { TICKS_PER_SECOND } from '../core/time.js';
import { acquireCanvas } from '../engine/layers.js';

export const CONTAINER_CANDIDATES = [
  { id: 'mp4-h264', mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: 'MP4 (H.264 + AAC)', ext: 'mp4' },
  { id: 'mp4-h264-high', mime: 'video/mp4;codecs=avc1.4D401F,mp4a.40.2', label: 'MP4 (H.264 High + AAC)', ext: 'mp4' },
  { id: 'webm-vp9', mime: 'video/webm;codecs=vp9,opus', label: 'WebM (VP9 + Opus)', ext: 'webm' },
  { id: 'webm-vp8', mime: 'video/webm;codecs=vp8,opus', label: 'WebM (VP8 + Opus)', ext: 'webm' },
  { id: 'webm', mime: 'video/webm', label: 'WebM (既定)', ext: 'webm' },
];

export function supportedContainers() {
  if (typeof MediaRecorder === 'undefined') return [];
  return CONTAINER_CANDIDATES.filter((c) => {
    try {
      return MediaRecorder.isTypeSupported(c.mime);
    } catch {
      return false;
    }
  });
}

export class Exporter {
  constructor(app) {
    this.app = app;
    this.running = false;
    this.cancelled = false;
  }

  /**
   * @param {object} opts
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {number} opts.fps
   * @param {string} opts.mime
   * @param {number} opts.bitrate
   * @param {{inTicks:number,outTicks:number}} opts.range
   * @param {(info:{progress:number,ticks:number,total:number,message?:string})=>void} opts.onProgress
   * @param {()=>void} opts.onDone
   * @param {(err:Error)=>void} opts.onError
   * @returns {Promise<{blob:Blob, filename:string, mime:string}|null>}
   */
  async export(opts) {
    if (this.running) throw new Error('すでに書き出し中です');
    if (typeof MediaRecorder === 'undefined') throw new Error('この環境は MediaRecorder に対応していません');
    const {
      width, height, fps, mime, bitrate, range, onProgress = () => {}, onDone = () => {}, onError = () => {},
    } = opts;

    const project = this.app.store.state;
    this.running = true;
    this.cancelled = false;

    const canvas = acquireCanvas(width, height, `export-${width}x${height}`);
    const ctx = canvas.getContext('2d');
    const source = new MediaFrameSource(this.app.mediaPool, { exact: false });
    const stopAll = [];

    // ---- audio graph ------------------------------------------------------
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new Ctx({ sampleRate: 48000 });
    const audioDest = audioCtx.createMediaStreamDestination();
    const master = audioCtx.createGain();
    master.gain.value = 1;
    master.connect(audioDest);

    let recorder = null;
    let stream = null;
    let chunks = [];
    let rafId = 0;
    let timerId = 0;

    const cleanup = async () => {
      this.running = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (timerId) clearInterval(timerId);
      for (const handle of stopAll) {
        try {
          handle.stop();
        } catch {
          /* ignore */
        }
      }
      this.app.mediaPool.releaseAllVideos();
      if (audioCtx.state !== 'closed') await audioCtx.close().catch(() => {});
      window.removeEventListener('visibilitychange', onVisibility);
    };

    const onVisibility = () => {
      if (document.hidden) {
        onProgress({ progress: 0, ticks: 0, total: 0, message: '警告: タブが非表示です。書き出し品質が低下する可能性があります' });
      }
    };
    window.addEventListener('visibilitychange', onVisibility);

    try {
      // ---- preflight -----------------------------------------------------
      onProgress({ progress: 0, ticks: 0, total: range.outTicks - range.inTicks, message: '素材を準備しています…' });
      const pending = pendingAudioAssets(project, this.app.mediaPool);
      for (const item of pending) {
        onProgress({ progress: 0, ticks: 0, total: 1, message: `音声をデコード中: ${item.name}` });
        // eslint-disable-next-line no-await-in-loop
        await this.app.mediaPool.getAudioBuffer(item.assetId);
      }
      await this.app.playback.primeVideos(project, range.inTicks, Math.max(2, (range.outTicks - range.inTicks) / TICKS_PER_SECOND));

      // ---- stream --------------------------------------------------------
      stream = canvas.captureStream(fps);
      const audioTrack = audioDest.stream.getAudioTracks()[0];
      if (audioTrack) stream.addTrack(audioTrack);

      const supported = supportedContainers();
      const chosen = mime && MediaRecorder.isTypeSupported(mime)
        ? (CONTAINER_CANDIDATES.find((c) => c.mime === mime) || { mime, ext: 'webm', label: mime })
        : supported[0] || { mime: '', ext: 'webm', label: 'default' };

      try {
        recorder = new MediaRecorder(stream, {
          ...(chosen.mime ? { mimeType: chosen.mime } : {}),
          videoBitsPerSecond: bitrate,
          audioBitsPerSecond: 192000,
        });
      } catch (err) {
        throw new Error(`MediaRecorder を初期化できません: ${err.message}`);
      }
      chunks = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) chunks.push(ev.data);
      };
      const recorded = new Promise((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = (ev) => reject(ev.error || new Error('録画エラー'));
      });

      // ---- run -----------------------------------------------------------
      await audioCtx.resume().catch(() => {});
      const startAt = audioCtx.currentTime + 0.25;
      const { handles } = scheduleProjectAudio(audioCtx, {
        project,
        destination: master,
        mediaPool: this.app.mediaPool,
        fromTicks: range.inTicks,
        toTicks: range.outTicks,
        timeOffset: startAt - audioCtx.currentTime,
      });
      stopAll.push(...handles);

      const totalTicks = range.outTicks - range.inTicks;
      const frameTicks = Math.round(TICKS_PER_SECOND / fps);
      let drawnFrames = 0;
      let lastDrawnTicks = -1;
      let finished = false;

      this.app.mediaPool.releaseAllVideos();
      syncVideoElements(this.app.mediaPool, project, range.inTicks, { playing: true, threshold: 0 });

      recorder.start(1000);

      const finish = () => {
        if (finished) return;
        finished = true;
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      };

      const renderLoop = async () => {
        if (!this.running) return;
        const nowTicks = range.inTicks + Math.round((audioCtx.currentTime - startAt) * TICKS_PER_SECOND);
        if (nowTicks < range.inTicks) {
          rafId = requestAnimationFrame(renderLoop);
          return;
        }
        if (this.cancelled) {
          finish();
          return;
        }
        if (nowTicks >= range.outTicks) {
          finish();
          return;
        }
        if (nowTicks - lastDrawnTicks >= frameTicks - 1) {
          const time = Math.min(nowTicks, range.outTicks - 1);
          syncVideoElements(this.app.mediaPool, project, time, { playing: true });
          // eslint-disable-next-line no-await-in-loop
          await renderFrame({ ctx, project, timeTicks: time, source, scale: width / project.settings.width });
          lastDrawnTicks = time;
          drawnFrames += 1;
          onProgress({
            progress: (time - range.inTicks) / totalTicks,
            ticks: time - range.inTicks,
            total: totalTicks,
            message: `${drawnFrames} フレーム描画済み`,
          });
        }
        rafId = requestAnimationFrame(renderLoop);
      };
      rafId = requestAnimationFrame(renderLoop);
      // Timer fallback keeps rendering even if rAF is throttled.
      timerId = setInterval(() => {
        if (!this.running) return;
        if (!document.hidden) return;
        if (!rafId) rafId = requestAnimationFrame(renderLoop);
      }, 500);

      await recorded;
      if (this.cancelled) {
        await cleanup();
        return null;
      }
      if (!chunks.length) throw new Error('録画データが空でした。ブラウザがこの形式に対応していない可能性があります。');

      const type = recorder.mimeType || chosen.mime || 'video/webm';
      const blob = new Blob(chunks, { type });
      onProgress({ progress: 1, ticks: totalTicks, total: totalTicks, message: '完了' });
      onDone();
      await cleanup();
      return { blob, filename: this.buildFilename(project.name, chosen.ext, type), mime: type };
    } catch (err) {
      await cleanup();
      onError(err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  cancel() {
    this.cancelled = true;
  }

  buildFilename(projectName, ext, mime) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const safe = String(projectName || 'qelvoryn').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const realExt = mime.includes('mp4') ? 'mp4' : (ext || 'webm');
    return `${safe}_${stamp}.${realExt}`;
  }
}

/** Suggest a bitrate from resolution/fps/quality. */
export function suggestBitrate(width, height, fps, quality = 'high') {
  const pixels = width * height;
  const base = pixels * fps * (quality === 'high' ? 0.11 : quality === 'medium' ? 0.07 : 0.04);
  return Math.round(Math.max(2e6, Math.min(60e6, base)));
}

/** Export a single frame as a PNG data URL (uses the shared compositor). */
export async function exportStill(mediaPool, project, timeTicks, scale = 1) {
  const width = Math.round(project.settings.width * scale);
  const height = Math.round(project.settings.height * scale);
  const canvas = acquireCanvas(width, height, `still-${width}x${height}`);
  const ctx = canvas.getContext('2d');
  const source = new MediaFrameSource(mediaPool, { exact: true });
  await renderFrame({ ctx, project, timeTicks, source, scale });
  return canvas.toDataURL('image/png');
}

export { sourceSecondsAt, clipLocalTicks };
