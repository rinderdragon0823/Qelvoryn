/** Minimal typed event emitter used across the app. */
export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  /** @param {string} event */
  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this._handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[Qelvoryn] listener error for "${event}"`, err);
      }
    }
  }
}
