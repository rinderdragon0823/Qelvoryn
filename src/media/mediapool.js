/**
 * Media pool: imports files, decodes them, and hands out the runtime objects
 * (video elements, images, audio buffers, waveform peaks) that the compositor
 * and the audio engine consume.
 *
 * Asset *metadata* is part of the project (serialised); the bytes live in
 * IndexedDB so a reopened project can relink itself without user input.
 */

import { Emitter } from '../core/events.js';
import { createAsset, uid } from '../core/model.js';
import { secondsToTicks, ticksToSeconds } from '../core/time.js';
import { blobStore } from './blobstore.js';
import { computePeaks } from './waveform.js';

const AUDIO_DECODE_LIMIT_BYTES = 512 * 1024 * 1024;
const PREVIEW_AUDIO_SAMPLE_RATE = 48000;

function detectKind(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(name)) return 'image';
  if (type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/.test(name)) return 'audio';
  return 'video';
}

function once(el, event, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
      clearTimeout(timer);
    };
    const onOk = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(el);
    };
    const onErr = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`${event} failed`));
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`${event} timed out`));
    }, timeoutMs);
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
  });
}

export class MediaPool extends Emitter {
  /** @param {import('../core/store.js').ProjectStore} store */
  constructor(store) {
    super();
    this.store = store;
    this.urls = new Map(); // assetId -> objectURL
    this.blobs = new Map();
    this.images = new Map();
    this.audioBuffers = new Map();
    this.peaks = new Map();
    this.videoElements = new Map(); // `${assetId}::${owner}` -> video
    this.pendingAudio = new Map();
    this.decodeContext = null;
  }

  get audioDecodeContext() {
    if (!this.decodeContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.decodeContext = new Ctx({ sampleRate: PREVIEW_AUDIO_SAMPLE_RATE });
    }
    if (this.decodeContext.state === 'suspended') this.decodeContext.resume().catch(() => {});
    return this.decodeContext;
  }

  // ------------------------------------------------------------- importing --

  /**
   * Import File objects. Returns the created asset ids (already registered in
   * the project). Probing happens in parallel but metadata is committed as it
   * becomes available.
   * @param {File[]|FileList} files
   */
  async importFiles(files, opts = {}) {
    const list = [...files];
    const ids = [];
    for (const file of list) {
      const kind = detectKind(file);
      const asset = createAsset({
        name: file.name.replace(/\.[^.]+$/, '') || file.name,
        sourceName: file.name,
        kind,
        mimeType: file.type,
        size: file.size,
        status: 'probing',
      });
      await blobStore.putBlob(asset.id, file);
      this.blobs.set(asset.id, file);
      this.store.transact(`素材を追加: ${asset.name}`, () => {
        this.store.touch(['assets']);
        this.store.touch(['assetOrder']);
        this.store.state.assets[asset.id] = asset;
        this.store.state.assetOrder.push(asset.id);
      });
      ids.push(asset.id);
      this.probe(asset.id, file, opts).catch((err) => {
        console.warn('[Qelvoryn] probe failed', err);
        this.updateAsset(asset.id, { status: 'error', probeError: String(err?.message || err) });
      });
    }
    return ids;
  }

  /** Re-attach a blob that came from IndexedDB (project restore). */
  async restoreAsset(assetId, blob) {
    this.blobs.set(assetId, blob);
    this.emit('asset-ready', { assetId });
    if (this.pendingAudio.has(assetId)) return;
  }

  async probe(assetId, file, opts = {}) {
    const asset = this.store.state.assets[assetId];
    if (!asset) return;
    if (asset.kind === 'image') {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await once(img, 'load', 30000).catch(() => null);
      this.updateAsset(assetId, {
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
        hasVideo: true,
        hasAudio: false,
        status: 'ready',
        durationTicks: secondsToTicks(opts.defaultImageSeconds ?? 5),
      });
      return;
    }

    if (asset.kind === 'audio') {
      const buffer = await this.decodeAudioFromFile(file).catch(() => null);
      if (!buffer) {
        this.updateAsset(assetId, { status: 'error' });
        return;
      }
      this.audioBuffers.set(assetId, buffer);
      this.updateAsset(assetId, {
        durationTicks: secondsToTicks(buffer.duration),
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        hasAudio: true,
        hasVideo: false,
        status: 'ready',
      });
      this.emit('asset-ready', { assetId });
      return;
    }

    // video
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = url;
    video.crossOrigin = 'anonymous';
    let ok = false;
    try {
      await once(video, 'loadedmetadata', 30000);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok || !Number.isFinite(video.duration)) {
      this.updateAsset(assetId, { status: 'error' });
      return;
    }
    const durationTicks = secondsToTicks(video.duration);
    this.updateAsset(assetId, {
      durationTicks,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      hasVideo: true,
      status: 'ready',
    });
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    this.emit('asset-ready', { assetId });

    // Audio detection + waveform data, done lazily in the background.
    if (file.size <= AUDIO_DECODE_LIMIT_BYTES) {
      this.getAudioBuffer(assetId).catch(() => {});
    }
  }

  async decodeAudioFromFile(file) {
    const ctx = this.audioDecodeContext;
    const arrayBuffer = await file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const promise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (promise && typeof promise.then === 'function') promise.catch(reject);
    });
  }

  updateAsset(assetId, patch) {
    if (!this.store.state.assets[assetId]) return;
    this.store.transact(`素材情報を更新: ${this.store.state.assets[assetId].name}`, () => {
      this.store.touch(['assets', assetId]);
      Object.assign(this.store.state.assets[assetId], patch);
    });
    this.emit('asset-updated', { assetId, patch });
  }

  // ---------------------------------------------------------------- access --

  getAsset(assetId) {
    return this.store.state.assets[assetId] || null;
  }

  /** Remove an asset (and its bytes) from the project. */
  async removeAsset(assetId) {
    await blobStore.deleteBlob(assetId);
    this.blobs.delete(assetId);
    const url = this.urls.get(assetId);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(assetId);
    this.images.delete(assetId);
    this.audioBuffers.delete(assetId);
    this.peaks.delete(assetId);
    this.releaseAssetVideos(assetId);
    this.store.transact('素材を削除', () => {
      this.store.touch(['assets', assetId]);
      this.store.touch(['assetOrder']);
      delete this.store.state.assets[assetId];
      this.store.state.assetOrder = this.store.state.assetOrder.filter((id) => id !== assetId);
    });
  }

  async getBlob(assetId) {
    if (this.blobs.has(assetId)) return this.blobs.get(assetId);
    const blob = await blobStore.getBlob(assetId);
    if (blob) {
      this.blobs.set(assetId, blob);
      this.emit('asset-ready', { assetId });
    }
    return blob;
  }

  async getURL(assetId) {
    if (this.urls.has(assetId)) return this.urls.get(assetId);
    const blob = await this.getBlob(assetId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(assetId, url);
    return url;
  }

  async getImage(assetId) {
    if (this.images.has(assetId)) return this.images.get(assetId);
    const url = await this.getURL(assetId);
    if (!url) return null;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await once(img, 'load', 30000);
      if (img.decode) await img.decode().catch(() => {});
    } catch {
      return null;
    }
    this.images.set(assetId, img);
    return img;
  }

  async getAudioBuffer(assetId) {
    if (this.audioBuffers.has(assetId)) return this.audioBuffers.get(assetId);
    if (this.pendingAudio.has(assetId)) return this.pendingAudio.get(assetId);
    const promise = (async () => {
      const asset = this.getAsset(assetId);
      if (!asset) return null;
      const blob = await this.getBlob(assetId);
      if (!blob) return null;
      if (blob.size > AUDIO_DECODE_LIMIT_BYTES) {
        console.warn('[Qelvoryn] audio decode skipped (file too large)', asset.name);
        this.pendingAudio.delete(assetId);
        return null;
      }
      try {
        const buffer = await this.decodeAudioFromFile(blob);
        this.audioBuffers.set(assetId, buffer);
        if (!asset.hasAudio) {
          this.store.transact('音声トラックを検出', () => {
            this.store.touch(['assets', assetId]);
            Object.assign(this.store.state.assets[assetId], {
              hasAudio: true,
              sampleRate: buffer.sampleRate,
              channels: buffer.numberOfChannels,
              durationTicks: this.store.state.assets[assetId].durationTicks || secondsToTicks(buffer.duration),
            });
          });
          this.emit('asset-updated', { assetId });
        }
        return buffer;
      } catch {
        this.updateAsset(assetId, { hasAudio: false });
        return null;
      } finally {
        this.pendingAudio.delete(assetId);
      }
    })();
    this.pendingAudio.set(assetId, promise);
    return promise;
  }

  async getPeaks(assetId) {
    if (this.peaks.has(assetId)) return this.peaks.get(assetId);
    const buffer = await this.getAudioBuffer(assetId);
    if (!buffer) return null;
    const peaks = computePeaks(buffer);
    this.peaks.set(assetId, peaks);
    this.emit('peaks-ready', { assetId });
    return peaks;
  }

  hasPeaks(assetId) {
    return this.peaks.get(assetId) || null;
  }

  // --------------------------------------------------------- video elements --

  /** A dedicated <video> for (asset, owner) - owner is usually the clip id. */
  videoFor(assetId, ownerKey = 'default') {
    const key = `${assetId}::${ownerKey}`;
    if (this.videoElements.has(key)) return this.videoElements.get(key);
    const el = document.createElement('video');
    el.preload = 'auto';
    el.muted = true;
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.dataset.assetId = assetId;
    this.videoElements.set(key, el);
    this.getURL(assetId).then((url) => {
      if (url && !el.src) el.src = url;
    });
    return el;
  }

  releaseVideo(assetId, ownerKey = 'default') {
    const key = `${assetId}::${ownerKey}`;
    const el = this.videoElements.get(key);
    if (!el) return;
    try {
      el.pause();
    } catch {
      /* ignore */
    }
    this.videoElements.delete(key);
  }

  releaseAssetVideos(assetId) {
    for (const key of [...this.videoElements.keys()]) {
      if (key.startsWith(`${assetId}::`)) this.releaseVideo(assetId, key.split('::')[1]);
    }
  }

  releaseAllVideos() {
    for (const [key, el] of this.videoElements) {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      this.videoElements.delete(key);
    }
  }

  async ensureVideoReady(el, timeoutMs = 15000) {
    if (!el) return false;
    if (!el.src) {
      const assetId = el.dataset.assetId;
      const url = await this.getURL(assetId);
      if (!url) return false;
      el.src = url;
    }
    if (el.readyState >= 2) return true;
    try {
      await once(el, 'loadeddata', timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Deterministically move a video element to a timestamp (seconds). */
  async seekVideo(el, seconds, timeoutMs = 4000) {
    if (!el) return false;
    const ready = await this.ensureVideoReady(el);
    if (!ready) return false;
    const duration = Number.isFinite(el.duration) ? el.duration : seconds;
    const target = Math.min(Math.max(seconds, 0), Math.max(0, duration - 1 / 1000));
    if (el.readyState >= 2 && Math.abs(el.currentTime - target) < 0.002) return true;
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        el.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        resolve(value);
      };
      const onSeeked = () => finish(true);
      el.addEventListener('seeked', onSeeked);
      const timer = setTimeout(() => finish(true), timeoutMs);
      try {
        el.currentTime = target;
      } catch {
        finish(false);
      }
    });
  }

  /** Best-effort relink: match a missing asset against newly picked files. */
  async relinkAssets(files) {
    const list = [...files];
    const missing = Object.values(this.store.state.assets).filter((a) => !this.blobs.has(a.id));
    const used = new Set();
    const matched = [];
    for (const asset of missing) {
      let file = list.find((f) => !used.has(f) && f.name === asset.sourceName);
      if (!file) file = list.find((f) => !used.has(f) && f.name.replace(/\.[^.]+$/, '') === asset.name);
      if (!file) continue;
      used.add(file);
      await blobStore.putBlob(asset.id, file);
      this.blobs.set(asset.id, file);
      matched.push(asset.id);
      this.emit('asset-ready', { assetId: asset.id });
    }
    return matched;
  }

  tickToSourceSeconds(ticks) {
    return ticksToSeconds(ticks);
  }

  dispose() {
    this.releaseAllVideos();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.images.clear();
    this.audioBuffers.clear();
    this.peaks.clear();
    if (this.decodeContext) {
      this.decodeContext.close().catch(() => {});
      this.decodeContext = null;
    }
  }
}

export { uid };
