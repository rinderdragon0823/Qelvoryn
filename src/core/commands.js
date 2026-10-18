/**
 * Qelvoryn editing commands.
 *
 * Every user-facing edit (move / trim / split / delete / duplicate / effect
 * ordering / keyframe editing / track management) is implemented here as a
 * transaction on the project store, which gives Undo/Redo and autosave for
 * free.  Commands are also used by the auto-director and by tests.
 */

import {
  uid, createTrack, canTrackAcceptClip, tracksAcceptingKind, clipEnd, TRACK_KINDS, createEffect,
} from './model.js';
import {
  addKeyframe, removeKeyframe, moveKeyframe, setKeyframeInterp, clearKeyframes,
  getKeyframeList, isAnimated, evaluateParam, getStaticValue, setStaticValue, pruneOrphanKeyframes,
} from './keyframes.js';
import { getEffectDef, defaultEffectParams, effectsForClipType } from '../engine/effectdefs.js';

export const DEFAULT_TRANSITION = 0;

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function clipsById(store, ids) {
  const wanted = new Set(ids);
  const out = [];
  const tracks = store.state.tracks;
  for (let ti = 0; ti < tracks.length; ti += 1) {
    const clips = tracks[ti].clips;
    for (let ci = 0; ci < clips.length; ci += 1) {
      if (wanted.has(clips[ci].id)) out.push({ track: tracks[ti], trackIndex: ti, clip: clips[ci], clipIndex: ci });
    }
  }
  return out;
}

export function selectedClips(store, selection) {
  return clipsById(store, selection || []);
}

function trackPath(store, trackId) {
  const index = store.state.tracks.findIndex((t) => t.id === trackId);
  return index < 0 ? null : ['tracks', index];
}

function clipPathOf(store, clipId) {
  return store.clipPath(clipId);
}

function sortClipsByStart(track) {
  track.clips.sort((a, b) => a.startTicks - b.startTicks);
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/**
 * Collect snap targets: clip edges, markers, the playhead, and the origin.
 * @returns {{ticks:number, kind:string, label?:string}[]}
 */
export function snapCandidates(project, { excludeClipIds = [], playheadTicks = null } = {}) {
  const exclude = new Set(excludeClipIds);
  const out = [{ ticks: 0, kind: 'origin' }];
  if (playheadTicks != null) out.push({ ticks: Math.round(playheadTicks), kind: 'playhead' });
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (exclude.has(clip.id)) continue;
      out.push({ ticks: clip.startTicks, kind: 'clip', label: clip.name });
      out.push({ ticks: clip.startTicks + clip.durationTicks, kind: 'clip', label: clip.name });
    }
  }
  for (const marker of project.markers || []) out.push({ ticks: marker.tick, kind: 'marker', label: marker.name });
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      for (const key of Object.keys(clip.keyframes || {})) {
        if (exclude.has(clip.id)) continue;
        for (const kf of clip.keyframes[key]) {
          out.push({ ticks: clip.startTicks + Math.round(kf.t / (clip.speed || 1)), kind: 'keyframe' });
        }
      }
    }
  }
  return out;
}

/**
 * Snap a value to the nearest candidate within the threshold.
 * @returns {{ticks:number, snapped:boolean, target:object|null}}
 */
export function snapTime(project, ticks, opts = {}) {
  const { enabled = true, thresholdTicks = 2400, excludeClipIds = [], playheadTicks = null } = opts;
  const value = Math.round(ticks);
  if (!enabled) return { ticks: value, snapped: false, target: null };
  let best = null;
  let bestDist = thresholdTicks;
  for (const candidate of snapCandidates(project, { excludeClipIds, playheadTicks })) {
    const dist = Math.abs(candidate.ticks - value);
    if (dist <= bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  if (!best) return { ticks: value, snapped: false, target: null };
  return { ticks: best.ticks, snapped: true, target: best };
}

// ---------------------------------------------------------------------------
// Placement / overlap policy
// ---------------------------------------------------------------------------

/**
 * Clamp a clip so it does not overlap its neighbours on the track.
 * Returns the adjusted start (clips cannot pass through each other).
 */
export function clampStartOnTrack(track, clip, desiredStart, ignoreIds = new Set()) {
  const duration = clip.durationTicks;
  let min = 0;
  let max = Infinity;
  for (const other of track.clips) {
    if (other.id === clip.id || ignoreIds.has(other.id)) continue;
    const oEnd = other.startTicks + other.durationTicks;
    if (oEnd <= clip.startTicks) min = Math.max(min, oEnd);
    else if (other.startTicks >= clip.startTicks + duration) max = Math.min(max, other.startTicks - duration);
  }
  if (max < min) return clip.startTicks;
  return Math.min(Math.max(desiredStart, min), max);
}

/** First free start position at or after `start` that fits `duration`. */
export function findFreeSlot(track, start, duration, ignoreIds = new Set()) {
  const sorted = track.clips
    .filter((c) => !ignoreIds.has(c.id))
    .sort((a, b) => a.startTicks - b.startTicks);
  let candidate = Math.max(0, Math.round(start));
  for (const clip of sorted) {
    const end = clip.startTicks + clip.durationTicks;
    if (candidate < clip.startTicks && candidate + duration <= clip.startTicks) return candidate;
    if (candidate >= clip.startTicks && candidate < end) candidate = end;
  }
  return candidate;
}

/** Insert a clip into a track, resolving overlaps by pushing to the next gap. */
export function insertClip(store, trackId, clip, opts = {}) {
  const label = opts.label || 'クリップを追加';
  let inserted = null;
  store.transact(label, () => {
    const idx = store.state.tracks.findIndex((t) => t.id === trackId);
    if (idx < 0) return;
    const track = store.state.tracks[idx];
    if (!canTrackAcceptClip(track, clip.type) && !opts.force) {
      throw new Error(`${clip.type} クリップは ${track.name} に配置できません`);
    }
    store.touch(['tracks', idx, 'clips']);
    const start = opts.resolveOverlap === false
      ? Math.max(0, clip.startTicks)
      : findFreeSlot(track, clip.startTicks, clip.durationTicks);
    clip.trackId = trackId;
    clip.startTicks = Math.max(0, Math.round(start));
    track.clips.push(clip);
    sortClipsByStart(track);
    inserted = clip;
  });
  return inserted;
}

/** True when no clip (except `ignoreIds`) occupies [start, start + duration). */
export function trackRangeFree(track, start, duration, ignoreIds = new Set()) {
  const from = Math.max(0, Math.round(start));
  const to = from + Math.max(1, Math.round(duration));
  for (const clip of track.clips) {
    if (ignoreIds.has(clip.id)) continue;
    const end = clip.startTicks + clip.durationTicks;
    if (from < end && clip.startTicks < to) return false;
  }
  return true;
}

/**
 * Choose the track that should receive a new clip (multi-track spill UX):
 * the preferred track when it accepts the type and is free at that spot,
 * then the first free track of the primary kind, then any free compatible
 * track.  Returns null when a new track must be created.
 */
export function findTrackForClip(project, clipType, { ticks = 0, durationTicks = 0, preferredIndex = -1 } = {}) {
  const tracks = project.tracks;
  const preferred = preferredIndex >= 0 ? tracks[preferredIndex] : null;
  const free = (track) => Boolean(track) && trackRangeFree(track, ticks, durationTicks);
  if (preferred && canTrackAcceptClip(preferred, clipType) && free(preferred)) return preferred;
  return tracksAcceptingKind(project, clipType).find(free) || null;
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------
/**
 * Compute how far a group of clips may travel without crossing neighbours.
 * @param {Array<{clipId:string, track:object, startTicks:number, durationTicks:number}>} moves
 */
export function computeMoveConstraints(moves) {
  const movingIds = new Set(moves.map((m) => m.clipId));
  let minDelta = -Infinity;
  let maxDelta = Infinity;
  for (const move of moves) {
    const track = move.track;
    let leftBound = 0;
    let rightBound = Infinity;
    for (const other of track.clips) {
      if (movingIds.has(other.id)) continue;
      const oEnd = other.startTicks + other.durationTicks;
      if (oEnd <= move.startTicks) leftBound = Math.max(leftBound, oEnd);
      if (other.startTicks >= move.startTicks + move.durationTicks) rightBound = Math.min(rightBound, other.startTicks);
    }
    minDelta = Math.max(minDelta, leftBound - move.startTicks);
    maxDelta = Math.min(maxDelta, rightBound - (move.startTicks + move.durationTicks));
  }
  if (maxDelta < minDelta) {
    const clamped = Math.max(0, Math.min(maxDelta, minDelta));
    minDelta = Math.min(minDelta, clamped);
    maxDelta = Math.max(maxDelta, clamped);
  }
  return { minDelta, maxDelta };
}

/**
 * Move clips by a delta on the timeline (used live during a drag).
 * `plan` = [{clipId, trackId}] describing the destination track of each clip.
 */
export function applyMove(store, plan, deltaTicks, opts = {}) {
  const state = store.state;
  const byId = new Map(plan.map((p) => [p.clipId, p]));
  const allIds = plan.map((p) => p.clipId).join('|');
  for (const entry of clipsById(store, plan.map((p) => p.clipId))) {
    const target = byId.get(entry.clip.id);
    const targetTrackIndex = state.tracks.findIndex((t) => t.id === target.trackId);
    if (targetTrackIndex < 0) continue;
    const targetTrack = state.tracks[targetTrackIndex];
    const sameTrack = targetTrack.id === entry.track.id;
    if (!sameTrack) {
      // Cross-track move: validate compatibility then relocate.
      if (!canTrackAcceptClip(targetTrack, entry.clip.type)) continue;
      store.touch(['tracks', entry.trackIndex, 'clips']);
      store.touch(['tracks', targetTrackIndex, 'clips']);
      const duration = entry.clip.durationTicks;
      const desired = Math.max(0, entry.clip.startTicks + deltaTicks);
      const start = opts.noClamp ? desired : findFreeSlot(targetTrack, desired, duration, new Set(plan.map((p) => p.clipId)));
      entry.clip.startTicks = start;
      entry.clip.trackId = targetTrack.id;
      entry.track.clips.splice(entry.clipIndex, 1);
      targetTrack.clips.push(entry.clip);
      sortClipsByStart(targetTrack);
      sortClipsByStart(entry.track);
    } else {
      store.touch(['tracks', entry.trackIndex, 'clips', entry.clipIndex]);
      entry.clip.startTicks = Math.max(0, Math.round(entry.clip.startTicks + deltaTicks));
    }
  }
  void allIds;
}

/** Move clips so that the left-most selected clip lands on `anchorTicks`. */
export function moveSelectionTo(store, plan, anchorTicks, opts = {}) {
  const entries = clipsById(store, plan.map((p) => p.clipId));
  if (!entries.length) return;
  const first = entries.reduce((min, e) => Math.min(min, e.clip.startTicks), Infinity);
  const delta = Math.round(anchorTicks) - first;
  const moves = entries.map((e) => ({
    clipId: e.clip.id,
    track: plan.find((p) => p.clipId === e.clip.id)?.track
      || store.state.tracks.find((t) => t.id === (plan.find((p) => p.clipId === e.clip.id)?.trackId)) || e.track,
    startTicks: e.clip.startTicks,
    durationTicks: e.clip.durationTicks,
  }));
  const { minDelta, maxDelta } = computeMoveConstraints(moves);
  const clamped = Math.min(Math.max(delta, minDelta), maxDelta);
  store.transact(opts.label || 'クリップを移動', () => {
    for (const e of entries) {
      store.touch(['tracks', e.trackIndex, 'clips', e.clipIndex]);
      e.clip.startTicks = Math.max(0, Math.round(e.clip.startTicks + clamped));
    }
  });
}

// ---------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------

export function minClipDuration(fps) {
  return Math.max(1, Math.round(120000 / Math.max(1, fps)));
}

/**
 * Trim one edge of a clip.
 * @param {'left'|'right'} edge
 * @param {number} deltaTicks desired change in timeline ticks (signed)
 */
export function trimClipEdge(store, clipId, edge, deltaTicks, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return false;
  const { clip } = found;
  const asset = clip.assetId ? store.state.assets[clip.assetId] : null;
  const minDur = minClipDuration(store.state.settings.fps);
  const speed = Math.max(0.0625, clip.speed || 1);
  const track = found.track;

  store.transact(opts.label || 'クリップをトリミング', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    if (edge === 'left') {
      let delta = Math.round(deltaTicks);
      // Cannot trim past the source start (unless the source is infinite).
      if (asset && asset.durationTicks) delta = Math.max(delta, -Math.round(clip.inTicks / speed));
      else delta = Math.max(delta, -clip.inTicks / speed);
      delta = Math.max(delta, -clip.startTicks);
      // Do not cross the previous clip.
      let prevEnd = 0;
      for (const other of track.clips) {
        if (other.id === clip.id) continue;
        const oEnd = other.startTicks + other.durationTicks;
        if (oEnd <= clip.startTicks) prevEnd = Math.max(prevEnd, oEnd);
      }
      delta = Math.max(delta, prevEnd - clip.startTicks);
      delta = Math.min(delta, clip.durationTicks - minDur);
      if (delta === 0) return;
      const sourceShift = Math.round(delta * speed);
      clip.startTicks = Math.max(0, clip.startTicks + delta);
      clip.durationTicks -= delta;
      clip.inTicks = Math.max(0, clip.inTicks + sourceShift);
      shiftKeyframes(clip, -sourceShift);
      clampFades(clip);
    } else {
      let delta = Math.round(deltaTicks);
      if (asset && asset.durationTicks) {
        const maxDur = Math.floor((asset.durationTicks - clip.inTicks) / speed);
        delta = Math.min(delta, Math.max(minDur, maxDur) - clip.durationTicks);
      }
      let nextStart = Infinity;
      for (const other of track.clips) {
        if (other.id === clip.id) continue;
        if (other.startTicks >= clip.startTicks + clip.durationTicks) nextStart = Math.min(nextStart, other.startTicks);
      }
      delta = Math.min(delta, nextStart - (clip.startTicks + clip.durationTicks));
      delta = Math.max(delta, minDur - clip.durationTicks);
      if (delta === 0) return;
      clip.durationTicks += delta;
      clampFades(clip);
    }
  });
  return true;
}

function clampFades(clip) {
  if (!clip.fades) return;
  const max = clip.durationTicks;
  clip.fades.inTicks = Math.max(0, Math.min(clip.fades.inTicks, max));
  clip.fades.outTicks = Math.max(0, Math.min(clip.fades.outTicks, max));
}

export function shiftKeyframes(clip, deltaTicks) {
  if (!clip.keyframes) return;
  for (const list of Object.values(clip.keyframes)) {
    for (const kf of list) kf.t = kf.t + deltaTicks;
  }
}

/** Set the clip's start/duration numerically (inspector fields). */
export function setClipTiming(store, clipId, patch, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return false;
  const { clip } = found;
  const asset = clip.assetId ? store.state.assets[clip.assetId] : null;
  const minDur = minClipDuration(store.state.settings.fps);
  store.transact(opts.label || 'クリップの時間を編集', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    if (patch.startTicks != null) clip.startTicks = Math.max(0, Math.round(patch.startTicks));
    if (patch.inTicks != null) {
      const maxIn = asset?.durationTicks ? Math.max(0, asset.durationTicks - 1) : Math.max(0, patch.inTicks);
      const nextIn = Math.max(0, Math.min(Math.round(patch.inTicks), maxIn));
      const shift = Math.round((nextIn - clip.inTicks) / Math.max(0.0625, clip.speed || 1));
      const applied = nextIn - clip.inTicks;
      clip.inTicks = nextIn;
      if (patch.startTicks == null) clip.startTicks = Math.max(0, clip.startTicks + shift);
      shiftKeyframes(clip, -applied);
    }
    if (patch.durationTicks != null) {
      let dur = Math.max(minDur, Math.round(patch.durationTicks));
      if (asset?.durationTicks) {
        const maxDur = Math.floor((asset.durationTicks - clip.inTicks) / Math.max(0.0625, clip.speed || 1));
        if (Number.isFinite(maxDur) && maxDur > 0) dur = Math.min(dur, maxDur);
      }
      clip.durationTicks = dur;
      clampFades(clip);
    }
    if (patch.name != null) clip.name = String(patch.name);
  });
  return true;
}

export function setClipSpeed(store, clipId, speed, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return false;
  const { clip } = found;
  const asset = clip.assetId ? store.state.assets[clip.assetId] : null;
  const next = Math.max(0.0625, Math.min(16, Number(speed) || 1));
  store.transact(opts.label || '再生速度を変更', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    const consumed = clip.durationTicks * (clip.speed || 1);
    clip.speed = next;
    clip.durationTicks = Math.max(minClipDuration(store.state.settings.fps), Math.round(consumed / next));
    if (asset?.durationTicks) {
      const maxDur = Math.floor((asset.durationTicks - clip.inTicks) / next);
      if (maxDur > 0) clip.durationTicks = Math.min(clip.durationTicks, maxDur);
    }
    clampFades(clip);
  });
  return true;
}

// ---------------------------------------------------------------------------
// Split / delete / duplicate
// ---------------------------------------------------------------------------

/** Deep clone a clip with fresh ids (effects remapped so keyframes follow). */
export function cloneClip(clip, overrides = {}) {
  const copy = JSON.parse(JSON.stringify(clip));
  copy.id = uid('clip');
  const idMap = new Map();
  copy.effects = (copy.effects || []).map((fx) => {
    const newId = uid('fx');
    idMap.set(fx.id, newId);
    return { ...fx, id: newId, params: { ...fx.params } };
  });
  const keyframes = {};
  for (const [path, list] of Object.entries(copy.keyframes || {})) {
    let newPath = path;
    if (path.startsWith('effects.')) {
      const [, oldId, ...rest] = path.split('.');
      const mapped = idMap.get(oldId);
      if (!mapped) continue;
      newPath = ['effects', mapped, ...rest].join('.');
    }
    keyframes[newPath] = list.map((kf) => ({ ...kf, id: uid('kf') }));
  }
  copy.keyframes = keyframes;
  return Object.assign(copy, overrides);
}

/**
 * Split clips at a timeline position.
 * @param {string[]} [clipIds] restrict to these clips
 * @returns {string[]} ids of the newly created (right-hand) clips
 */
export function splitAt(store, timeTicks, clipIds = null, opts = {}) {
  const t = Math.round(timeTicks);
  const created = [];
  const targets = [];
  for (const track of store.state.tracks) {
    if (track.locked) continue;
    for (const clip of track.clips) {
      if (clipIds && !clipIds.includes(clip.id)) continue;
      if (clip.locked) continue;
      if (t > clip.startTicks && t < clip.startTicks + clip.durationTicks) targets.push(clip.id);
    }
  }
  if (!targets.length) return created;

  store.transact(opts.label || `再生ヘッド位置で分割 (${targets.length})`, () => {
    for (const clipId of targets) {
      const found = store.findClip(clipId);
      if (!found) continue;
      const { clip, track } = found;
      const offset = t - clip.startTicks;
      const speed = Math.max(0.0625, clip.speed || 1);
      const sourceOffset = Math.round(offset * speed);
      const right = cloneClip(clip, {
        startTicks: t,
        durationTicks: clip.durationTicks - offset,
        inTicks: clip.inTicks + sourceOffset,
      });
      shiftKeyframes(right, -sourceOffset);
      right.fades = {
        inTicks: 0,
        outTicks: Math.min(clip.fades?.outTicks || 0, right.durationTicks),
      };
      const trackIndex2 = store.state.tracks.findIndex((tr) => tr.id === track.id);
      store.touch(['tracks', trackIndex2, 'clips']);
      const left = store.state.tracks[trackIndex2].clips.find((c) => c.id === clipId);
      left.durationTicks = offset;
      left.fades = { inTicks: Math.min(left.fades?.inTicks || 0, offset), outTicks: 0 };
      const arr = store.state.tracks[trackIndex2].clips;
      arr.push(right);
      sortClipsByStart(store.state.tracks[trackIndex2]);
      created.push(right.id);
    }
  });
  return created;
}

export function deleteClips(store, clipIds, opts = {}) {
  if (!clipIds.length) return;
  const entries = clipsById(store, clipIds);
  store.transact(opts.label || `クリップを削除 (${entries.length})`, () => {
    const byTrack = new Map();
    for (const entry of entries) {
      if (entry.clip.locked) continue;
      if (!byTrack.has(entry.track.id)) byTrack.set(entry.track.id, []);
      byTrack.get(entry.track.id).push(entry.clip);
    }
    for (const [trackId, clips] of byTrack) {
      const trackIndex = store.state.tracks.findIndex((tr) => tr.id === trackId);
      if (trackIndex < 0) continue;
      store.touch(['tracks', trackIndex, 'clips']);
      const track = store.state.tracks[trackIndex];
      const removed = new Set(clips.map((c) => c.id));
      const removedSpans = clips.map((c) => ({ start: c.startTicks, end: c.startTicks + c.durationTicks }));
      track.clips = track.clips.filter((c) => !removed.has(c.id));
      if (opts.ripple) {
        const shiftTotal = removedSpans.reduce((sum, s) => sum + (s.end - s.start), 0);
        const anchor = Math.min(...removedSpans.map((s) => s.start));
        for (const clip of track.clips) {
          if (clip.startTicks >= anchor) clip.startTicks = Math.max(0, clip.startTicks - shiftTotal);
        }
        sortClipsByStart(track);
      }
    }
  });
}

export function duplicateClips(store, clipIds, opts = {}) {
  const entries = clipsById(store, clipIds);
  if (!entries.length) return [];
  const created = [];
  store.transact(opts.label || `クリップを複製 (${entries.length})`, () => {
    for (const entry of entries) {
      const trackIndex = store.state.tracks.findIndex((tr) => tr.id === entry.track.id);
      if (trackIndex < 0) continue;
      const track = store.state.tracks[trackIndex];
      const copy = cloneClip(entry.clip);
      const start = opts.offsetTicks != null
        ? Math.max(0, entry.clip.startTicks + opts.offsetTicks)
        : findFreeSlot(track, clipEnd(entry.clip), copy.durationTicks);
      copy.startTicks = start;
      copy.trackId = track.id;
      store.touch(['tracks', trackIndex, 'clips']);
      track.clips.push(copy);
      sortClipsByStart(track);
      created.push(copy.id);
    }
  });
  return created;
}

/** Split every unlocked clip under the playhead on all tracks. */
export function razorAll(store, timeTicks) {
  return splitAt(store, timeTicks, null, { label: '全トラックを分割' });
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export function addTrack(store, kind, opts = {}) {
  const index = opts.index != null ? opts.index : store.state.tracks.length;
  const def = TRACK_KINDS[kind] || TRACK_KINDS.video;
  const track = createTrack(kind, {
    name: opts.name,
    index: store.state.tracks.filter((t) => t.kind === kind).length,
  });
  store.transact(opts.label || `${def.label}トラックを追加`, () => {
    store.touch(['tracks']);
    store.state.tracks.splice(index, 0, track);
  });
  return track;
}

export function deleteTrack(store, trackId, opts = {}) {
  const index = store.state.tracks.findIndex((t) => t.id === trackId);
  if (index < 0) return;
  store.transact(opts.label || 'トラックを削除', () => {
    store.touch(['tracks']);
    store.state.tracks.splice(index, 1);
    if (!store.state.tracks.length) store.state.tracks.push(createTrack('video', { name: '動画 1' }));
  });
}

/** Copy a track with all of its clips directly below (new ids everywhere). */
export function duplicateTrack(store, trackId, opts = {}) {
  const index = store.state.tracks.findIndex((t) => t.id === trackId);
  if (index < 0) return null;
  const source = store.state.tracks[index];
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = uid('track');
  copy.name = opts.name || `${source.name} のコピー`;
  copy.clips = copy.clips.map((clip) => cloneClip(clip, { trackId: copy.id }));
  copy.locked = false;
  store.transact(opts.label || 'トラックを複製', () => {
    store.touch(['tracks']);
    store.state.tracks.splice(index + 1, 0, copy);
  });
  return copy;
}

export function reorderTracks(store, fromIndex, toIndex, opts = {}) {
  if (fromIndex === toIndex) return;
  store.transact(opts.label || 'トラックを並べ替え', () => {
    store.touch(['tracks']);
    const [track] = store.state.tracks.splice(fromIndex, 1);
    store.state.tracks.splice(toIndex, 0, track);
  });
}

export function setTrackProp(store, trackId, path, value, opts = {}) {
  const index = store.state.tracks.findIndex((t) => t.id === trackId);
  if (index < 0) return;
  store.transact(opts.label || 'トラック設定を変更', () => {
    store.touch(['tracks', index, path.split('.')[0]]);
    store.state.tracks[index][path] = value;
  });
}

export function toggleTrackFlag(store, trackId, flag) {
  const track = store.state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  const labels = { locked: 'トラックをロック', hidden: 'トラック表示切替', muted: 'トラックをミュート', solo: 'トラックをソロ' };
  setTrackProp(store, trackId, flag, !track[flag], { label: labels[flag] || flag });
}

// ---------------------------------------------------------------------------
// Clip properties & keyframes
// ---------------------------------------------------------------------------

/**
 * Set a clip parameter.  If the parameter is animated the value is written as
 * a keyframe at the playhead (standard NLE "auto keyframe" behaviour),
 * otherwise the static value is updated.
 */
export function setParamValue(store, clipIds, path, value, opts = {}) {
  const entries = clipsById(store, clipIds);
  if (!entries.length) return;
  const playheadTicks = opts.playheadTicks != null ? opts.playheadTicks : null;
  store.transact(opts.label || 'プロパティを変更', () => {
    for (const entry of entries) {
      store.touch(['tracks', entry.trackIndex, 'clips', entry.clipIndex]);
      const clip = entry.clip;
      const animated = isAnimated(clip, path);
      if (animated && playheadTicks != null) {
        const local = Math.round((playheadTicks - clip.startTicks) * (clip.speed || 1));
        addKeyframe(clip, path, local, value, opts.interp || 'linear');
      } else if (opts.autoKey && playheadTicks != null) {
        const local = Math.round((playheadTicks - clip.startTicks) * (clip.speed || 1));
        addKeyframe(clip, path, local, value, opts.interp || 'linear');
      } else {
        setStaticValue(clip, path, value);
      }
    }
  });
}

export function toggleKeyframe(store, clipId, path, playheadTicks, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return;
  const { clip } = found;
  const local = Math.round((playheadTicks - clip.startTicks) * (clip.speed || 1));
  const list = getKeyframeList(clip, path);
  const existing = list?.find((kf) => Math.abs(kf.t - local) <= 1);
  store.transact(opts.label || (existing ? 'キーフレームを削除' : 'キーフレームを追加'), () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    if (existing) removeKeyframe(clip, path, existing.id);
    else addKeyframe(clip, path, local, getStaticValue(clip, path), opts.interp || 'linear');
  });
}

export function removeKeyframeById(store, clipId, path, kfId, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return;
  store.transact(opts.label || 'キーフレームを削除', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    removeKeyframe(found.clip, path, kfId);
  });
}

export function moveKeyframeTo(store, clipId, path, kfId, localTicks, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return false;
  let ok = false;
  store.transact(opts.label || 'キーフレームを移動', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    ok = moveKeyframe(found.clip, path, kfId, localTicks);
  });
  return ok;
}

export function setKeyframeValue(store, clipId, path, kfId, value, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return;
  store.transact(opts.label || 'キーフレームの値を変更', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    const kf = getKeyframeList(found.clip, path)?.find((k) => k.id === kfId);
    if (kf) kf.v = value;
  });
}

export function setKeyframeInterpolation(store, clipId, path, kfId, interp, bezier, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return;
  store.transact(opts.label || '補間方式を変更', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    setKeyframeInterp(found.clip, path, kfId, interp, bezier);
  });
}

export function clearClipKeyframes(store, clipId, path) {
  const found = store.findClip(clipId);
  if (!found) return;
  store.transact(path ? 'キーフレームをクリア' : '全キーフレームを削除', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    clearKeyframes(found.clip, path);
  });
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export function addEffect(store, clipIds, type, opts = {}) {
  const entries = clipsById(store, clipIds);
  if (!entries.length) return;
  store.transact(opts.label || 'エフェクトを追加', () => {
    for (const entry of entries) {
      store.touch(['tracks', entry.trackIndex, 'clips', entry.clipIndex]);
      entry.clip.effects.push(createEffect(type, opts.params));
    }
  });
}

export function removeEffect(store, clipId, fxId, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return;
  store.transact(opts.label || 'エフェクトを削除', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    found.clip.effects = found.clip.effects.filter((fx) => fx.id !== fxId);
    pruneOrphanKeyframes(found.clip);
  });
}

export function toggleEffect(store, clipId, fxId, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return;
  store.transact(opts.label || 'エフェクトのオン/オフ', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    const fx = found.clip.effects.find((f) => f.id === fxId);
    if (fx) fx.enabled = !fx.enabled;
  });
}

export function moveEffect(store, clipId, fxId, delta, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return;
  store.transact(opts.label || 'エフェクトの順序を変更', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    const list = found.clip.effects;
    const index = list.findIndex((fx) => fx.id === fxId);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= list.length) return;
    const [fx] = list.splice(index, 1);
    list.splice(next, 0, fx);
  });
}

export function setEffectParam(store, clipId, fxId, key, value, opts = {}) {
  const found = store.findClip(clipId);
  if (!found) return;
  const path = `effects.${fxId}.${key}`;
  store.transact(opts.label || 'エフェクトパラメータを変更', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    const clip = found.clip;
    if (isAnimated(clip, path) && opts.playheadTicks != null) {
      const local = Math.round((opts.playheadTicks - clip.startTicks) * (clip.speed || 1));
      addKeyframe(clip, path, local, value, 'linear');
    } else if (opts.autoKey && opts.playheadTicks != null) {
      const local = Math.round((opts.playheadTicks - clip.startTicks) * (clip.speed || 1));
      addKeyframe(clip, path, local, value, 'linear');
    } else {
      const fx = clip.effects.find((f) => f.id === fxId);
      if (fx) fx.params[key] = value;
    }
  });
}

export function setEffectParamStatic(store, clipId, fxId, key, value) {
  return setEffectParam(store, clipId, fxId, key, value, {});
}

/** Reset an effect's parameters to their defaults. */
export function resetEffect(store, clipId, fxId) {
  const found = store.findClip(clipId);
  if (!found) return;
  store.transact('エフェクトをリセット', () => {
    store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    const fx = found.clip.effects.find((f) => f.id === fxId);
    if (!fx) return;
    const def = getEffectDef(fx.type);
    fx.params = defaultEffectParams(fx.type);
    for (const path of Object.keys(found.clip.keyframes || {})) {
      if (path.startsWith(`effects.${fxId}.`)) delete found.clip.keyframes[path];
    }
    void def;
  });
}

export function effectsAvailableFor(clipType) {
  return effectsForClipType(clipType);
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export function addMarker(store, tick, name = 'マーカー', color = '#f6ad55') {
  store.transact('マーカーを追加', () => {
    store.touch(['markers']);
    store.state.markers.push({ id: uid('mark'), tick: Math.max(0, Math.round(tick)), name, color });
    store.state.markers.sort((a, b) => a.tick - b.tick);
  });
}

export function removeMarker(store, markerId) {
  store.transact('マーカーを削除', () => {
    store.touch(['markers']);
    store.state.markers = store.state.markers.filter((m) => m.id !== markerId);
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Select all clips on unlocked tracks. */
export function allClipIds(project) {
  const ids = [];
  for (const track of project.tracks) for (const clip of track.clips) ids.push(clip.id);
  return ids;
}

/** Clips whose time range intersects [from, to). */
export function clipsInRange(project, from, to, opts = {}) {
  const out = [];
  for (const track of project.tracks) {
    if (opts.trackId && track.id !== opts.trackId) continue;
    for (const clip of track.clips) {
      if (clip.startTicks < to && clip.startTicks + clip.durationTicks > from) out.push(clip.id);
    }
  }
  return out;
}

export function clipDurationLabel(ticks) {
  const seconds = ticks / 120000;
  return `${seconds.toFixed(2)}s`;
}

export { evaluateParam };
