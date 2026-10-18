/**
 * Persistence: autosave / restore / project files.
 *
 * The project document (JSON) and the media blobs both live in IndexedDB, so
 * a reload - or a browser restart - brings back the exact same session,
 * including unsaved footage.  Project files are plain JSON: they reference
 * assets by id, and the user is asked to re-link the media files when the
 * project moves to another machine (nothing is uploaded anywhere).
 */

import { blobStore } from '../media/blobstore.js';

const AUTOSAVE_KEY = 'autosave';
const SESSION_KEY = 'session';
export const PROJECT_FILE_FORMAT = 'qelvoryn-project';
export const PROJECT_FILE_VERSION = 1;

export class Persistence {
  constructor(app) {
    this.app = app;
    this.timer = 0;
    this.lastSavedAt = 0;
    this.lastError = null;
    this.busy = false;
    this.enabled = true;
    this.autosaveDelay = 1500;
  }

  start() {
    this.app.store.on('change', (ev) => {
      if (ev?.kind === 'view') return; // playhead moves are not worth a save
      this.schedule();
    });
  }

  schedule(delay = this.autosaveDelay) {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.saveNow().catch((err) => {
        this.lastError = err;
        console.warn('[Qelvoryn] autosave failed', err);
      });
    }, delay);
  }

  async saveNow() {
    if (this.busy) {
      this.schedule(400);
      return false;
    }
    this.busy = true;
    try {
      const project = this.app.store.state;
      project.modifiedAt = Date.now();
      const session = this.app.serializeSession ? this.app.serializeSession() : null;
      const payload = {
        version: PROJECT_FILE_VERSION,
        savedAt: Date.now(),
        name: project.name,
        project: project,
        session,
      };
      await blobStore.putProject(AUTOSAVE_KEY, payload);
      await blobStore.putMeta(SESSION_KEY, { savedAt: payload.savedAt, name: project.name });
      this.lastSavedAt = payload.savedAt;
      this.app.emit?.('autosaved', { at: this.lastSavedAt });
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** @returns {Promise<{project:object, session:object|null, savedAt:number}|null>} */
  async restore() {
    const data = await blobStore.getProject(AUTOSAVE_KEY);
    if (!data || !data.project) return null;
    // Re-attach every media blob that is still in IndexedDB.
    const ids = Object.keys(data.project.assets || {});
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const blob = await blobStore.getBlob(id);
      if (blob) {
        // eslint-disable-next-line no-await-in-loop
        await this.app.mediaPool.restoreAsset(id, blob);
      }
    }
    return data;
  }

  async clear() {
    await blobStore.putProject(AUTOSAVE_KEY, null);
    await blobStore.putMeta(SESSION_KEY, null);
    this.lastSavedAt = 0;
  }

  /** Remove blobs that no longer belong to any asset of the project. */
  async pruneOrphanBlobs() {
    const known = new Set(Object.keys(this.app.store.state.assets || {}));
    const ids = await blobStore.listBlobIds();
    let removed = 0;
    for (const id of ids) {
      if (known.has(id)) continue;
      // eslint-disable-next-line no-await-in-loop
      await blobStore.deleteBlob(id);
      removed += 1;
    }
    return removed;
  }

  async usage() {
    try {
      return await blobStore.estimate();
    } catch {
      return { usage: 0, quota: 0 };
    }
  }

  // --------------------------------------------------------- project files --

  buildProjectFile() {
    const project = this.app.store.state;
    return JSON.stringify({
      format: PROJECT_FILE_FORMAT,
      version: PROJECT_FILE_VERSION,
      exportedAt: new Date().toISOString(),
      app: 'Qelvoryn',
      project,
    }, null, 2);
  }

  exportProjectFile() {
    const name = (this.app.store.state.name || 'qelvoryn').replace(/[\\/:*?"<>|]/g, '_');
    const blob = new Blob([this.buildProjectFile()], { type: 'application/json' });
    Persistence.download(`${name}.qelvoryn.json`, blob);
  }

  /**
   * @param {File} file
   * @returns {Promise<{project:object, missingAssets:string[]}>}
   */
  async parseProjectFile(file) {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('JSON として読み込めませんでした');
    }
    const project = data.project || data;
    if (!project || !Array.isArray(project.tracks)) throw new Error('Qelvoryn のプロジェクトファイルではありません');
    const missingAssets = [];
    for (const [id, asset] of Object.entries(project.assets || {})) {
      // eslint-disable-next-line no-await-in-loop
      const blob = await blobStore.getBlob(id);
      if (!blob) missingAssets.push(asset.name || id);
    }
    return { project, missingAssets };
  }

  static download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  static downloadDataURL(filename, dataUrl) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
