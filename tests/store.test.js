import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore, toPath, getByPath, setByPath, deepClone, deepEqual } from '../src/core/store.js';
import { createProject, createTrack, createClip } from '../src/core/model.js';

function makeStore() {
  const project = createProject({ name: 'store test' });
  const track = createTrack('video', { name: 'V1' });
  project.tracks.push(track);
  const store = new ProjectStore(project);
  return { store, track };
}

test('path helpers', () => {
  assert.deepEqual(toPath('tracks.0.clips.2'), ['tracks', 0, 'clips', 2]);
  assert.deepEqual(toPath(['a', 1]), ['a', 1]);
  assert.deepEqual(toPath(3), [3]);
  const obj = { a: { b: [1, 2] } };
  assert.equal(getByPath(obj, ['a', 'b', 1]), 2);
  setByPath(obj, ['a', 'b', 1], 9);
  assert.equal(obj.a.b[1], 9);
  assert.deepEqual(deepClone({ a: [1] }), { a: [1] });
  assert.ok(deepEqual({ a: 1 }, { a: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 2 }));
});

test('transaction commits one undo entry and restores state', () => {
  const { store, track } = makeStore();
  const changes = [];
  store.on('change', (ev) => changes.push(ev.kind));

  store.transact('クリップを追加', () => {
    store.touch(['tracks', 0, 'clips']);
    track.clips.push(createClip('video', { startTicks: 0, durationTicks: 1000 }));
  });

  assert.equal(track.clips.length, 1);
  assert.equal(store.undoStack.length, 1);
  assert.equal(changes.at(-1), 'tx');

  assert.ok(store.undo());
  assert.equal(store.state.tracks[0].clips.length, 0);
  assert.equal(store.redoStack.length, 1);

  assert.ok(store.redo());
  assert.equal(store.state.tracks[0].clips.length, 1);
});

test('nested transact calls collapse into a single undo step', () => {
  const { store, track } = makeStore();
  store.transact('まとめて編集', () => {
    store.transact('inner 1', () => {
      store.touch(['tracks', 0, 'clips']);
      track.clips.push(createClip('video', { durationTicks: 1000 }));
    });
    store.transact('inner 2', () => {
      store.touch(['tracks', 0, 'clips']);
      track.clips.push(createClip('video', { startTicks: 2000, durationTicks: 1000 }));
    });
  });
  assert.equal(track.clips.length, 2);
  assert.equal(store.undoStack.length, 1);
  store.undo();
  assert.equal(store.state.tracks[0].clips.length, 0);
});

test('no-op transaction does not pollute the history', () => {
  const { store } = makeStore();
  const kinds = [];
  store.on('change', (ev) => kinds.push(ev.kind));
  store.transact('何もしない', () => {});
  assert.equal(store.undoStack.length, 0);
  assert.equal(kinds.at(-1), 'noop');
});

test('abort restores the original data', () => {
  const { store, track } = makeStore();
  store.transact('中止する編集', () => {
    store.touch(['tracks', 0, 'clips']);
    track.clips.push(createClip('video', {}));
  });
  store.transact('失敗する編集', (tx) => {
    store.touch(['tracks', 0, 'clips']);
    track.clips.push(createClip('video', { startTicks: 5000 }));
    tx.abort();
  });
  assert.equal(store.state.tracks[0].clips.length, 1, 'aborted change is rolled back');
  assert.equal(store.undoStack.length, 1);
});

test('one interactive gesture is one undo step', () => {
  const { store, track } = makeStore();
  const clip = createClip('video', { startTicks: 0, durationTicks: 1000 });
  track.clips.push(clip);

  const tx = store.begin('ドラッグ', { interactive: true });
  for (let i = 1; i <= 10; i += 1) {
    tx.touch(['tracks', 0, 'clips', 0]);
    clip.startTicks = i * 100;
    store.notifyLive('move');
  }
  store.commit();

  assert.equal(store.undoStack.length, 1);
  assert.equal(clip.startTicks, 1000);
  store.undo();
  assert.equal(store.state.tracks[0].clips[0].startTicks, 0);
});

test('a throwing callback aborts the transaction and rethrows', () => {
  const { store, track } = makeStore();
  assert.throws(() => {
    store.transact('爆発', () => {
      store.touch(['tracks', 0, 'clips']);
      track.clips.push(createClip('video', {}));
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(store.state.tracks[0].clips.length, 0);
  assert.equal(store.undoStack.length, 0);
  assert.equal(store.activeTransaction, null, 'no dangling transaction');
});

test('setView is not undoable', () => {
  const { store } = makeStore();
  store.setView('settings.fps', 24);
  assert.equal(store.state.settings.fps, 24);
  assert.equal(store.undoStack.length, 0);
});

test('load replaces state and clears history', () => {
  const { store, track } = makeStore();
  store.transact('edit', () => {
    store.touch(['tracks', 0, 'clips']);
    track.clips.push(createClip('video', {}));
  });
  assert.equal(store.undoStack.length, 1);
  store.load(createProject({ name: 'new' }), {});
  assert.equal(store.state.name, 'new');
  assert.equal(store.undoStack.length, 0);
});

test('history is bounded by maxHistory', () => {
  const { store, track } = makeStore();
  store.maxHistory = 5;
  for (let i = 0; i < 12; i += 1) {
    store.transact(`編集 ${i}`, () => {
      store.touch(['tracks', 0, 'clips']);
      track.clips.push(createClip('video', { startTicks: i * 1000 }));
    });
  }
  assert.equal(store.undoStack.length, 5);
  assert.equal(store.undoStack.at(-1).label, '編集 11');
});

test('touch keeps the shallowest subtree only', () => {
  const { store } = makeStore();
  const t = store.begin('paths');
  t.touch(['tracks', 0, 'clips', 0, 'transform']);
  t.touch(['tracks', 0, 'clips']);
  assert.equal(t.snapshots.size, 1, 'descendant touch is subsumed by the ancestor');
  t.abort();
});
