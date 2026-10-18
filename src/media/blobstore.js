/**
 * IndexedDB blob store for imported media.
 *
 * Keeps the raw bytes of every imported file so a project can be reopened
 * (autosave restore) without asking the user to pick the files again.
 * Falls back to an in-memory map when IndexedDB is unavailable.
 */

const DB_NAME = 'qelvoryn';
const DB_VERSION = 1;
const STORE_BLOBS = 'blobs';
const STORE_META = 'meta';
const STORE_PROJECTS = 'projects';

let dbPromise = null;
const memoryBlobs = new Map();
let usingMemory = false;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      usingMemory = true;
      resolve(null);
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      usingMemory = true;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      usingMemory = true;
      resolve(null);
    };
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const os = transaction.objectStore(store);
    let result;
    try {
      result = fn(os);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
  });
}

export const blobStore = {
  get usingMemory() {
    return usingMemory;
  },

  async putBlob(id, blob) {
    memoryBlobs.set(id, blob);
    const db = await openDB();
    if (!db) return;
    await tx(db, STORE_BLOBS, 'readwrite', (os) => os.put(blob, id));
  },

  async getBlob(id) {
    if (memoryBlobs.has(id)) return memoryBlobs.get(id);
    const db = await openDB();
    if (!db) return null;
    try {
      const blob = await tx(db, STORE_BLOBS, 'readonly', (os) => os.get(id));
      if (blob) memoryBlobs.set(id, blob);
      return blob || null;
    } catch {
      return null;
    }
  },

  async deleteBlob(id) {
    memoryBlobs.delete(id);
    const db = await openDB();
    if (!db) return;
    try {
      await tx(db, STORE_BLOBS, 'readwrite', (os) => os.delete(id));
    } catch {
      /* ignore */
    }
  },

  async listBlobIds() {
    const db = await openDB();
    if (!db) return [...memoryBlobs.keys()];
    try {
      const keys = await tx(db, STORE_BLOBS, 'readonly', (os) => os.getAllKeys());
      return keys || [];
    } catch {
      return [...memoryBlobs.keys()];
    }
  },

  async putProject(key, data) {
    const db = await openDB();
    if (!db) {
      memoryBlobs.set(`project:${key}`, data);
      return;
    }
    try {
      await tx(db, STORE_PROJECTS, 'readwrite', (os) => os.put(data, key));
    } catch (err) {
      console.warn('[Qelvoryn] project save failed', err);
    }
  },

  async getProject(key) {
    const db = await openDB();
    if (!db) return memoryBlobs.get(`project:${key}`) || null;
    try {
      return (await tx(db, STORE_PROJECTS, 'readonly', (os) => os.get(key))) || null;
    } catch {
      return null;
    }
  },

  async putMeta(key, value) {
    const db = await openDB();
    if (!db) {
      memoryBlobs.set(`meta:${key}`, value);
      return;
    }
    try {
      await tx(db, STORE_META, 'readwrite', (os) => os.put(value, key));
    } catch {
      /* ignore */
    }
  },

  async getMeta(key) {
    const db = await openDB();
    if (!db) return memoryBlobs.get(`meta:${key}`) ?? null;
    try {
      return (await tx(db, STORE_META, 'readonly', (os) => os.get(key))) ?? null;
    } catch {
      return null;
    }
  },

  async estimate() {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const { usage, quota } = await navigator.storage.estimate();
        return { usage, quota };
      } catch {
        /* ignore */
      }
    }
    return null;
  },
};
