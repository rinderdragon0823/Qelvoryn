/**
 * Qelvoryn - application shell.
 *
 * Wires the store, media pool, playback engine, auto director, persistence and
 * all UI panels together, and hosts the global keyboard map.
 *
 * Everything runs locally in the browser: no server, no upload, no build step.
 */

import { ProjectStore, deepClone } from './core/store.js';
import {
  createProject, createTrack, createClip, uid, projectDuration, TRACK_KINDS, DEFAULT_CLIP_SECONDS,
} from './core/model.js';
import { TICKS_PER_SECOND, secondsToTicks, snapTicksToFrame, ticksToSeconds, formatTimecode, formatDuration } from './core/time.js';
import * as cmd from './core/commands.js';
import { MediaPool } from './media/mediapool.js';
import { PlaybackController } from './audio/playback.js';
import { AutoDirector } from './auto/autodirector.js';
import { Persistence, formatBytes } from './core/persist.js';
import { Exporter, exportStill as renderStill } from './export/exporter.js';
import { el, append } from './ui/dom.js';
import { TimelineView } from './ui/timeline.js';
import { PreviewView } from './ui/preview.js';
import { MediaPanel } from './ui/mediapanel.js';
import { Inspector } from './ui/inspector.js';
import { Toolbar } from './ui/toolbar.js';
import {
  ToastHost, confirmDialog, promptDialog, exportDialog, projectSettingsDialog, settingsDialog, helpDialog,
  autoDirectorDialog, assetInfoDialog,
} from './ui/dialogs.js';

export class QelvorynApp {
  constructor() {
    this.session = {
      playheadTicks: 0,
      selection: [],
      selectedTrackId: null,
      snapEnabled: true,
      zoom: 90,
      scrollLeft: 0,
      previewScale: 1,
    };
    this.exporting = false;
    this.exportPrefs = null;
    this.statusTimer = 0;
    this._refreshQueued = false;

    const project = createProject({ name: '無題のプロジェクト' });
    project.tracks.push(createTrack('video', { name: '動画 1' }));
    project.tracks.push(createTrack('audio', { name: '音声 1' }));
    this.store = new ProjectStore(project);

    this.mediaPool = new MediaPool(this.store);
    this.playback = new PlaybackController({ mediaPool: this.mediaPool, store: this.store });
    this.autodirector = new AutoDirector(this);
    this.exporter = new Exporter(this);
    this.persistence = new Persistence(this);

    this.buildLayout();
    this.wireStore();
    this.wirePlayback();
    this.wireKeyboard();
    this.wireGlobalDrop();
    this.refreshAll();
  }

  // ------------------------------------------------------------------ layout --

  buildLayout() {
    this.toolbar = new Toolbar(this);
    this.mediaPanel = new MediaPanel(this);
    this.preview = new PreviewView(this);
    this.inspector = new Inspector(this);
    this.timeline = new TimelineView(this);
    this.toasts = new ToastHost();

    this.statusMsg = el('span.status-msg', { text: '準備完了' });
    this.statusInfo = el('span.status-info', { text: '' });
    this.statusbar = el('div.statusbar', {}, [this.statusMsg, el('span.spacer'), this.statusInfo]);

    const splitLeft = el('div.splitter-v', { title: 'ドラッグで幅を変更' });
    const splitRight = el('div.splitter-v', { title: 'ドラッグで幅を変更' });
    const splitTimeline = el('div.splitter-h', { title: 'ドラッグで高さを変更' });

    this.timeline.root.style.height = `${Math.round(window.innerHeight * 0.4)}px`;

    this.upper = el('div.upper', {}, [
      this.mediaPanel.root, splitLeft, this.preview.root, splitRight, this.inspector.root,
    ]);
    this.main = el('div.main', {}, [this.upper, splitTimeline, this.timeline.root]);
    this.root = el('div.app', {}, [this.toolbar.node, this.main, this.statusbar]);

    this.setupSplitter(splitLeft, this.mediaPanel.root, { min: 170, max: 460 });
    this.setupSplitter(splitRight, this.inspector.root, { min: 240, max: 620, invert: true });
    this.setupHeightSplitter(splitTimeline, this.timeline.root);
  }

  setupSplitter(handle, panel, opts) {
    let startX = 0;
    let startWidth = 0;
    handle.addEventListener('pointerdown', (ev) => {
      startX = ev.clientX;
      startWidth = panel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    handle.addEventListener('pointermove', (ev) => {
      if (!handle.classList.contains('dragging')) return;
      const dx = (ev.clientX - startX) * (opts.invert ? -1 : 1);
      const next = Math.max(opts.min, Math.min(opts.max, startWidth + dx));
      panel.style.width = `${Math.round(next)}px`;
      this.preview.resize();
      this.timeline.renderRuler();
      this.requestRender();
    });
    const end = (ev) => {
      if (!handle.classList.contains('dragging')) return;
      handle.classList.remove('dragging');
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  setupHeightSplitter(handle, panel) {
    let startY = 0;
    let startHeight = 0;
    handle.addEventListener('pointerdown', (ev) => {
      startY = ev.clientY;
      startHeight = panel.getBoundingClientRect().height;
      handle.classList.add('dragging');
      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    handle.addEventListener('pointermove', (ev) => {
      if (!handle.classList.contains('dragging')) return;
      const next = Math.max(150, Math.min(window.innerHeight - 220, startHeight - (ev.clientY - startY)));
      panel.style.height = `${Math.round(next)}px`;
      this.timeline.renderRuler();
    });
    const end = (ev) => {
      if (!handle.classList.contains('dragging')) return;
      handle.classList.remove('dragging');
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ----------------------------------------------------------------- wiring --

  wireStore() {
    this.store.on('change', (ev) => {
      this.persistence.schedule();
      if (ev.kind === 'live') {
        this.preview.requestRender();
        return;
      }
      this.scheduleRefresh();
    });
    this.store.on('history', () => this.toolbar.refresh());
  }

  wirePlayback() {
    this.playback.on('time', ({ timeTicks }) => {
      this.preview.onPlaybackTime(timeTicks);
    });
    this.playback.on('play', () => {
      this.updateTransport();
      this.setStatus('再生中…');
    });
    const stopped = (label) => {
      this.preview.onPlaybackStopped();
      this.updateTransport();
      this.setStatus(label);
    };
    this.playback.on('paused', () => stopped('一時停止'));
    this.playback.on('stop', () => stopped('停止'));
    this.playback.on('ended', () => stopped('末尾まで再生しました'));
    this.playback.on('warning', ({ message }) => {
      this.toast(message, 'warn', 6000);
      this.setStatus(message, 'warn');
    });
  }

  wireGlobalDrop() {
    const stop = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener('dragover', (ev) => {
      if (ev.dataTransfer?.types?.includes('Files')) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
      }
    });
    window.addEventListener('drop', async (ev) => {
      const files = [...(ev.dataTransfer?.files || [])];
      if (!files.length) return;
      stop(ev);
      await this.importFiles(files);
    });
  }

  wireKeyboard() {
    window.addEventListener('keydown', (ev) => {
      const target = ev.target;
      const tag = target?.tagName?.toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
      if (document.querySelector('.modal-backdrop')) return;

      const mod = ev.ctrlKey || ev.metaKey;
      if (typing && !mod) return;

      const key = ev.key;
      const lower = key.length === 1 ? key.toLowerCase() : key;

      if (mod && lower === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && lower === 'y') {
        ev.preventDefault();
        this.redo();
        return;
      }
      if (mod && lower === 's') {
        ev.preventDefault();
        this.autosaveNow();
        this.persistence.exportProjectFile();
        return;
      }
      if (mod && lower === 'e') {
        ev.preventDefault();
        exportDialog(this);
        return;
      }
      if (mod && lower === 'k') {
        ev.preventDefault();
        this.splitAtPlayhead();
        return;
      }
      if (mod && lower === 'd') {
        ev.preventDefault();
        this.duplicateSelection();
        return;
      }
      if (mod && (lower === '=' || lower === '+')) {
        ev.preventDefault();
        this.zoomBy(1.25);
        return;
      }
      if (mod && lower === '-') {
        ev.preventDefault();
        this.zoomBy(1 / 1.25);
        return;
      }
      if (mod && lower === 'a') {
        ev.preventDefault();
        this.selectAllClips();
        return;
      }
      if (mod) return;

      switch (key) {
        case ' ':
          ev.preventDefault();
          this.togglePlay();
          break;
        case 'ArrowLeft':
          ev.preventDefault();
          if (ev.shiftKey) this.setPlayhead(this.session.playheadTicks - TICKS_PER_SECOND);
          else this.stepFrames(-1);
          break;
        case 'ArrowRight':
          ev.preventDefault();
          if (ev.shiftKey) this.setPlayhead(this.session.playheadTicks + TICKS_PER_SECOND);
          else this.stepFrames(1);
          break;
        case 'Home':
          ev.preventDefault();
          this.setPlayhead(0);
          break;
        case 'End':
          ev.preventDefault();
          this.setPlayhead(this.projectDuration());
          break;
        case 'Delete':
        case 'Backspace':
          ev.preventDefault();
          this.deleteSelection();
          break;
        default:
          break;
      }

      switch (lower) {
        case 'k':
          this.splitAtPlayhead();
          break;
        case 't':
          this.splitAllAtPlayhead();
          break;
        case 's':
          this.setSnapEnabled(!this.session.snapEnabled);
          break;
        case 'm':
          this.addMarkerAt();
          break;
        case 'i':
          this.setWorkAreaIn(this.session.playheadTicks);
          break;
        case 'o':
          this.setWorkAreaOut(this.session.playheadTicks);
          break;
        case 'f':
          this.zoomToFit();
          break;
        case 'x':
          if (ev.altKey) this.clearWorkArea();
          break;
        case '+':
        case '=':
          this.zoomBy(1.25);
          break;
        case '-':
          this.zoomBy(1 / 1.25);
          break;
        default:
          break;
      }
    });
  }

  // -------------------------------------------------------------- lifecycle --

  async boot() {
    append(document.body, this.root);
    document.body.appendChild(this.toasts.node);

    try {
      const restored = await this.persistence.restore();
      if (restored?.project) {
        this.store.load(restored.project, { label: '自動保存から復元' });
        if (restored.session) {
          for (const key of ['playheadTicks', 'snapEnabled', 'zoom', 'previewScale', 'selectedTrackId']) {
            if (restored.session[key] != null) this.session[key] = restored.session[key];
          }
        }
        this.persistence.start();
        this.timeline.setZoom(this.session.zoom || 90);
        this.preview.qualitySelect.value = String(this.session.previewScale || 1);
        this.setStatus(`前回のセッションを復元しました（${new Date(restored.savedAt || Date.now()).toLocaleString('ja-JP')}）`, 'ok');
        this.toast('前回の作業を復元しました。素材が表示されない場合は 設定 → メディアの再リンク を実行してください。', 'info', 8000);
      } else {
        this.persistence.start();
        this.setStatus('Qelvoryn へようこそ。素材を読み込むか、動画をここにドロップしてください。');
        this.toast('素材を読み込むと編集を開始できます（動画/画像/音声）', 'info', 6000);
      }
    } catch (err) {
      console.warn('[Qelvoryn] restore failed', err);
      this.persistence.start();
      this.setStatus('復元に失敗しました。新しいプロジェクトを開始します。', 'warn');
    }

    this.updateMissingAssetsHint();
    this.refreshAll();
    this.preview.resize();
    this.preview.requestRender({ force: true });
    window.addEventListener('beforeunload', (ev) => {
      this.persistence.saveNow().catch(() => {});
      if (this.exporting) {
        ev.preventDefault();
        ev.returnValue = '書き出し中です。このページを離れますか？';
      }
    });
    window.addEventListener('resize', () => {
      this.preview.resize();
      this.timeline.renderRuler();
      this.requestRender();
    });
    return this;
  }

  updateMissingAssetsHint() {
    const missing = Object.values(this.store.state.assets).filter((a) => !this.mediaPool.blobs.has(a.id));
    if (missing.length) {
      this.setStatus(`${missing.length} 件のメディアがブラウザ内に見つかりません。「設定」→「メディアの再リンク」で選択してください。`, 'warn');
    }
  }

  serializeSession() {
    return {
      playheadTicks: this.session.playheadTicks,
      snapEnabled: this.session.snapEnabled,
      zoom: this.session.zoom,
      previewScale: this.session.previewScale,
      selectedTrackId: this.session.selectedTrackId,
      selection: [...this.session.selection],
    };
  }

  // ---------------------------------------------------------------- refresh --

  refreshAll() {
    this.timeline.render();
    this.inspector.render();
    this.mediaPanel.render();
    this.toolbar.refresh();
    this.preview.resize();
    this.preview.requestRender();
    this.updateStatus();
  }

  scheduleRefresh() {
    if (this._refreshQueued) return;
    this._refreshQueued = true;
    requestAnimationFrame(() => {
      this._refreshQueued = false;
      if (this.exporting) return;
      this.refreshAll();
    });
  }

  onProjectChanged() {
    this.scheduleRefresh();
  }

  onSelectionChanged() {
    this.timeline.updateSelectionStyles();
    this.inspector.render();
    this.updateStatus();
  }

  requestRender() {
    if (this.exporting) return;
    this.preview.requestRender();
  }

  updateTransport() {
    this.preview.updateTimecode();
    this.toolbar.refresh();
  }

  updateStatus() {
    const project = this.store.state;
    let clips = 0;
    for (const track of project.tracks) clips += track.clips.length;
    const parts = [
      `選択 ${this.session.selection.length}`,
      `クリップ ${clips}`,
      `長さ ${formatDuration(this.projectDuration())}`,
      `ズーム ${Math.round(this.timeline?.pxPerSecond || 90)}px/s`,
    ];
    if (this.persistence?.lastSavedAt) {
      parts.push(`自動保存 ${new Date(this.persistence.lastSavedAt).toLocaleTimeString('ja-JP')}`);
    }
    this.statusInfo.textContent = parts.join(' ・ ');
  }

  setStatus(message, kind = 'info', timeout = 5000) {
    this.statusMsg.textContent = message;
    this.statusMsg.className = `status-msg ${kind === 'info' ? '' : kind}`.trim();
    clearTimeout(this.statusTimer);
    if (timeout > 0) {
      this.statusTimer = setTimeout(() => {
        this.statusMsg.textContent = '準備完了';
        this.statusMsg.className = 'status-msg';
      }, timeout);
    }
  }

  toast(message, kind = 'info', timeout = 3600) {
    this.toasts.push(message, kind, timeout);
  }

  /** confirmDialog with a callback (UI panels use this form). */
  async confirm(message, onOk, opts = {}) {
    const ok = await confirmDialog(message, opts);
    if (ok) await onOk?.();
    return ok;
  }

  async prompt(message, opts) {
    return promptDialog(message, opts);
  }

  setExporting(v) {
    this.exporting = !!v;
    this.root.classList.toggle('is-exporting', !!v);
    if (v) {
      this.setStatus('書き出し中です。タブを表示したままにしてください…', 'warn', 0);
    } else {
      this.setStatus('書き出しが終了しました', 'ok');
    }
  }

  // ------------------------------------------------------------ project info --

  projectDuration() {
    return Math.max(projectDuration(this.store.state), TICKS_PER_SECOND);
  }

  fps() {
    return this.store.state.settings.fps;
  }

  // ------------------------------------------------------------- transport ---

  setPlayhead(ticks, opts = {}) {
    const clamped = Math.max(0, Math.min(this.projectDuration(), Math.round(ticks)));
    this.session.playheadTicks = clamped;
    this.timeline.updatePlayhead();
    this.preview.updateTimecode();
    this.updateStatus();
    if (this.playback.playing) {
      this.playback.seek(clamped);
    } else if (opts.ensureVisible) {
      this.timeline.scrollToTicks(clamped);
    }
    this.requestRender();
  }

  stepFrames(delta) {
    const tpf = TICKS_PER_SECOND / this.fps();
    const next = snapTicksToFrame(this.session.playheadTicks + delta * tpf, this.fps());
    this.setPlayhead(next, { ensureVisible: true });
  }

  async togglePlay() {
    if (this.playback.playing) {
      this.playback.pause();
      return;
    }
    const end = this.projectDuration();
    let from = this.session.playheadTicks;
    if (from >= end - 1000) from = 0;
    const ok = await this.playback.play(this.store.state, from, end);
    if (!ok) this.toast('再生できる長さがありません', 'warn');
  }

  // ------------------------------------------------------------ selection ----

  get selection() {
    return this.session.selection;
  }

  selectClips(ids, opts = {}) {
    const { additive = false, toggle = false } = opts;
    const list = [...ids].filter((id) => this.store.clipRef(id));
    let next;
    if (additive || toggle) {
      const set = new Set(this.session.selection);
      for (const id of list) {
        if (toggle && set.has(id)) set.delete(id);
        else set.add(id);
      }
      next = [...set];
    } else {
      next = list;
    }
    this.session.selection = next;
    this.onSelectionChanged();
  }

  selectAllClips() {
    const ids = [];
    for (const track of this.store.state.tracks) {
      if (track.hidden) continue;
      for (const clip of track.clips) ids.push(clip.id);
    }
    this.selectClips(ids);
  }

  selectTrack(trackId, opts = {}) {
    if (this.session.selectedTrackId === trackId && opts.silent) return;
    this.session.selectedTrackId = trackId;
    if (!opts.silent) {
      this.timeline.render();
      this.inspector.render();
      this.updateStatus();
    }
  }

  // ---------------------------------------------------------------- editing --

  undo() {
    const label = this.store.undoStack.at(-1)?.label;
    if (this.store.undo()) {
      this.session.selection = this.session.selection.filter((id) => this.store.clipRef(id));
      this.setStatus(label ? `元に戻しました: ${label}` : '元に戻しました');
    } else {
      this.toast('元に戻す操作がありません', 'warn', 1800);
    }
  }

  redo() {
    const label = this.store.redoStack.at(-1)?.label;
    if (this.store.redo()) {
      this.setStatus(label ? `やり直しました: ${label}` : 'やり直しました');
    } else {
      this.toast('やり直す操作がありません', 'warn', 1800);
    }
  }

  splitAtPlayhead() {
    const t = this.session.playheadTicks;
    const useSelection = this.session.selection.length > 0;
    const created = cmd.splitAt(this.store, t, useSelection ? this.session.selection : null);
    if (!created.length) {
      this.toast('再生ヘッド位置に分割できるクリップがありません', 'warn', 2200);
      return;
    }
    this.selectClips(created);
    this.setStatus(`${created.length} 個のクリップを分割しました`);
  }

  splitAllAtPlayhead() {
    const created = cmd.razorAll(this.store, this.session.playheadTicks);
    if (!created.length) {
      this.toast('再生ヘッド位置に分割できるクリップがありません', 'warn', 2200);
      return;
    }
    this.setStatus(`${created.length} 個のクリップを分割しました`);
  }

  deleteSelection() {
    if (!this.session.selection.length) {
      this.toast('削除するクリップを選択してください', 'warn', 1800);
      return;
    }
    const n = this.session.selection.length;
    cmd.deleteClips(this.store, [...this.session.selection]);
    this.session.selection = [];
    this.onSelectionChanged();
    this.setStatus(`${n} 個のクリップを削除しました（Ctrl+Z で元に戻せます）`);
  }

  duplicateSelection() {
    if (!this.session.selection.length) {
      this.toast('複製するクリップを選択してください', 'warn', 1800);
      return;
    }
    const created = cmd.duplicateClips(this.store, [...this.session.selection]);
    if (created.length) this.selectClips(created);
  }

  addMarkerAt(ticks) {
    const t = ticks ?? this.session.playheadTicks;
    cmd.addMarker(this.store, t);
    this.timeline.render();
    this.setStatus(`マーカーを追加: ${formatTimecode(t, this.fps())}`);
  }

  clearTrack(trackId) {
    const track = this.store.track(trackId);
    if (!track) return;
    this.confirm(`「${track.name}」のクリップをすべて削除しますか？`, () => {
      const index = this.store.state.tracks.indexOf(track);
      this.store.transact('トラックを空にする', () => {
        this.store.touch(['tracks', index, 'clips']);
        track.clips = [];
      });
      this.session.selection = [];
      this.onSelectionChanged();
    }, { title: 'トラックを空にする', danger: true, okLabel: '削除' });
  }

  snapValue(ticks, opts = {}) {
    const enabled = this.session.snapEnabled && !opts.disable;
    const threshold = opts.thresholdTicks ?? (this.timeline ? this.timeline.pxToTicks(8) : 2400);
    return cmd.snapTime(this.store.state, ticks, {
      enabled,
      thresholdTicks: threshold,
      excludeClipIds: opts.excludeClipIds || [],
      playheadTicks: null,
    });
  }

  setSnapEnabled(enabled) {
    this.session.snapEnabled = !!enabled;
    this.timeline.snapBtn.classList.toggle('active', this.session.snapEnabled);
    this.toolbar.refresh();
    this.setStatus(this.session.snapEnabled ? 'スナップ: オン' : 'スナップ: オフ', 'info', 1600);
  }

  zoomToFit() {
    this.timeline.zoomToFit();
  }

  zoomBy(factor) {
    this.timeline.zoomBy(factor);
  }

  // ------------------------------------------------------------- work area --

  setWorkAreaIn(ticks) {
    const t = Math.max(0, Math.round(ticks));
    const current = this.store.state.settings.workArea;
    const out = current && current.outTicks > t ? current.outTicks : this.projectDuration();
    this.store.transact('ワークエリアを設定', () => {
      this.store.touch(['settings']);
      this.store.state.settings.workArea = { inTicks: t, outTicks: Math.max(t + 1, out) };
    });
    this.timeline.render();
    this.setStatus(`ワークエリア開始: ${formatTimecode(t, this.fps())}`);
  }

  setWorkAreaOut(ticks) {
    const t = Math.max(0, Math.round(ticks));
    const current = this.store.state.settings.workArea;
    const start = current && current.inTicks < t ? current.inTicks : 0;
    this.store.transact('ワークエリアを設定', () => {
      this.store.touch(['settings']);
      this.store.state.settings.workArea = { inTicks: start, outTicks: Math.max(start + 1, t) };
    });
    this.timeline.render();
    this.setStatus(`ワークエリア終了: ${formatTimecode(t, this.fps())}`);
  }

  clearWorkArea() {
    if (!this.store.state.settings.workArea) return;
    this.store.transact('ワークエリアをクリア', () => {
      this.store.touch(['settings']);
      delete this.store.state.settings.workArea;
    });
    this.timeline.render();
    this.setStatus('ワークエリアをクリアしました');
  }

  // ------------------------------------------------------------------ media --

  async importFiles(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return [];
    this.setStatus(`素材を読み込んでいます… (${list.length} 件)`);
    const ids = await this.mediaPool.importFiles(list);
    this.mediaPanel.render();
    this.toast(`${ids.length} 件の素材を追加しました`, 'info');
    this.setStatus(`${ids.length} 件の素材を追加しました`, 'ok');
    return ids;
  }

  clipFromAsset(asset, startTicks) {
    const type = asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'image' : 'video';
    let durationTicks = asset.durationTicks || 0;
    if (!durationTicks) durationTicks = secondsToTicks(asset.kind === 'image' ? DEFAULT_CLIP_SECONDS : 5);
    return createClip(type, {
      assetId: asset.id,
      name: asset.name,
      startTicks: Math.max(0, Math.round(startTicks)),
      durationTicks: Math.max(1, Math.round(durationTicks)),
      color: null,
      metadata: { sourceAssetName: asset.sourceName },
    });
  }

  /** Track kind used when a new track must be created for a clip type. */
  trackKindForClip(clipType) {
    if (clipType === 'audio') return 'audio';
    if (clipType === 'text') return 'text';
    if (clipType === 'image') return 'image';
    if (clipType === 'effect') return 'effect';
    return 'video';
  }

  /**
   * Create a track that can hold `clipType`.
   * Visual tracks appear right above `nearIndex` (top when negative),
   * audio tracks right below it (bottom when negative).
   */
  createTrackForClip(clipType, nearIndex = -1) {
    const kind = this.trackKindForClip(clipType);
    const def = TRACK_KINDS[kind];
    const count = this.store.state.tracks.filter((t) => t.kind === kind).length + 1;
    const tracks = this.store.state.tracks;
    let index;
    if (nearIndex >= 0 && nearIndex < tracks.length) index = kind === 'audio' ? nearIndex + 1 : nearIndex;
    else index = kind === 'audio' ? tracks.length : 0;
    return cmd.addTrack(this.store, kind, { name: `${def.label} ${count}`, index });
  }

  /**
   * Drop an asset on the timeline (Premiere/YMM4 style):
   * the preferred lane wins when it is free, otherwise the first free
   * compatible track is used, and a new track is created when everything
   * at that spot is busy.
   * @param {string} assetId
   * @param {{trackIndex?:number, ticks?:number}} [opts]
   */
  addAssetToTimeline(assetId, opts = {}) {
    const asset = this.store.state.assets[assetId];
    if (!asset) return null;
    const start = opts.ticks != null ? Math.max(0, Math.round(opts.ticks)) : this.session.playheadTicks;
    const preferredIndex = opts.trackIndex != null && opts.trackIndex >= 0 ? opts.trackIndex : -1;
    let inserted = null;
    let track = null;
    let created = false;
    this.store.transact(`素材を追加: ${asset.name}`, () => {
      const clip = this.clipFromAsset(asset, start);
      track = cmd.findTrackForClip(this.store.state, clip.type, {
        ticks: clip.startTicks,
        durationTicks: clip.durationTicks,
        preferredIndex,
      });
      if (!track) {
        track = this.createTrackForClip(clip.type, preferredIndex);
        created = true;
      }
      inserted = cmd.insertClip(this.store, track.id, clip, {
        label: `素材を追加: ${asset.name}`,
        resolveOverlap: false,
      });
    });
    if (inserted) {
      this.selectClips([inserted.id]);
      this.timeline.scrollToTicks(inserted.startTicks);
      this.setStatus(created
        ? `「${asset.name}」を新しいトラック「${track.name}」に配置しました`
        : `「${asset.name}」を「${track.name}」に配置しました`);
    }
    return inserted;
  }

  insertAssetAtPlayhead(assetId) {
    return this.addAssetToTimeline(assetId, { ticks: this.session.playheadTicks });
  }

  insertAssetOnNewTrack(assetId) {
    const asset = this.store.state.assets[assetId];
    if (!asset) return null;
    const clip = this.clipFromAsset(asset, this.session.playheadTicks);
    const track = this.createTrackForClip(clip.type, -1);
    return this.addAssetToTimeline(assetId, {
      trackIndex: this.store.state.tracks.indexOf(track),
      ticks: this.session.playheadTicks,
    });
  }

  async relinkAssets(files) {
    const list = files && files.length ? [...files] : await this.pickFiles('video/*,image/*,audio/*');
    if (!list.length) return 0;
    const matched = await this.mediaPool.relinkAssets(list);
    this.mediaPanel.render();
    this.preview.requestRender({ force: true });
    return matched.length;
  }

  pickFiles(accept) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'file', multiple: true, accept, style: { display: 'none' } });
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const files = [...(input.files || [])];
        input.remove();
        resolve(files);
      });
      input.click();
    });
  }

  showAssetInfo(assetId) {
    assetInfoDialog(this, assetId);
  }

  // --------------------------------------------------------------- settings --

  showProjectSettings() {
    projectSettingsDialog(this);
  }

  applyProjectSettings(spec = {}) {
    this.store.transact('プロジェクト設定を変更', () => {
      this.store.touch(['settings']);
      this.store.touch(['name']);
      const s = this.store.state.settings;
      if (spec.name != null && String(spec.name).trim()) this.store.state.name = String(spec.name).trim();
      if (spec.width != null) s.width = Math.max(16, Math.round(spec.width));
      if (spec.height != null) s.height = Math.max(16, Math.round(spec.height));
      if (spec.fps != null) s.fps = Math.max(1, Math.min(240, Number(spec.fps) || 30));
      if (spec.backgroundColor != null) s.backgroundColor = spec.backgroundColor;
    });
    this.preview.resize();
    this.timeline.render();
    this.requestRender();
    this.setStatus('プロジェクト設定を更新しました', 'ok');
  }

  async autosaveNow() {
    const ok = await this.persistence.saveNow().catch(() => false);
    if (ok) {
      this.setStatus('自動保存しました', 'ok');
      this.toolbar.refresh();
    } else {
      this.toast('自動保存に失敗しました（保存領域を確認してください）', 'warn');
    }
  }

  duplicateProject() {
    this.confirm('現在のプロジェクトを複製しますか？（素材データは共有されます）', () => {
      const copy = deepClone(this.store.state);
      copy.id = uid('proj');
      copy.name = `${copy.name} のコピー`;
      for (const track of copy.tracks) {
        const newTrackId = uid('trk');
        track.id = newTrackId;
        for (const clip of track.clips) {
          clip.id = uid('clip');
          clip.trackId = newTrackId;
          clip.effects = (clip.effects || []).map((fx) => ({ ...fx, id: uid('fx') }));
        }
      }
      copy.markers = (copy.markers || []).map((m) => ({ ...m, id: uid('mk') }));
      this.store.load(copy, { label: 'プロジェクトを複製' });
      this.session.selection = [];
      this.session.playheadTicks = 0;
      this.refreshAll();
      this.setStatus('プロジェクトを複製しました', 'ok');
    }, { title: 'プロジェクトを複製', okLabel: '複製' });
  }

  // ----------------------------------------------------------------- export --

  async exportStill(ticks) {
    const t = ticks ?? this.session.playheadTicks;
    try {
      this.setStatus('フレームを書き出しています…');
      const dataUrl = await renderStill(this.mediaPool, this.store.state, t, 1);
      const name = (this.store.state.name || 'qelvoryn').replace(/[\\/:*?"<>|]/g, '_');
      const frame = Math.round((t / TICKS_PER_SECOND) * this.fps());
      Persistence.downloadDataURL(`${name}_frame_${String(frame).padStart(5, '0')}.png`, dataUrl);
      this.setStatus('フレームをPNGで書き出しました', 'ok');
    } catch (err) {
      this.toast(`フレーム書き出しに失敗: ${err.message}`, 'error');
    }
  }

  showExportDialog() {
    exportDialog(this);
  }

  showAutoDirector() {
    autoDirectorDialog(this);
  }

  showSettings() {
    settingsDialog(this);
  }

  showHelp() {
    helpDialog();
  }

  focusInspectorText(clipId) {
    if (clipId) {
      this.selectClips([clipId]);
      this.inspector.setActiveTab('clip');
      this.inspector.render();
    }
    const area = this.inspector.bodyEl.querySelector('textarea.input.textarea');
    if (area) {
      area.focus();
      area.select();
    }
  }

  async openProjectFile(file) {
    const { project, missingAssets } = await this.persistence.parseProjectFile(file);
    const doLoad = async () => {
      this.playback.stop({ silent: true });
      this.store.load(project, { label: 'プロジェクトファイルを開く' });
      this.session.selection = [];
      this.session.playheadTicks = 0;
      await this.persistence.saveNow().catch(() => {});
      this.refreshAll();
      this.preview.requestRender({ force: true });
      if (missingAssets.length) {
        this.toast(`メディア ${missingAssets.length} 件が見つかりません: ${missingAssets.slice(0, 3).join(', ')}${missingAssets.length > 3 ? ' ほか' : ''}`, 'warn', 9000);
        this.setStatus('「設定」→「メディアの再リンク」でファイルを選択してください', 'warn', 9000);
      } else {
        this.setStatus('プロジェクトを読み込みました', 'ok');
      }
    };
    if (this.store.undoStack.length) {
      this.confirm('現在のプロジェクトを閉じて、選択したファイルを開きますか？（現在の内容は自動保存に残ります）', doLoad, {
        title: 'プロジェクトを開く',
        okLabel: '開く',
      });
    } else {
      await doLoad();
    }
  }

  newProject() {
    this.confirm('新しいプロジェクトを作成しますか？（現在の内容は自動保存に残ります）', () => {
      const project = createProject({ name: '無題のプロジェクト' });
      project.tracks.push(createTrack('video', { name: '動画 1' }));
      project.tracks.push(createTrack('audio', { name: '音声 1' }));
      this.playback.stop({ silent: true });
      this.store.load(project, { label: '新規プロジェクト' });
      this.session.selection = [];
      this.session.playheadTicks = 0;
      this.refreshAll();
      this.preview.requestRender({ force: true });
      this.setStatus('新しいプロジェクトを作成しました', 'ok');
    }, { title: '新規プロジェクト', okLabel: '作成' });
  }
}
