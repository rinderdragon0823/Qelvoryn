/**
 * Project store: single source of truth + undo/redo.
 *
 * Every edit is expressed as a *path transaction*.  A transaction records a
 * deep snapshot of the smallest subtrees it is about to touch; on commit the
 * before/after snapshots become one undo entry.  Because snapshots are taken
 * per sub-tree (usually a single clip) this stays cheap even for big
 * projects, and because interactive gestures (drag, trim, scrub) call
 * begin()/commit() once around the whole gesture, one drag == one undo step.
 */

import { Emitter } from './events.js';
import { normalizeProject } from './model.js';

export function toPath(path) {
  if (Array.isArray(path)) return path;
  if (typeof path === 'number') return [path];
  return String(path)
    .split('.')
    .filter((p) => p !== '')
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

export function pathKey(path) {
  return path.join('\u0000');
}

export function getByPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function setByPath(obj, path, value) {
  if (!path.length) throw new Error('setByPath: empty path');
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = typeof path[i + 1] === 'number' ? [] : {};
    }
    cur = cur[key];
  }
  const last = path[path.length - 1];
  if (Array.isArray(cur) && typeof last === 'number') {
    if (last >= cur.length) cur.push(value);
    else cur[last] = value;
  } else {
    cur[last] = value;
  }
  return cur;
}

export function deepClone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON clone */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const key of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function isPrefix(short, long) {
  if (short.length > long.length) return false;
  for (let i = 0; i < short.length; i += 1) if (short[i] !== long[i]) return false;
  return true;
}

class Transaction {
  /**
   * @param {ProjectStore} store
   * @param {string} label
   */
  constructor(store, label) {
    this.store = store;
    this.label = label;
    this.snapshots = new Map(); // pathKey -> { path, before }
    this.open = true;
  }

  /** Register the smallest subtree that will be modified. */
  touch(path) {
    if (!this.open) throw new Error(`transaction "${this.label}" is closed`);
    const p = toPath(path);
    if (!p.length) return this;
    // Merge with ancestor/descendant touches: keep the shallowest unique set.
    const existing = [...this.snapshots.values()];
    for (const entry of existing) {
      if (isPrefix(entry.path, p)) return this; // ancestor already covers this
      if (isPrefix(p, entry.path)) this.snapshots.delete(pathKey(entry.path)); // replace descendant
    }
    const key = pathKey(p);
    if (!this.snapshots.has(key)) {
      this.snapshots.set(key, { path: p, before: deepClone(getByPath(this.store.state, p)) });
    }
    return this;
  }

  /** Convenience: touch several paths at once. */
  touchAll(paths) {
    for (const p of paths) this.touch(p);
    return this;
  }

  commit() {
    if (!this.open) return false;
    this.open = false;
    return this.store._commitTransaction(this);
  }

  abort() {
    if (!this.open) return;
    this.open = false;
    for (const entry of this.snapshots.values()) {
      setByPath(this.store.state, entry.path, deepClone(entry.before));
    }
    this.store._emitChange({ kind: 'abort', label: this.label, paths: [] });
  }
}

export class ProjectStore extends Emitter {
  constructor(project) {
    super();
    this.state = normalizeProject(project);
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 200;
    this.activeTransaction = null;
    this._txDepth = 0;
    this.revision = 0;
  }

  // ------------------------------------------------------------ reading ---

  get(path) {
    return getByPath(this.state, toPath(path));
  }

  track(trackId) {
    return this.state.tracks.find((t) => t.id === trackId) || null;
  }

  findClip(clipId) {
    for (let ti = 0; ti < this.state.tracks.length; ti += 1) {
      const clips = this.state.tracks[ti].clips;
      for (let ci = 0; ci < clips.length; ci += 1) {
        if (clips[ci].id === clipId) return { track: this.state.tracks[ti], trackIndex: ti, clip: clips[ci], clipIndex: ci };
      }
    }
    return null;
  }

  clipPath(clipId) {
    const found = this.findClip(clipId);
    return found ? ['tracks', found.trackIndex, 'clips', found.clipIndex] : null;
  }

  clipRef(clipId) {
    return this.findClip(clipId)?.clip || null;
  }

  // ------------------------------------------------------------ writing ---

  /**
   * Begin an explicit (interactive) transaction.  Nested transact() calls
   * participate in it instead of committing their own undo entry, so a whole
   * drag gesture collapses into exactly one undo step.
   */
  begin(label, opts = {}) {
    if (this.activeTransaction && this.activeTransaction.open) return this.activeTransaction;
    const tx = new Transaction(this, label);
    tx.interactive = !!opts.interactive;
    this.activeTransaction = tx;
    return tx;
  }

  touch(path) {
    if (this.activeTransaction?.open) this.activeTransaction.touch(path);
    return this;
  }

  /** Atomic edit helper. */
  transact(label, fn) {
    const active = this.activeTransaction;
    if (active && active.open) {
      // Participate in the enclosing transaction (no separate undo entry).
      return fn(active, this);
    }
    const tx = this.begin(label);
    try {
      const result = fn(tx, this);
      if (result && typeof result.then === 'function') {
        throw new Error('transact() callbacks must be synchronous');
      }
      this.activeTransaction = null;
      tx.commit();
      return result;
    } catch (err) {
      this.activeTransaction = null;
      if (tx.open) tx.abort();
      throw err;
    }
  }

  commit() {
    const tx = this.activeTransaction;
    if (!tx || !tx.open) return false;
    this.activeTransaction = null;
    return tx.commit();
  }

  abort() {
    const tx = this.activeTransaction;
    if (!tx || !tx.open) return;
    this.activeTransaction = null;
    tx.abort();
  }

  /** Safety net: commit a dangling interactive transaction. */
  ensureClosed() {
    const tx = this.activeTransaction;
    if (tx && tx.open) {
      console.warn(`[Qelvoryn] committing dangling transaction "${tx.label}"`);
      this.commit();
    }
  }

  /** Emit a change event without touching the undo stack (live drag preview). */
  notifyLive(label = 'live') {
    this._emitChange({ kind: 'live', label, paths: [] });
  }

  /** Change non-undoable view state (playhead, zoom, ...). */
  setView(path, value, opts = {}) {
    setByPath(this.state, toPath(path), value);
    if (opts.silent !== true) {
      this._emitChange({ kind: 'view', label: opts.label || 'view', paths: [toPath(path)] });
    }
  }

  _commitTransaction(tx) {
    const entries = [];
    for (const entry of tx.snapshots.values()) {
      const after = deepClone(getByPath(this.state, entry.path));
      if (!deepEqual(entry.before, after)) entries.push({ path: entry.path, before: entry.before, after });
    }
    if (!entries.length) {
      this._emitChange({ kind: 'noop', label: tx.label, paths: [] });
      return false;
    }
    this.pushHistory({ label: tx.label, entries });
    this.state.modifiedAt = Date.now();
    this.revision += 1;
    this._emitChange({ kind: 'tx', label: tx.label, paths: entries.map((e) => e.path) });
    return true;
  }

  pushHistory(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit('history', this.historyState());
  }

  historyState() {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label || '',
      redoLabel: this.redoStack.at(-1)?.label || '',
      depth: this.undoStack.length,
    };
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    for (let i = entry.entries.length - 1; i >= 0; i -= 1) {
      const e = entry.entries[i];
      setByPath(this.state, e.path, deepClone(e.before));
    }
    this.redoStack.push(entry);
    this.revision += 1;
    this.state.modifiedAt = Date.now();
    this.emit('history', this.historyState());
    this._emitChange({ kind: 'undo', label: entry.label, paths: entry.entries.map((e) => e.path) });
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    for (const e of entry.entries) {
      setByPath(this.state, e.path, deepClone(e.after));
    }
    this.undoStack.push(entry);
    this.revision += 1;
    this.state.modifiedAt = Date.now();
    this.emit('history', this.historyState());
    this._emitChange({ kind: 'redo', label: entry.label, paths: entry.entries.map((e) => e.path) });
    return true;
  }

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit('history', this.historyState());
  }

  /** Replace the whole project (load / new). */
  load(project, opts = {}) {
    this.state = normalizeProject(project);
    this.clearHistory();
    this.revision += 1;
    this._emitChange({ kind: 'load', label: opts.label || 'load', paths: [] });
    return this.state;
  }

  _emitChange(evt) {
    this.emit('change', { ...evt, revision: this.revision, state: this.state });
  }
}
