/**
 * Timeline view: multi-track lanes, clips, ruler, playhead and every direct
 * manipulation gesture (select, drag, trim, fade, marquee, drop, razor).
 *
 * Interaction rules (deliberately conservative so nothing happens by
 * accident):
 *   - Dragging only starts after a 3px threshold, and the gesture is captured
 *     on the lanes container.
 *   - The playhead never moves from a lane click; only the ruler, the
 *     transport or the keyboard move it.
 *   - Locked tracks/clips ignore every edit gesture.
 *   - Holding Alt temporarily disables snapping.
 */

import { el, append, clear, icon, iconButton, button, formatNumber } from './dom.js';
import { TRACK_KINDS, CLIP_TYPES, clipEnd, canTrackAcceptClip, createClip } from '../core/model.js';
import {
  insertClip, deleteClips, duplicateClips, splitAt, setTrackProp, toggleTrackFlag,
  reorderTracks, deleteTrack, addTrack, computeMoveConstraints, trimClipEdge,
  selectedClips, clipsById,
} from '../core/commands.js';
import { TICKS_PER_SECOND, formatTimecode, parseTimecode, snapTicksToFrame } from '../core/time.js';
import { envelopeForWidth } from '../media/waveform.js';
import { contextMenu } from './menu.js';

const HEADER_H = 30;
const DRAG_THRESHOLD = 3;
const MIN_PX_PER_SECOND = 2;
const MAX_PX_PER_SECOND = 2400;
const WAVE_MAX_CANVAS = 4000;

export class TimelineView {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.session = app.session;
    this.pxPerSecond = 90;
    this.trackEls = new Map();
    this.clipEls = new Map();
    this.gesture = null;
    this.waveTokens = new Map();
    this.visibleStart = 0;
    this.visibleEnd = 0;
    this.lastSnap = null;
    this.build();
  }

  // ------------------------------------------------------------- geometry --

  get pxPerTick() {
    return this.pxPerSecond / TICKS_PER_SECOND;
  }

  ticksToPx(ticks) {
    return ticks * this.pxPerTick;
  }

  pxToTicks(px) {
    return px / this.pxPerTick;
  }

  get contentWidth() {
    const duration = Math.max(this.app.projectDuration(), 10 * TICKS_PER_SECOND);
    return Math.max(this.viewportWidth, this.ticksToPx(duration) + 400);
  }

  get viewportWidth() {
    return this.scrollEl?.clientWidth || 800;
  }

  // ---------------------------------------------------------------- build --

  build() {
    this.root = el('div.timeline');
    this.toolbarEl = el('div.tl-toolbar');
    this.headersEl = el('div.tl-headers');
    this.headersInner = el('div.tl-headers-inner');
    this.scrollEl = el('div.tl-scroll');
    this.contentEl = el('div.tl-content');
    this.rulerEl = el('div.tl-ruler');
    this.rulerCanvas = el('canvas');
    this.lanesEl = el('div.tl-lanes');
    this.playheadEl = el('div.playhead');
    this.snapGuideEl = el('div.snap-guide');
    this.marqueeEl = el('div.marquee');
    this.dropIndicatorEl = el('div.drop-indicator');
    this.workAreaEl = el('div.work-area');

    append(this.rulerEl, this.rulerCanvas);
    append(this.contentEl, [
      this.workAreaEl,
      this.rulerEl,
      this.lanesEl,
      this.playheadEl,
      this.snapGuideEl,
      this.dropIndicatorEl,
      this.marqueeEl,
    ]);
    append(this.scrollEl, this.contentEl);
    append(this.headersEl, [
      el('div.tl-ruler-corner', {}, [
        el('span', { text: 'トラック' }),
        el('span.spacer', { style: { flex: '1 1 auto' } }),
      ]),
      this.headersInner,
    ]);
    append(this.root, [
      this.toolbarEl,
      el('div.tl-body', {}, [this.headersEl, this.scrollEl]),
    ]);

    this.buildToolbar();
    this.bindEvents();
  }

  buildToolbar() {
    const zoomIn = iconButton('zoomIn', { title: 'ズームイン (+)', onclick: () => this.zoomBy(1.25) });
    const zoomOut = iconButton('zoomOut', { title: 'ズームアウト (-)', onclick: () => this.zoomBy(0.8) });
    this.zoomSlider = el('input.zoom-slider', {
      type: 'range',
      min: Math.log(MIN_PX_PER_SECOND),
      max: Math.log(MAX_PX_PER_SECOND),
      step: 0.01,
      value: Math.log(this.pxPerSecond),
      title: 'タイムラインのズーム',
    });
    this.zoomSlider.addEventListener('input', () => {
      this.setZoom(Math.exp(parseFloat(this.zoomSlider.value)));
    });

    this.snapBtn = button('スナップ', {
      icon: 'magnet',
      onclick: () => this.app.setSnapEnabled(!this.session.snapEnabled),
    });
    this.snapBtn.classList.toggle('active', this.session.snapEnabled);

    this.trackHeightSlider = el('input.zoom-slider', {
      type: 'range',
      min: 60,
      max: 200,
      step: 1,
      value: 84,
      title: 'トラックの高さ',
    });
    this.trackHeightSlider.style.width = '80px';
    this.trackHeightSlider.addEventListener('input', () => {
      const h = parseInt(this.trackHeightSlider.value, 10);
      this.store.transact('トラックの高さを変更', () => {
        this.store.touch(['tracks']);
        for (const track of this.store.state.tracks) {
          if (track.height !== h) track.height = h;
        }
      });
    });

    append(this.toolbarEl, [
      button('分割', { icon: 'scissors', title: '再生ヘッド位置で分割 (K)', onclick: () => this.app.splitAtPlayhead() }),
      button('全分割', { title: '全トラックを再生ヘッドで分割 (T)', onclick: () => this.app.splitAllAtPlayhead() }),
      button('削除', { icon: 'trash', title: '選択クリップを削除 (Del)', onclick: () => this.app.deleteSelection() }),
      button('複製', { icon: 'copy', title: '選択クリップを複製 (Ctrl+D)', onclick: () => this.app.duplicateSelection() }),
      el('div.toolbar-sep'),
      this.snapBtn,
      el('div.toolbar-sep'),
      zoomOut,
      this.zoomSlider,
      zoomIn,
      button('全体', { title: '全体を表示 (Shift+Z)', onclick: () => this.zoomToFit() }),
      el('div.toolbar-sep'),
      this.trackHeightSlider,
      el('div.spacer', { style: { flex: '1 1 auto' } }),
      button('トラック追加', {
        icon: 'plus',
        title: 'トラックを追加',
        onclick: (ev) => this.showAddTrackMenu(ev.currentTarget),
      }),
    ]);
  }

  showAddTrackMenu(anchor) {
    const items = Object.entries(TRACK_KINDS).map(([kind, def]) => ({
      label: `${def.label}トラック`,
      action: () => addTrack(this.store, kind),
    }));
    contextMenu(anchor, items);
  }

  bindEvents() {
    const scroll = this.scrollEl;
    scroll.addEventListener('scroll', () => this.onScroll(), { passive: true });
    scroll.addEventListener('wheel', (ev) => {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        this.zoomBy(ev.deltaY < 0 ? 1.12 : 1 / 1.12, ev.clientX);
      }
    }, { passive: false });

    this.rulerEl.addEventListener('pointerdown', (ev) => this.beginScrub(ev));
    this.lanesEl.addEventListener('pointerdown', (ev) => this.onLanesPointerDown(ev));
    this.lanesEl.addEventListener('dblclick', (ev) => this.onLanesDoubleClick(ev));
    this.lanesEl.addEventListener('contextmenu', (ev) => this.onContextMenu(ev));
    this.rulerEl.addEventListener('contextmenu', (ev) => this.onRulerContextMenu(ev));

    // media drag & drop
    this.lanesEl.addEventListener('dragover', (ev) => this.onDragOver(ev));
    this.lanesEl.addEventListener('drop', (ev) => this.onDrop(ev));
    this.lanesEl.addEventListener('dragleave', () => {
      this.dropIndicatorEl.style.display = 'none';
      for (const entry of this.trackEls.values()) entry.lane.classList.remove('droptarget');
    });

    const resizeObserver = new ResizeObserver(() => this.onResize());
    resizeObserver.observe(this.scrollEl);
  }

  onResize() {
    this.renderRuler();
    this.contentEl.style.width = `${this.contentWidth}px`;
  }

  onScroll() {
    const scrollTop = this.scrollEl.scrollTop;
    this.headersInner.style.transform = `translateY(${-scrollTop}px)`;
    this.session.scrollLeft = this.scrollEl.scrollLeft;
    this.renderRuler();
  }

  setZoom(pxPerSecond, anchorClientX = null) {
    const next = Math.max(MIN_PX_PER_SECOND, Math.min(MAX_PX_PER_SECOND, pxPerSecond));
    if (Math.abs(next - this.pxPerSecond) < 0.001) return;
    let anchorTicks = null;
    if (anchorClientX != null) {
      const rect = this.scrollEl.getBoundingClientRect();
      anchorTicks = this.pxToTicks(anchorClientX - rect.left + this.scrollEl.scrollLeft);
    }
    const viewCenterTicks = anchorTicks ?? this.pxToTicks(this.scrollEl.scrollLeft + this.viewportWidth / 2);
    this.pxPerSecond = next;
    this.zoomSlider.value = String(Math.log(next));
    this.layoutClips();
    this.contentEl.style.width = `${this.contentWidth}px`;
    if (anchorTicks != null) {
      this.scrollEl.scrollLeft = Math.max(0, this.ticksToPx(anchorTicks) - (anchorClientX - this.scrollEl.getBoundingClientRect().left));
    } else {
      this.scrollEl.scrollLeft = Math.max(0, this.ticksToPx(viewCenterTicks) - this.viewportWidth / 2);
    }
    this.renderRuler();
    this.app.session.zoom = next;
  }

  zoomBy(factor, anchorClientX = null) {
    this.setZoom(this.pxPerSecond * factor, anchorClientX);
  }

  zoomToFit() {
    const duration = Math.max(TICKS_PER_SECOND, this.app.projectDuration());
    const px = (this.viewportWidth - 30) / (duration / TICKS_PER_SECOND);
    this.setZoom(px);
    this.scrollEl.scrollLeft = 0;
  }

  scrollToTicks(ticks, center = true) {
    const px = this.ticksToPx(ticks);
    const target = center ? px - this.viewportWidth / 2 : px;
    this.scrollEl.scrollLeft = Math.max(0, target);
  }

  // ----------------------------------------------------------------- ruler --

  renderRuler() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.viewportWidth;
    const canvas = this.rulerCanvas;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(HEADER_H * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEADER_H}px`;
    canvas.style.position = 'absolute';
    canvas.style.left = `${this.scrollEl.scrollLeft}px`;
    canvas.style.top = '0';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEADER_H);
    ctx.fillStyle = '#1a232e';
    ctx.fillRect(0, 0, width, HEADER_H);

    const startTicks = this.pxToTicks(this.scrollEl.scrollLeft);
    const endTicks = this.pxToTicks(this.scrollEl.scrollLeft + width);
    const steps = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    let majorStep = steps[steps.length - 1];
    for (const step of steps) {
      if (step * this.pxPerSecond >= 78) {
        majorStep = step;
        break;
      }
    }
    const minorPerMajor = 5;
    const minorStep = majorStep / minorPerMajor;

    ctx.strokeStyle = '#33465b';
    ctx.fillStyle = '#8ea3ba';
    ctx.font = '10px "Cascadia Mono", monospace';
    ctx.textBaseline = 'top';

    const firstMinor = Math.floor(startTicks / (minorStep * TICKS_PER_SECOND)) * minorStep * TICKS_PER_SECOND;
    for (let t = firstMinor; t <= endTicks; t += minorStep * TICKS_PER_SECOND) {
      const x = Math.round(this.ticksToPx(t) - this.scrollEl.scrollLeft) + 0.5;
      const isMajor = Math.abs(t / (majorStep * TICKS_PER_SECOND) - Math.round(t / (majorStep * TICKS_PER_SECOND))) < 0.001;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 12 : 21);
      ctx.lineTo(x, HEADER_H);
      ctx.strokeStyle = isMajor ? '#4e667f' : '#2c3a49';
      ctx.stroke();
      if (isMajor) {
        const seconds = t / TICKS_PER_SECOND;
        const label = majorStep >= 1
          ? formatTimecode(t, this.store.state.settings.fps)
          : `${seconds.toFixed(2)}s`;
        ctx.fillStyle = '#93a9c0';
        ctx.fillText(label, x + 4, 3);
      }
    }

    // work area bar
    const wa = this.store.state.settings.workArea;
    const fps = this.store.state.settings.fps;
    if (wa && wa.outTicks > wa.inTicks) {
      const x0 = this.ticksToPx(wa.inTicks) - this.scrollEl.scrollLeft;
      const x1 = this.ticksToPx(wa.outTicks) - this.scrollEl.scrollLeft;
      ctx.fillStyle = 'rgba(52, 211, 192, 0.22)';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), HEADER_H);
      ctx.fillStyle = '#34d3c0';
      ctx.fillRect(x0, HEADER_H - 3, Math.max(1, x1 - x0), 3);
    }
    this.workAreaEl.style.display = 'none';
    void fps;
  }

  // --------------------------------------------------------------- render --

  /** Full rebuild of lanes, headers and clips. */
  render() {
    const project = this.store.state;
    clear(this.headersInner);
    clear(this.lanesEl);
    this.trackEls.clear();
    this.clipEls.clear();

    const trackCount = project.tracks.length;
    project.tracks.forEach((track, index) => {
      const lane = el('div.track-lane', {
        class: `${index % 2 ? 'alt' : ''} ${track.locked ? 'locked' : ''} ${track.hidden ? 'hidden-track' : ''}`.trim(),
        style: { height: `${track.height}px` },
        dataset: { trackId: track.id, trackIndex: String(index) },
      });
      const header = this.buildTrackHeader(track, index, trackCount);
      header.style.height = `${track.height}px`;
      const entry = { lane, header, clips: new Map() };
      this.trackEls.set(track.id, entry);
      append(this.headersInner, header);
      append(this.lanesEl, lane);
      this.renderLaneClips(track, entry);
    });

    this.contentEl.style.width = `${this.contentWidth}px`;
    this.scrollEl.scrollLeft = this.session.scrollLeft || 0;
    this.headersInner.style.transform = `translateY(${-this.scrollEl.scrollTop}px)`;
    this.renderRuler();
    this.updatePlayhead();
    this.updateSelectionStyles();
  }

  buildTrackHeader(track, index, trackCount) {
    const def = TRACK_KINDS[track.kind];
    const colors = {
      video: '#4f8fd6', image: '#5cb87f', text: '#d8a13f', audio: '#54b8b6', overlay: '#a07ce0', effect: '#d66868',
    };
    const kindChip = el('span.track-kind', {
      text: def.icon,
      style: { background: colors[track.kind] || '#4f8fd6' },
      title: def.label,
    });
    const nameNode = el('span.track-name', {
      text: track.name,
      title: 'ダブルクリックで名前を変更',
      ondblclick: (ev) => {
        ev.stopPropagation();
        const input = el('input', { value: track.name });
        clear(ev.currentTarget);
        append(ev.currentTarget, input);
        input.focus();
        input.select();
        const commit = () => {
          const next = input.value.trim() || track.name;
          setTrackProp(this.store, track.id, 'name', next, { label: 'トラック名を変更' });
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (kev) => {
          if (kev.key === 'Enter') input.blur();
          if (kev.key === 'Escape') {
            input.value = track.name;
            input.blur();
          }
          kev.stopPropagation();
        });
      },
    });

    const controls = el('div.track-controls');
    const lockBtn = iconButton(track.locked ? 'lock' : 'unlock', {
      title: 'トラックをロック',
      class: track.locked ? 'active' : '',
      onclick: () => toggleTrackFlag(this.store, track.id, 'locked'),
    });
    const visBtn = iconButton(track.hidden ? 'eyeOff' : 'eye', {
      title: '表示/非表示',
      class: track.hidden ? 'active' : '',
      onclick: () => toggleTrackFlag(this.store, track.id, 'hidden'),
    });
    const muteBtn = iconButton(track.muted ? 'mute' : 'speaker', {
      title: 'ミュート',
      class: track.muted ? 'active' : '',
      onclick: () => toggleTrackFlag(this.store, track.id, 'muted'),
    });
    const menuBtn = iconButton('settings', {
      title: 'トラック操作',
      onclick: (ev) => {
        ev.stopPropagation();
        this.showTrackMenu(ev.currentTarget, track, index, trackCount);
      },
    });
    append(controls, [lockBtn, visBtn, muteBtn, menuBtn]);

    const header = el('div.track-header', {
      class: track.id === this.session.selectedTrackId ? 'selected' : '',
      dataset: { trackId: track.id, index: String(index) },
      style: { height: `${track.height}px` },
    }, [kindChip, nameNode, controls]);

    header.addEventListener('pointerdown', (ev) => this.beginTrackReorder(ev, header, index));
    header.addEventListener('mousedown', (ev) => {
      if (ev.target === header || ev.target === nameNode || ev.target === kindChip) {
        this.app.selectTrack(track.id);
      }
    });
    return header;
  }

  renderLaneClips(track, entry) {
    for (const clip of track.clips) {
      const node = this.buildClipElement(track, clip);
      entry.clips.set(clip.id, node);
      this.clipEls.set(clip.id, node);
      append(entry.lane, node);
    }
  }

  buildClipElement(track, clip) {
    const left = this.ticksToPx(clip.startTicks);
    const width = Math.max(2, this.ticksToPx(clip.durationTicks));
    const baseColor = clip.color || CLIP_TYPES[clip.type]?.color || '#2b6cb0';
    const node = el('div.clip', {
      class: [
        clip.enabled ? '' : 'disabled',
        this.session.selection.includes(clip.id) ? 'selected' : '',
      ].join(' '),
      dataset: { clipId: clip.id, trackId: track.id },
      style: {
        left: `${left}px`,
        width: `${width}px`,
        background: `linear-gradient(180deg, ${baseColor}, ${shade(baseColor, -0.28)})`,
      },
    });
    append(node, el('div.clip-label', { text: clip.name }));
    const fxCount = clip.effects?.length || 0;
    const kfCount = Object.keys(clip.keyframes || {}).length;
    if (fxCount || kfCount) {
      append(node, el('div.clip-fx-badge', {
        text: `${fxCount ? `fx${fxCount}` : ''}${fxCount && kfCount ? ' ' : ''}${kfCount ? `kf${kfCount}` : ''}`,
      }));
    }
    if (clipHasAudio(track, clip)) {
      const canvas = el('canvas.clip-wave', { width: 1, height: 1 });
      append(node, canvas);
      this.drawWaveform(canvas, clip, width);
    }
    if (track.kind === 'audio' || clip.type === 'audio' || clip.fades?.inTicks || clip.fades?.outTicks) {
      append(node, [
        el('div.fade-handle.in', { style: { left: `${this.ticksToPx(clip.fades?.inTicks || 0)}px` }, dataset: { fade: 'in' } }),
        el('div.fade-handle.out', { style: { right: `${this.ticksToPx(clip.fades?.outTicks || 0)}px` }, dataset: { fade: 'out' } }),
      ]);
    }
    append(node, [
      el('div.trim-handle.left', { dataset: { trim: 'left' }, title: 'ドラッグでイン点を調整' }),
      el('div.trim-handle.right', { dataset: { trim: 'right' }, title: 'ドラッグでアウト点を調整' }),
    ]);
    return node;
  }

  /** Cheap geometry update without rebuilding the DOM. */
  layoutClips() {
    const project = this.store.state;
    for (const track of project.tracks) {
      const entry = this.trackEls.get(track.id);
      if (!entry) continue;
      entry.lane.style.height = `${track.height}px`;
      for (const clip of track.clips) {
        const node = entry.clips.get(clip.id) || this.clipEls.get(clip.id);
        if (!node) continue;
        node.style.left = `${this.ticksToPx(clip.startTicks)}px`;
        const width = Math.max(2, this.ticksToPx(clip.durationTicks));
        node.style.width = `${width}px`;
        const canvas = node.querySelector('canvas.clip-wave');
        if (canvas) this.drawWaveform(canvas, clip, width);
        const fadeIn = node.querySelector('.fade-handle.in');
        const fadeOut = node.querySelector('.fade-handle.out');
        if (fadeIn) fadeIn.style.left = `${this.ticksToPx(clip.fades?.inTicks || 0)}px`;
        if (fadeOut) fadeOut.style.right = `${this.ticksToPx(clip.fades?.outTicks || 0)}px`;
      }
    }
  }

  drawWaveform(canvas, clip, cssWidth) {
    const peaks = this.app.mediaPool.hasPeaks(clip.assetId);
    if (!peaks) {
      this.app.mediaPool.getPeaks(clip.assetId).then(() => {
        const node = this.clipEls.get(clip.id);
        if (node) {
          const c = node.querySelector('canvas.clip-wave');
          const current = this.store.clipRef(clip.id);
          if (c && current) this.drawWaveform(c, current, Math.max(2, this.ticksToPx(current.durationTicks)));
        }
      }).catch(() => {});
      return;
    }
    const token = `${clip.assetId}:${clip.inTicks}:${clip.durationTicks}:${clip.speed}:${Math.round(cssWidth)}:${peaks.peaksPerSecond}`;
    if (this.waveTokens.get(clip.id) === token) return;
    this.waveTokens.set(clip.id, token);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.min(WAVE_MAX_CANVAS, Math.floor(cssWidth)));
    const h = Math.max(10, canvas.clientHeight || 40);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const speed = Math.max(0.0625, clip.speed || 1);
    const startSeconds = clip.inTicks / TICKS_PER_SECOND;
    const endSeconds = startSeconds + (clip.durationTicks * speed) / TICKS_PER_SECOND;
    const cols = Math.round(w);
    const env = envelopeForWidth(peaks, startSeconds, endSeconds, cols);

    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    const mid = h / 2;
    for (let x = 0; x < cols; x += 1) {
      const lo = env.min[x] * mid;
      const hi = env.max[x] * mid;
      ctx.fillRect(x, mid - hi, 1, Math.max(1, hi - lo));
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let x = 0; x < cols; x += 1) {
      const r = env.rms[x] * mid;
      ctx.fillRect(x, mid - r, 1, Math.max(1, r * 2));
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(0, mid, w, 1);
  }

  updateSelectionStyles() {
    for (const [clipId, node] of this.clipEls) {
      node.classList.toggle('selected', this.session.selection.includes(clipId));
    }
    for (const [trackId, entry] of this.trackEls) {
      entry.header.classList.toggle('selected', this.session.selectedTrackId === trackId);
    }
  }

  updatePlayhead() {
    const x = this.ticksToPx(this.session.playheadTicks);
    this.playheadEl.style.left = `${x}px`;
    this.playheadEl.style.display = 'block';
    this.playheadEl.style.height = `${Math.max(this.lanesEl.scrollHeight, 40)}px`;
  }

  // ------------------------------------------------------------ gestures --

  pointerTicks(ev) {
    const rect = this.scrollEl.getBoundingClientRect();
    const scrollLeft = this.scrollEl.scrollLeft;
    return this.pxToTicks(ev.clientX - rect.left + scrollLeft);
  }

  laneIndexAt(clientY) {
    const lanes = [...this.lanesEl.children];
    for (let i = 0; i < lanes.length; i += 1) {
      const rect = lanes[i].getBoundingClientRect();
      if (clientY >= rect.top && clientY < rect.bottom) return i;
    }
    if (!lanes.length) return 0;
    const first = lanes[0].getBoundingClientRect();
    if (clientY < first.top) return 0;
    return lanes.length - 1;
  }

  beginScrub(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const scrub = (clientX) => {
      const rect = this.scrollEl.getBoundingClientRect();
      let ticks = this.pxToTicks(Math.max(0, clientX - rect.left + this.scrollEl.scrollLeft));
      const snap = this.app.snapValue(ticks, { excludeClipIds: [], disable: ev.altKey });
      this.app.setPlayhead(snap.ticks);
    };
    scrub(ev.clientX);
    const onMove = (mev) => scrub(mev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.app.store.ensureClosed();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  onLanesPointerDown(ev) {
    if (ev.button === 2) return; // context menu handled separately
    const target = ev.target;
    const clipNode = target.closest?.('.clip');
    const lane = target.closest?.('.track-lane');
    if (!lane) return;
    const trackIndex = parseInt(lane.dataset.trackIndex, 10);
    const track = this.store.state.tracks[trackIndex];
    if (!track) return;

    if (clipNode) {
      const clipId = clipNode.dataset.clipId;
      const clip = this.store.clipRef(clipId);
      if (!clip) return;
      this.app.selectTrack(track.id, { silent: true });
      const trimHandle = target.closest('.trim-handle');
      const fadeHandle = target.closest('.fade-handle');
      const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
      if (!this.session.selection.includes(clipId) || additive) {
        this.app.selectClips([clipId], { additive, toggle: ev.ctrlKey || ev.metaKey });
      }
      if (track.locked || clip.locked) {
        this.app.toast('ロックされたトラック/クリップは編集できません', 'warn');
        return;
      }
      ev.preventDefault();
      if (trimHandle) return this.beginTrim(ev, clip, trimHandle.dataset.trim);
      if (fadeHandle) return this.beginFade(ev, clip, fadeHandle.dataset.fade);
      return this.beginClipDrag(ev, clip);
    }

    // Empty lane: marquee select (never moves the playhead).
    this.app.selectTrack(track.id);
    this.beginMarquee(ev, trackIndex);
  }

  onLanesDoubleClick(ev) {
    const clipNode = ev.target.closest?.('.clip');
    if (!clipNode) return;
    const clip = this.store.clipRef(clipNode.dataset.clipId);
    if (!clip) return;
    const track = this.store.state.tracks.find((t) => t.id === clip.trackId);
    if (track && (track.kind === 'text' || clip.type === 'text')) {
      this.app.focusInspectorText(clip.id);
    } else {
      this.app.inspector.setActiveTab('clip');
      this.app.inspector.scrollToSection('clip-time');
    }
  }

  beginClipDrag(ev, anchorClip) {
    const ids = this.session.selection.length && this.session.selection.includes(anchorClip.id)
      ? [...this.session.selection]
      : [anchorClip.id];
    const entries = clipsById(this.store, ids).filter((e) => !e.track.locked && !e.clip.locked);
    if (!entries.length) return;
    const originals = entries.map((e) => ({
      clipId: e.clip.id,
      trackId: e.track.id,
      trackIndex: e.trackIndex,
      startTicks: e.clip.startTicks,
      durationTicks: e.clip.durationTicks,
      type: e.clip.type,
    }));

    const tx = this.store.begin('クリップを移動', { interactive: true });
    tx.touch(['tracks']);
    this.gesture = {
      type: 'move',
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      originals,
      anchorId: anchorClip.id,
      startTicksAtPointer: this.pointerTicks(ev),
      moved: false,
      trackDelta: 0,
      tx,
    };
    this.attachGestureHandlers();
    for (const o of originals) {
      const node = this.clipEls.get(o.clipId);
      node?.classList.add('dragging');
    }
  }

  beginTrim(ev, clip, edge) {
    const tx = this.store.begin('クリップをトリミング', { interactive: true });
    tx.touch(['tracks']);
    this.gesture = {
      type: 'trim',
      pointerId: ev.pointerId,
      startX: ev.clientX,
      edge,
      clipId: clip.id,
      originalStart: clip.startTicks,
      originalDuration: clip.durationTicks,
      originalIn: clip.inTicks,
      startTicksAtPointer: this.pointerTicks(ev),
      moved: false,
      tx,
      node: this.clipEls.get(clip.id),
    };
    this.gesture.node?.classList.add('dragging');
    this.attachGestureHandlers();
  }

  beginFade(ev, clip, side) {
    const tx = this.store.begin('フェードを調整', { interactive: true });
    tx.touch(['tracks']);
    this.gesture = {
      type: 'fade',
      pointerId: ev.pointerId,
      startX: ev.clientX,
      side,
      clipId: clip.id,
      original: side === 'in' ? (clip.fades?.inTicks || 0) : (clip.fades?.outTicks || 0),
      startTicksAtPointer: this.pointerTicks(ev),
      moved: false,
      tx,
      node: this.clipEls.get(clip.id),
    };
    this.attachGestureHandlers();
  }

  beginMarquee(ev, trackIndex) {
    const rect = this.scrollEl.getBoundingClientRect();
    const startX = ev.clientX - rect.left + this.scrollEl.scrollLeft;
    const startY = ev.clientY - rect.top + this.scrollEl.scrollTop;
    this.gesture = {
      type: 'marquee',
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      contentStartX: startX,
      contentStartY: startY,
      additive: ev.shiftKey,
      moved: false,
      baseSelection: ev.shiftKey ? [...this.session.selection] : [],
      trackIndex,
    };
    this.attachGestureHandlers();
  }

  attachGestureHandlers() {
    const onMove = (ev) => this.onGestureMove(ev);
    const onUp = (ev) => this.onGestureEnd(ev);
    this._detachGesture = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  onGestureMove(ev) {
    const g = this.gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    const dx = ev.clientX - g.startX;
    const dy = ev.clientY - g.startY;
    if (!g.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    g.moved = true;

    if (g.type === 'move') this.updateMoveGesture(ev, g, dx, dy);
    else if (g.type === 'trim') this.updateTrimGesture(ev, g);
    else if (g.type === 'fade') this.updateFadeGesture(ev, g);
    else if (g.type === 'marquee') this.updateMarquee(ev, g);
  }

  restoreOriginals(originals) {
    const project = this.store.state;
    for (const o of originals) {
      const found = this.store.findClip(o.clipId);
      if (!found) continue;
      if (found.track.id !== o.trackId) {
        const from = found.track.clips;
        from.splice(from.indexOf(found.clip), 1);
        const targetTrack = project.tracks.find((t) => t.id === o.trackId);
        if (targetTrack) {
          targetTrack.clips.push(found.clip);
          targetTrack.clips.sort((a, b) => a.startTicks - b.startTicks);
        }
      }
      found.clip.startTicks = o.startTicks;
      found.clip.trackId = o.trackId;
    }
  }

  updateMoveGesture(ev, g, dx, dy) {
    const store = this.store;
    const project = store.state;
    this.restoreOriginals(g.originals);

    // Vertical: how many tracks to shift (based on the anchor clip).
    const anchorOriginal = g.originals.find((o) => o.clipId === g.anchorId) || g.originals[0];
    let anchorIndex = Math.max(0, project.tracks.findIndex((t) => t.id === anchorOriginal.trackId));
    const hoverIndex = this.laneIndexAt(ev.clientY);
    const trackDelta = hoverIndex - anchorIndex;
    g.trackDelta = trackDelta;

    const movingIds = new Set(g.originals.map((o) => o.clipId));
    const plan = [];
    for (const o of g.originals) {
      const targetIndex = Math.min(project.tracks.length - 1, Math.max(0, o.trackIndex + trackDelta));
      const targetTrack = project.tracks[targetIndex];
      if (!targetTrack || !canTrackAcceptClip(targetTrack, o.type)) {
        plan.push({ clipId: o.clipId, track: project.tracks[o.trackIndex], trackId: o.trackId, startTicks: o.startTicks, durationTicks: o.durationTicks });
        continue;
      }
      plan.push({
        clipId: o.clipId,
        track: targetTrack,
        trackId: targetTrack.id,
        startTicks: o.startTicks,
        durationTicks: o.durationTicks,
      });
    }

    let delta = this.pointerTicks(ev) - g.startTicksAtPointer;
    const { minDelta, maxDelta } = computeMoveConstraints(plan);
    delta = Math.min(Math.max(delta, minDelta), Math.max(minDelta, maxDelta));

    // Snapping (anchor clip edges + group edges against other clips).
    const snapEnabled = this.session.snapEnabled && !ev.altKey;
    if (snapEnabled) {
      const anchor = plan.find((p) => p.clipId === g.anchorId) || plan[0];
      const threshold = this.pxToTicks(8);
      const candidates = [
        { start: anchor.startTicks + delta, edge: 'start' },
        { start: anchor.startTicks + delta + anchor.durationTicks, edge: 'end' },
      ];
      let best = null;
      for (const cand of candidates) {
        const snap = this.app.snapValue(cand.start, {
          excludeClipIds: [...movingIds],
          thresholdTicks: threshold,
          disable: false,
        });
        if (snap.snapped) {
          const adjustment = snap.ticks - cand.start;
          if (!best || Math.abs(adjustment) < Math.abs(best.adjustment)) best = { adjustment, target: snap.target };
        }
      }
      if (best) {
        delta += best.adjustment;
        this.showSnapGuide(best.target.ticks);
      } else {
        this.hideSnapGuide();
      }
    } else {
      this.hideSnapGuide();
    }
    delta = Math.min(Math.max(delta, minDelta), Math.max(minDelta, maxDelta));

    // Apply: move across tracks then shift in time.
    for (const o of g.originals) {
      const p = plan.find((x) => x.clipId === o.clipId);
      const found = store.findClip(o.clipId);
      if (!found || !p) continue;
      if (found.track.id !== p.trackId) {
        const from = found.track.clips;
        from.splice(from.indexOf(found.clip), 1);
        p.track.clips.push(found.clip);
        p.track.clips.sort((a, b) => a.startTicks - b.startTicks);
        found.clip.trackId = p.trackId;
      }
      found.clip.startTicks = Math.max(0, Math.round(o.startTicks + delta));
    }

    store.notifyLive('move');
    this.layoutClips();
    this.updatePlayheadGeometryForDrag();
  }

  updatePlayheadGeometryForDrag() {
    this.playheadEl.style.height = `${Math.max(this.lanesEl.scrollHeight, 40)}px`;
  }

  updateTrimGesture(ev, g) {
    const store = this.store;
    const found = store.findClip(g.clipId);
    if (!found) return;
    g.appliedDelta = g.appliedDelta || 0;
    // Restore the clip to its original geometry, then apply the whole delta.
    found.clip.startTicks = g.originalStart;
    found.clip.durationTicks = g.originalDuration;
    found.clip.inTicks = g.originalIn;
    const rawDelta = this.pointerTicks(ev) - g.startTicksAtPointer;
    let delta = this.session.snapEnabled && !ev.altKey
      ? this.app.snapValue(g.edge === 'left' ? g.originalStart + rawDelta : g.originalStart + g.originalDuration + rawDelta, {
        excludeClipIds: [g.clipId],
        thresholdTicks: this.pxToTicks(8),
        disable: false,
      }).ticks - (g.edge === 'left' ? g.originalStart : g.originalStart + g.originalDuration)
      : rawDelta;
    delta = delta - g.appliedDelta;
    if (Math.abs(delta) >= 1) {
      const before = JSON.stringify({
        s: found.clip.startTicks, d: found.clip.durationTicks, i: found.clip.inTicks, k: found.clip.keyframes,
      });
      trimClipEdge(store, g.clipId, g.edge, delta, { label: 'クリップをトリミング' });
      const after = JSON.stringify({
        s: found.clip.startTicks, d: found.clip.durationTicks, i: found.clip.inTicks, k: found.clip.keyframes,
      });
      if (before !== after) g.appliedDelta += delta;
    }
    store.notifyLive('trim');
    this.layoutClips();
  }

  updateFadeGesture(ev, g) {
    const store = this.store;
    const found = store.findClip(g.clipId);
    if (!found) return;
    const clip = found.clip;
    const delta = this.pointerTicks(ev) - g.startTicksAtPointer;
    const value = g.side === 'in'
      ? Math.max(0, Math.min(clip.durationTicks, g.original + delta))
      : Math.max(0, Math.min(clip.durationTicks, g.original - delta));
    if (g.side === 'in') clip.fades.inTicks = Math.round(value);
    else clip.fades.outTicks = Math.round(value);
    const node = this.clipEls.get(g.clipId);
    if (node) {
      const inHandle = node.querySelector('.fade-handle.in');
      const outHandle = node.querySelector('.fade-handle.out');
      if (inHandle) inHandle.style.left = `${this.ticksToPx(clip.fades.inTicks)}px`;
      if (outHandle) outHandle.style.right = `${this.ticksToPx(clip.fades.outTicks)}px`;
    }
    store.notifyLive('fade');
  }

  updateMarquee(ev, g) {
    const rect = this.scrollEl.getBoundingClientRect();
    const curX = ev.clientX - rect.left + this.scrollEl.scrollLeft;
    const curY = ev.clientY - rect.top + this.scrollEl.scrollTop;
    const x0 = Math.min(g.contentStartX, curX);
    const x1 = Math.max(g.contentStartX, curX);
    const y0 = Math.min(g.contentStartY, curY);
    const y1 = Math.max(g.contentStartY, curY);
    this.marqueeEl.style.display = 'block';
    this.marqueeEl.style.left = `${x0}px`;
    this.marqueeEl.style.top = `${y0}px`;
    this.marqueeEl.style.width = `${x1 - x0}px`;
    this.marqueeEl.style.height = `${y1 - y0}px`;

    const t0 = this.pxToTicks(x0);
    const t1 = this.pxToTicks(x1);
    const lanes = [...this.lanesEl.children];
    const hit = new Set(g.additive ? g.baseSelection : []);
    for (let i = 0; i < lanes.length; i += 1) {
      const laneRect = lanes[i].getBoundingClientRect();
      const top = laneRect.top - rect.top + this.scrollEl.scrollTop;
      const bottom = laneRect.bottom - rect.top + this.scrollEl.scrollTop;
      if (bottom < y0 || top > y1) continue;
      const track = this.store.state.tracks[i];
      if (!track) continue;
      for (const clip of track.clips) {
        if (clip.startTicks < t1 && clipEnd(clip) > t0) hit.add(clip.id);
      }
    }
    this.session.selection = [...hit];
    this.updateSelectionStyles();
    this.app.onSelectionChanged();
  }

  onGestureEnd(ev) {
    const g = this.gesture;
    if (!g) return;
    this._detachGesture?.();
    this.gesture = null;
    this.hideSnapGuide();
    if (g.type === 'marquee') {
      this.marqueeEl.style.display = 'none';
      return;
    }
    for (const o of g.originals || []) {
      this.clipEls.get(o.clipId)?.classList.remove('dragging');
    }
    if (g.node) g.node.classList.remove('dragging');
    const changed = this.store.commit();
    if (changed) this.app.onProjectChanged({ kind: 'edit', label: g.tx?.label || '' });
    else this.app.requestRender();
    void ev;
  }

  showSnapGuide(ticks) {
    const x = this.ticksToPx(ticks);
    this.snapGuideEl.style.display = 'block';
    this.snapGuideEl.style.left = `${x}px`;
    this.snapGuideEl.style.height = `${Math.max(this.lanesEl.scrollHeight, 40)}px`;
  }

  hideSnapGuide() {
    this.snapGuideEl.style.display = 'none';
  }

  // ------------------------------------------------------- track reorder --

  beginTrackReorder(ev, header, index) {
    if (ev.target.closest('.icon-btn') || ev.target.closest('input')) return;
    const startY = ev.clientY;
    let reorderTo = null;
    const onMove = (mev) => {
      const dy = mev.clientY - startY;
      if (Math.abs(dy) < DRAG_THRESHOLD * 2) return;
      header.classList.add('dragging');
      const laneIndex = this.laneIndexAt(mev.clientY);
      reorderTo = laneIndex;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      header.classList.remove('dragging');
      if (reorderTo != null && reorderTo !== index) {
        reorderTracks(this.store, index, reorderTo);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  showTrackMenu(anchor, track, index, trackCount) {
    const items = [
      { label: '上へ移動', shortcut: '', disabled: index === 0, action: () => reorderTracks(this.store, index, index - 1) },
      { label: '下へ移動', disabled: index === trackCount - 1, action: () => reorderTracks(this.store, index, index + 1) },
      { label: '---' },
      { label: track.locked ? 'ロック解除' : 'ロック', action: () => toggleTrackFlag(this.store, track.id, 'locked') },
      { label: track.hidden ? '表示する' : '非表示にする', action: () => toggleTrackFlag(this.store, track.id, 'hidden') },
      { label: track.muted ? 'ミュート解除' : 'ミュート', action: () => toggleTrackFlag(this.store, track.id, 'muted') },
      { label: '---' },
      { label: 'このトラックを空にする', action: () => this.app.clearTrack(track.id) },
      { label: 'トラックを削除', danger: true, action: () => deleteTrack(this.store, track.id) },
    ];
    contextMenu(anchor, items);
  }

  onContextMenu(ev) {
    const clipNode = ev.target.closest?.('.clip');
    if (!clipNode) {
      const lane = ev.target.closest?.('.track-lane');
      if (!lane) return;
      const index = parseInt(lane.dataset.trackIndex, 10);
      const track = this.store.state.tracks[index];
      if (!track) return;
      ev.preventDefault();
      this.showTrackMenu(ev.target, track, index, this.store.state.tracks.length);
      return;
    }
    ev.preventDefault();
    const clipId = clipNode.dataset.clipId;
    if (!this.session.selection.includes(clipId)) this.app.selectClips([clipId]);
    const clip = this.store.clipRef(clipId);
    if (!clip) return;
    const ids = [...this.session.selection];
    const items = [
      { label: '再生ヘッドで分割', shortcut: 'K', action: () => this.app.splitAtPlayhead() },
      { label: '複製', shortcut: 'Ctrl+D', action: () => this.app.duplicateSelection() },
      { label: '削除', shortcut: 'Del', danger: true, action: () => this.app.deleteSelection() },
      { label: 'リップル削除', action: () => deleteClips(this.store, ids, { ripple: true }) },
      { label: '---' },
      {
        label: clip.enabled ? '無効化' : '有効化',
        action: () => this.store.transact('クリップの有効/無効', () => {
          for (const entry of clipsById(this.store, ids)) {
            this.store.touch(['tracks', entry.trackIndex, 'clips', entry.clipIndex]);
            entry.clip.enabled = !entry.clip.enabled;
          }
        }),
      },
      {
        label: clip.locked ? 'ロック解除' : 'ロック',
        action: () => this.store.transact('クリップのロック', () => {
          for (const entry of clipsById(this.store, ids)) {
            this.store.touch(['tracks', entry.trackIndex, 'clips', entry.clipIndex]);
            entry.clip.locked = !entry.clip.locked;
          }
        }),
      },
      { label: '---' },
      { label: 'クリップの先頭を再生ヘッドへ', action: () => this.snapClipToPlayhead(ids, 'start') },
      { label: 'クリップの末尾を再生ヘッドへ', action: () => this.snapClipToPlayhead(ids, 'end') },
      { label: 'プロパティを表示', action: () => { this.app.inspector.setActiveTab('clip'); this.app.inspector.scrollToSection('clip-time'); } },
    ];
    contextMenu(ev.target, items);
  }

  onRulerContextMenu(ev) {
    ev.preventDefault();
    const ticks = Math.max(0, Math.round(this.pointerTicks(ev)));
    contextMenu(ev.target, [
      { label: 'マーカーを追加', action: () => this.app.addMarkerAt(ticks) },
      { label: 'ここに再生ヘッドを移動', action: () => this.app.setPlayhead(ticks) },
      { label: '---' },
      { label: 'ワークエリア開始 (I)', action: () => this.app.setWorkAreaIn(ticks) },
      { label: 'ワークエリア終了 (O)', action: () => this.app.setWorkAreaOut(ticks) },
      { label: 'ワークエリアをクリア', action: () => this.app.clearWorkArea() },
    ]);
  }

  snapClipToPlayhead(ids, which) {
    const playhead = this.session.playheadTicks;
    this.store.transact(which === 'start' ? 'クリップを再生ヘッドへ移動' : 'クリップの末尾を再生ヘッドへ', () => {
      for (const entry of clipsById(this.store, ids)) {
        this.store.touch(['tracks', entry.trackIndex, 'clips', entry.clipIndex]);
        if (which === 'start') entry.clip.startTicks = Math.max(0, Math.round(playhead));
        else entry.clip.startTicks = Math.max(0, Math.round(playhead - entry.clip.durationTicks));
      }
    });
  }

  // ---------------------------------------------------------- media drop --

  onDragOver(ev) {
    if (!ev.dataTransfer?.types?.includes('application/x-qelvoryn-asset')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    const lane = ev.target.closest?.('.track-lane');
    for (const entry of this.trackEls.values()) entry.lane.classList.toggle('droptarget', entry.lane === lane);
    const ticks = Math.max(0, this.pointerTicks(ev));
    this.dropIndicatorEl.style.display = 'block';
    this.dropIndicatorEl.style.left = `${this.ticksToPx(ticks)}px`;
    this.dropIndicatorEl.style.height = `${Math.max(this.lanesEl.scrollHeight, 40)}px`;
  }

  onDrop(ev) {
    const assetId = ev.dataTransfer?.getData('application/x-qelvoryn-asset');
    this.dropIndicatorEl.style.display = 'none';
    for (const entry of this.trackEls.values()) entry.lane.classList.remove('droptarget');
    if (!assetId) return;
    ev.preventDefault();
    const lane = ev.target.closest?.('.track-lane');
    const index = lane ? parseInt(lane.dataset.trackIndex, 10) : -1;
    const ticks = Math.max(0, Math.round(this.pointerTicks(ev)));
    this.app.addAssetToTimeline(assetId, { trackIndex: index, ticks });
  }
}

function shade(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'rgba(0,0,0,0.3)';
  const v = parseInt(m[1], 16);
  const parts = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const next = amount < 0 ? c * (1 + amount) : c + (255 - c) * amount;
    return Math.max(0, Math.min(255, Math.round(next)));
  });
  return `rgb(${parts.join(',')})`;
}

function clipHasAudio(track, clip) {
  if (clip.type === 'audio') return true;
  if (track.kind === 'audio' && clip.assetId) return true;
  return false;
}

export { createClip, insertClip, splitAt, duplicateClips, formatNumber, parseTimecode, snapTicksToFrame, selectedClips, addTrack, icon };
