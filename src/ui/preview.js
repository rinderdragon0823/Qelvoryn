/**
 * Preview panel: the program monitor.
 *
 * Rendering always goes through the shared compositor.  While playing we use
 * the video elements as they are (the playback controller keeps them locked to
 * the audio clock); while paused we render frame-exact so scrubbing shows the
 * precise picture.
 */

import { el, append, icon, iconButton, button, formatNumber } from './dom.js';
import { renderFrame, MediaFrameSource } from '../engine/compositor.js';
import { formatTimecode, parseTimecode, ticksToFrames } from '../core/time.js';
import { contextMenu } from './menu.js';

export class PreviewView {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.session = app.session;
    this.scale = 1;
    this.volume = 1;
    this.rendering = false;
    this.pending = null;
    this.lastFrameDrawn = 0;
    this.source = new MediaFrameSource(app.mediaPool, { exact: true });
    this.build();
  }

  build() {
    this.root = el('div.panel', { id: 'panel-preview' });
    this.canvas = el('canvas.preview-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.hud = el('div.preview-hud', { text: 'プレビュー' });
    this.stage = el('div.preview-stage', {}, [this.canvas, this.hud]);

    const header = el('div.panel-header', {}, [
      el('span', { text: 'プログラムモニター' }),
      el('span.spacer'),
      el('span', { id: 'preview-res', text: '' }),
    ]);

    this.playBtn = iconButton('play', { size: 18, title: '再生 / 一時停止 (Space)', onclick: () => this.app.togglePlay() });
    this.timecodeEl = this.buildTimecode();
    this.durationLabel = el('span', { style: { color: 'var(--text-2)', fontFamily: 'var(--mono)' }, text: '/ 00:00:00:00' });

    this.qualitySelect = el('select.input.select', { style: { width: '92px' }, title: 'プレビュー品質' });
    for (const [value, label] of [['1', 'フル品質'], ['0.5', '1/2'], ['0.25', '1/4']]) {
      append(this.qualitySelect, el('option', { value, text: label }));
    }
    this.qualitySelect.value = String(this.session.previewScale || 1);
    this.qualitySelect.addEventListener('change', () => {
      this.session.previewScale = parseFloat(this.qualitySelect.value);
      this.resize();
      this.app.requestRender();
    });

    this.volumeSlider = el('input.zoom-slider', {
      type: 'range', min: 0, max: 1.5, step: 0.01, value: this.volume, title: 'モニター音量',
      style: { width: '86px' },
    });
    this.volumeSlider.addEventListener('input', () => {
      this.volume = parseFloat(this.volumeSlider.value);
      this.app.playback.setVolume(this.volume);
    });

    this.transport = el('div.transport', {}, [
      iconButton('start', { title: '先頭へ (Home)', onclick: () => this.app.setPlayhead(0) }),
      iconButton('prevFrame', { title: '1フレーム戻る (←)', onclick: () => this.app.stepFrames(-1) }),
      this.playBtn,
      iconButton('nextFrame', { title: '1フレーム進む (→)', onclick: () => this.app.stepFrames(1) }),
      iconButton('end', { title: '末尾へ (End)', onclick: () => this.app.setPlayhead(this.app.projectDuration()) }),
      el('div.toolbar-sep'),
      this.timecodeEl,
      this.durationLabel,
      el('div.spacer'),
      el('span', { style: { fontSize: '10px', color: 'var(--text-2)' }, text: '品質' }),
      this.qualitySelect,
      el('span', { style: { fontSize: '10px', color: 'var(--text-2)' }, text: '音量' }),
      this.volumeSlider,
      iconButton('settings', { title: 'プロジェクト設定', onclick: () => this.app.showProjectSettings() }),
    ]);

    this.wrap = el('div.preview-wrap', {}, [this.stage, this.transport]);
    append(this.root, [header, this.wrap]);
    this.resize();

    this.canvas.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      contextMenu(ev.target, [
        { label: 'この位置をフレーム書き出し (PNG)', action: () => this.app.exportStill(this.session.playheadTicks) },
        { label: '---' },
        { label: 'プレビュー品質: フル', action: () => { this.qualitySelect.value = '1'; this.qualitySelect.dispatchEvent(new Event('change')); } },
        { label: 'プレビュー品質: 1/2', action: () => { this.qualitySelect.value = '0.5'; this.qualitySelect.dispatchEvent(new Event('change')); } },
        { label: 'プレビュー品質: 1/4', action: () => { this.qualitySelect.value = '0.25'; this.qualitySelect.dispatchEvent(new Event('change')); } },
      ]);
    });
  }

  buildTimecode() {
    const display = el('div.timecode-display', { title: 'クリックして数値入力 (HH:MM:SS:FF)' });
    this.renderTimecodeInput(display, false);
    display.addEventListener('click', () => {
      if (display.querySelector('input')) return;
      this.renderTimecodeInput(display, true);
    });
    return display;
  }

  renderTimecodeInput(display, editing) {
    const project = this.store.state;
    const text = formatTimecode(this.session.playheadTicks, project.settings.fps);
    if (!editing) {
      display.textContent = text;
      return;
    }
    const input = el('input', { value: text });
    display.textContent = '';
    append(display, input);
    input.focus();
    input.select();
    const commit = () => {
      const ticks = parseTimecode(input.value, project.settings.fps);
      if (ticks != null && Number.isFinite(ticks)) this.app.setPlayhead(Math.max(0, ticks));
      this.renderTimecodeInput(display, false);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') {
        input.value = text;
        input.blur();
      }
      ev.stopPropagation();
    });
  }

  resize() {
    const project = this.store.state;
    const scale = this.session.previewScale || 1;
    const w = Math.max(16, Math.round(project.settings.width * scale));
    const h = Math.max(16, Math.round(project.settings.height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const res = document.getElementById('preview-res');
    if (res) res.textContent = `${project.settings.width}×${project.settings.height} ${formatNumber(project.settings.fps, 3)}fps`;
    this.updateTimecode();
  }

  updateTimecode() {
    const project = this.store.state;
    const display = this.timecodeEl;
    if (!display.querySelector('input')) {
      display.textContent = formatTimecode(this.session.playheadTicks, project.settings.fps);
    }
    this.durationLabel.textContent = `/ ${formatTimecode(this.app.projectDuration(), project.settings.fps)}`;
    this.playBtn.replaceChildren(icon(this.app.playback.isPlaying ? 'pause' : 'play', 18));
    this.playBtn.title = this.app.playback.isPlaying ? '一時停止 (Space)' : '再生 (Space)';
  }

  /** Render the current playhead position. */
  requestRender(opts = {}) {
    this.pending = opts.force ? { force: true } : (this.pending || {});
    if (this.pending.scheduled) return;
    this.pending.scheduled = true;
    requestAnimationFrame(() => {
      const pending = this.pending || {};
      this.pending = null;
      this.renderNow(pending).catch((err) => console.warn('[Qelvoryn] preview render failed', err));
    });
  }

  async renderNow(opts = {}) {
    if (this.rendering) {
      this.pending = this.pending || {};
      this.requestRender(opts);
      return;
    }
    this.rendering = true;
    try {
      const project = this.store.state;
      const scale = this.session.previewScale || 1;
      this.source.exact = !this.app.playback.isPlaying;
      this.source.errors.length = 0;
      await renderFrame({
        ctx: this.ctx,
        project,
        timeTicks: this.session.playheadTicks,
        source: this.source,
        scale,
      });
      this.lastFrameDrawn = performance.now();
      this.updateHud();
      if (this.source.errors.length) {
        this.app.setStatus(`プレビュー警告: ${this.source.errors[0].message}`, 'warn');
      }
    } finally {
      this.rendering = false;
      if (this.pending) this.requestRender();
    }
  }

  updateHud() {
    const project = this.store.state;
    const frame = Math.max(0, Math.round(ticksToFrames(this.session.playheadTicks, project.settings.fps)));
    const total = Math.max(0, Math.round(ticksToFrames(this.app.projectDuration(), project.settings.fps)));
    this.hud.textContent = `${formatTimecode(this.session.playheadTicks, project.settings.fps)}  frame ${frame}/${total}`;
  }

  /** Called by the playback loop with the master clock position. */
  onPlaybackTime(ticks) {
    this.session.playheadTicks = Math.round(ticks);
    this.updateTimecode();
    this.updateHud();
    this.app.timeline.updatePlayhead();
    this.requestRender();
  }

  onPlaybackStopped() {
    this.updateTimecode();
    this.requestRender({ force: true });
  }
}

export { button };
