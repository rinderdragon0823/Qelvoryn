/**
 * Inspector: clip / track / project properties, effect stack and the
 * keyframe editor.  Numeric rows are keyframe-aware: once a parameter has
 * keyframes, editing the value writes a keyframe at the playhead instead of
 * the static value (and the diamond button toggles keyframes explicitly).
 */

import { el, append, clear, icon, iconButton, button } from './dom.js';
import { numberField, colorField, selectField, checkField, textField, textareaField, section } from './widgets.js';
import { contextMenu } from './menu.js';
import { BLEND_MODES, CLIP_TYPES, TRACK_KINDS } from '../core/model.js';
import {
  setParamValue, toggleKeyframe, setClipTiming, setClipSpeed, setTrackProp,
  addEffect, removeEffect, toggleEffect, moveEffect, setEffectParam, resetEffect,
  clearClipKeyframes, setKeyframeValue, setKeyframeInterpolation, removeKeyframeById,
  moveKeyframeTo, splitAt, duplicateClips, deleteClips,
} from '../core/commands.js';
import { animatableParams, paramSpec, paramValue, localTicksFor } from './params.js';
import { getKeyframeList, isAnimated, sampleKeyframes, INTERPOLATIONS, evaluateParam } from '../core/keyframes.js';
import { effectsForClipType, EFFECT_DEFS, EFFECT_CATEGORIES, getEffectDef } from '../engine/effectdefs.js';
import { TICKS_PER_SECOND, formatTimecode, parseTimecode, formatDuration } from '../core/time.js';

const TABS = [
  { id: 'clip', label: 'クリップ' },
  { id: 'effects', label: 'エフェクト' },
  { id: 'keyframes', label: 'キーフレーム' },
  { id: 'project', label: 'プロジェクト' },
];

export class Inspector {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.session = app.session;
    this.activeTab = 'clip';
    this.refreshers = [];
    this.activeKeyframePath = null;
    this.build();
  }

  build() {
    this.root = el('div.panel', { id: 'panel-inspector' });
    this.tabsEl = el('div.tabs');
    for (const tab of TABS) {
      append(this.tabsEl, el('div.tab', {
        class: tab.id === this.activeTab ? 'active' : '',
        dataset: { tab: tab.id },
        text: tab.label,
        onclick: () => this.setActiveTab(tab.id),
      }));
    }
    this.bodyEl = el('div.panel-body');
    append(this.root, [this.tabsEl, this.bodyEl]);
    this.render();
  }

  setActiveTab(tab) {
    this.activeTab = tab;
    for (const node of this.tabsEl.children) {
      node.classList.toggle('active', node.dataset.tab === tab);
    }
    this.render();
  }

  scrollToSection(id) {
    const node = this.bodyEl.querySelector(`[data-section="${id}"]`);
    if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  get selectedClipIds() {
    return this.session.selection.slice(0, 40);
  }

  primaryClip() {
    for (const id of this.selectedClipIds) {
      const clip = this.store.clipRef(id);
      if (clip) return clip;
    }
    return null;
  }

  // ------------------------------------------------------------- helpers --

  registerRefresher(fn) {
    this.refreshers.push(fn);
  }

  refreshValues() {
    for (const fn of this.refreshers) {
      try {
        fn();
      } catch (err) {
        console.warn('[Qelvoryn] inspector refresh failed', err);
      }
    }
  }

  /**
   * A numeric parameter row with a keyframe diamond.
   * Works on every selected clip; displays the primary clip's value.
   */
  paramRow(clipId, path, overrides = {}) {
    const spec = { ...paramSpec(path), ...overrides };
    const wrap = el('div.row.param-row');
    const kfBtn = el('button.kf-btn', { text: '◆', title: 'キーフレームを追加/削除' });
    const clip = this.store.clipRef(clipId);
    const field = numberField({
      label: spec.label,
      value: Number(paramValue(clip, path, this.session.playheadTicks)) || 0,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      digits: spec.digits,
      unit: spec.unit,
      onChange: (value) => {
        setParamValue(this.store, this.selectedClipIds, path, value, {
          playheadTicks: this.session.playheadTicks,
          label: `${spec.label}を変更`,
        });
      },
    });
    kfBtn.addEventListener('click', () => {
      toggleKeyframe(this.store, clipId, path, this.session.playheadTicks);
      this.render();
    });
    kfBtn.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      contextMenu(ev.target, [
        { label: 'このプロパティのキーフレームを全て削除', action: () => clearClipKeyframes(this.store, clipId, path) },
        { label: 'キーフレーム編集を開く', action: () => { this.activeKeyframePath = path; this.setActiveTab('keyframes'); } },
      ]);
    });
    append(wrap, [kfBtn, field.node]);

    const refresh = () => {
      const current = this.store.clipRef(clipId);
      if (!current) return;
      const animated = isAnimated(current, path);
      const value = Number(paramValue(current, path, this.session.playheadTicks));
      field.setValue(Number.isFinite(value) ? value : 0);
      const list = getKeyframeList(current, path);
      const local = localTicksFor(current, this.session.playheadTicks);
      const atKey = !!list?.some((kf) => Math.abs(kf.t - local) <= 1);
      kfBtn.classList.toggle('animated', animated);
      kfBtn.classList.toggle('at-key', atKey);
      kfBtn.title = animated
        ? `キーフレーム ${list.length} 個 (クリックで現在位置に追加/削除)`
        : 'クリックでキーフレームを追加';
    };
    refresh();
    this.registerRefresher(refresh);
    return wrap;
  }

  /** Timecode-style field for start / duration / in point. */
  timeRow(label, clipId, kind) {
    const input = el('input.input', { type: 'text' });
    const wrap = el('div.field', {}, [el('span.field-label', { text: label, title: 'HH:MM:SS:FF または秒で入力' }), el('div.input-wrap', {}, [input])]);
    const read = () => {
      const clip = this.store.clipRef(clipId);
      if (!clip) return null;
      if (kind === 'start') return clip.startTicks;
      if (kind === 'duration') return clip.durationTicks;
      if (kind === 'in') return clip.inTicks;
      if (kind === 'out') return clip.inTicks + Math.round(clip.durationTicks * (clip.speed || 1));
      if (kind === 'end') return clip.startTicks + clip.durationTicks;
      return 0;
    };
    const display = () => {
      const ticks = read();
      if (ticks == null) return '';
      input.value = `${formatTimecode(ticks, this.store.state.settings.fps)}  (${(ticks / TICKS_PER_SECOND).toFixed(3)}s)`;
    };
    input.addEventListener('focus', () => {
      const ticks = read();
      if (ticks != null) input.value = (ticks / TICKS_PER_SECOND).toFixed(3);
      input.select();
    });
    input.addEventListener('blur', () => {
      const ticks = parseTimecode(input.value, this.store.state.settings.fps);
      if (ticks != null && Number.isFinite(ticks)) {
        if (kind === 'start') setClipTiming(this.store, clipId, { startTicks: ticks }, { label: '開始位置を変更' });
        else if (kind === 'duration') setClipTiming(this.store, clipId, { durationTicks: ticks }, { label: '長さを変更' });
        else if (kind === 'in') setClipTiming(this.store, clipId, { inTicks: ticks }, { label: 'イン点を変更' });
        else if (kind === 'end') {
          const clip = this.store.clipRef(clipId);
          setClipTiming(this.store, clipId, { durationTicks: Math.max(1, ticks - clip.startTicks) }, { label: '長さを変更' });
        }
      }
      display();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') {
        display();
        input.blur();
      }
      ev.stopPropagation();
    });
    display();
    this.registerRefresher(() => {
      if (document.activeElement !== input) display();
    });
    return wrap;
  }

  /** Text input that opens one undo transaction per editing session. */
  liveTextField(label, clipId, path, opts = {}) {
    const clip = this.store.clipRef(clipId);
    const get = () => {
      const segs = path.split('.');
      let cur = this.store.clipRef(clipId);
      for (const seg of segs) cur = cur?.[seg];
      return cur ?? '';
    };
    const input = el(opts.multiline ? 'textarea.input.textarea' : 'input.input.text', opts.multiline ? { rows: opts.rows || 3 } : { type: 'text' });
    input.value = get();
    let tx = null;
    const begin = () => {
      if (tx) return;
      const found = this.store.findClip(clipId);
      if (!found) return;
      tx = this.store.begin(opts.label || 'テキストを編集');
      tx.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
    };
    const apply = (value) => {
      begin();
      if (!tx) return;
      const node = this.store.clipRef(clipId);
      const segs = path.split('.');
      let cur = node;
      for (let i = 0; i < segs.length - 1; i += 1) {
        if (cur[segs[i]] == null) cur[segs[i]] = {};
        cur = cur[segs[i]];
      }
      cur[segs.at(-1)] = value;
      this.store.notifyLive('text');
    };
    input.addEventListener('input', () => apply(input.value));
    input.addEventListener('blur', () => {
      if (tx) {
        tx.commit();
        tx = null;
      }
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        input.value = get();
        ev.stopPropagation();
      }
      if (ev.key === 'Enter' && !opts.multiline) input.blur();
      if (!opts.multiline) ev.stopPropagation();
    });
    const wrap = el('div.field', {}, [
      el('span.field-label', { text: label }),
      el('div.input-wrap', {}, [input]),
    ]);
    this.registerRefresher(() => {
      if (document.activeElement !== input) input.value = get();
    });
    void clip;
    return wrap;
  }

  // -------------------------------------------------------------- render --

  render() {
    this.refreshers = [];
    clear(this.bodyEl);
    const clip = this.primaryClip();
    if (this.activeTab === 'project') {
      this.renderProject();
      return;
    }
    if (!clip) {
      this.renderNoSelection();
      return;
    }
    if (this.activeTab === 'clip') this.renderClipTab(clip);
    else if (this.activeTab === 'effects') this.renderEffectsTab(clip);
    else if (this.activeTab === 'keyframes') this.renderKeyframesTab(clip);
  }

  renderNoSelection() {
    const track = this.store.state.tracks.find((t) => t.id === this.session.selectedTrackId);
    if (track) {
      this.renderTrackPanel(track);
      return;
    }
    append(this.bodyEl, el('div.inspector-empty', {}, [
      el('div', { text: 'クリップを選択するとプロパティを編集できます。' }),
      el('div', { html: 'タイムラインで <span class="kbd">Shift</span>/<span class="kbd">Ctrl</span> クリックで複数選択、空き領域のドラッグで範囲選択できます。' }),
      el('div', { style: { marginTop: '10px' }, text: 'トラックのヘッダーを選択するとトラック設定が表示されます。' }),
    ]));
  }

  renderTrackPanel(track) {
    const t = section(`トラック: ${track.name}`, {});
    append(t.body, [
      textField({
        label: '名前',
        value: track.name,
        onChange: (v) => setTrackProp(this.store, track.id, 'name', v, { label: 'トラック名を変更' }),
      }).node,
      el('div.field', {}, [
        el('span.field-label', { text: '種類' }),
        el('span.keyframe-track-info', { text: TRACK_KINDS[track.kind]?.label || track.kind }),
      ]),
      numberField({
        label: '不透明度', value: track.opacity ?? 1, min: 0, max: 1, step: 0.01, digits: 2,
        onChange: (v) => setTrackProp(this.store, track.id, 'opacity', v, { label: 'トラック不透明度' }),
      }).node,
      numberField({
        label: '音量', value: track.volume ?? 1, min: 0, max: 2, step: 0.01, digits: 2,
        onChange: (v) => setTrackProp(this.store, track.id, 'volume', v, { label: 'トラック音量' }),
      }).node,
      numberField({
        label: '高さ', value: track.height, min: 40, max: 300, step: 1, digits: 0,
        onChange: (v) => setTrackProp(this.store, track.id, 'height', v, { label: 'トラック高さ' }),
      }).node,
      selectField({
        label: '合成モード', value: track.blendMode || 'source-over', options: BLEND_MODES,
        onChange: (v) => setTrackProp(this.store, track.id, 'blendMode', v, { label: 'トラック合成モード' }),
      }).node,
      el('div.row', {}, [
        checkField({ label: 'ロック', value: track.locked, onChange: (v) => setTrackProp(this.store, track.id, 'locked', v, { label: 'ロック' }) }).node,
        checkField({ label: '非表示', value: track.hidden, onChange: (v) => setTrackProp(this.store, track.id, 'hidden', v, { label: '表示' }) }).node,
        checkField({ label: 'ミュート', value: track.muted, onChange: (v) => setTrackProp(this.store, track.id, 'muted', v, { label: 'ミュート' }) }).node,
      ]),
      el('div.hint', { text: `クリップ数: ${track.clips.length}` }),
    ]);
    append(this.bodyEl, t.node);
  }

  renderClipTab(clip) {
    const store = this.store;
    // ---- basic
    const basic = section('基本', {});
    append(basic.body, [
      textField({
        label: '名前', value: clip.name,
        onChange: (v) => {
          store.transact('クリップ名を変更', () => {
            for (const id of this.selectedClipIds) {
              const found = store.findClip(id);
              if (!found) continue;
              store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
              found.clip.name = v;
            }
          });
        },
      }).node,
      el('div.field', {}, [
        el('span.field-label', { text: '種類' }),
        el('span.keyframe-track-info', { text: `${CLIP_TYPES[clip.type]?.label || clip.type} / 素材: ${clip.assetId ? (store.state.assets[clip.assetId]?.name || '不明') : 'なし'}` }),
      ]),
      el('div.row', {}, [
        checkField({
          label: '有効', value: clip.enabled,
          onChange: (v) => store.transact('クリップの有効/無効', () => {
            for (const id of this.selectedClipIds) {
              const found = store.findClip(id);
              if (!found) continue;
              store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
              found.clip.enabled = v;
            }
          }),
        }).node,
        checkField({
          label: 'ロック', value: clip.locked,
          onChange: (v) => store.transact('クリップのロック', () => {
            for (const id of this.selectedClipIds) {
              const found = store.findClip(id);
              if (!found) continue;
              store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
              found.clip.locked = v;
            }
          }),
        }).node,
      ]),
    ]);
    append(this.bodyEl, basic.node);

    // ---- timing
    const time = section('時間', {});
    append(time.body, [
      this.timeRow('開始', clip.id, 'start'),
      this.timeRow('長さ', clip.id, 'duration'),
      this.timeRow('イン点', clip.id, 'in'),
      this.timeRow('アウト点', clip.id, 'out'),
      this.timeRow('終了', clip.id, 'end'),
      numberField({
        label: '再生速度', value: clip.speed, min: 0.1, max: 8, step: 0.01, digits: 2, unit: 'x',
        onChange: (v) => setClipSpeed(store, clip.id, v),
      }).node,
      selectField({
        label: 'フィット', value: clip.fit || 'contain',
        options: [
          { value: 'contain', label: '全体を収める' },
          { value: 'cover', label: '余白なく埋める' },
          { value: 'stretch', label: '引き伸ばす' },
          { value: 'none', label: '原寸' },
        ],
        onChange: (v) => setParamValue(store, this.selectedClipIds, 'fit', v, { label: 'フィットを変更' }),
      }).node,
      el('div.row', {}, [
        button('分割', { onclick: () => this.app.splitAtPlayhead() }),
        button('複製', { onclick: () => duplicateClips(store, this.selectedClipIds, {}) }),
        button('削除', { variant: 'danger', onclick: () => deleteClips(store, this.selectedClipIds, {}) }),
      ]),
    ]);
    time.node.dataset.section = 'clip-time';
    append(this.bodyEl, time.node);

    // ---- transform
    const transform = section('変形', {
      actions: iconButton('undo', {
        size: 13, title: '変形をリセット',
        onclick: () => {
          store.transact('変形をリセット', () => {
            for (const id of this.selectedClipIds) {
              const found = store.findClip(id);
              if (!found) continue;
              store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
              found.clip.transform = { x: 0.5, y: 0.5, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 };
            }
          });
        },
      }),
    });
    for (const path of ['transform.x', 'transform.y', 'transform.scaleX', 'transform.scaleY', 'transform.rotation']) {
      append(transform.body, this.paramRow(clip.id, path));
    }
    append(transform.body, el('div.row', {}, [
      this.paramRow(clip.id, 'transform.anchorX', { label: 'アンカーX' }),
      this.paramRow(clip.id, 'transform.anchorY', { label: 'アンカーY' }),
    ]));
    append(transform.body, [
      button('スケールをリンク', {
        title: 'スケールX/Yを同じ値にする',
        onclick: () => {
          const current = this.store.clipRef(clip.id);
          setParamValue(store, this.selectedClipIds, 'transform.scaleY', current.transform.scaleX, { label: 'スケールをリンク' });
        },
      }),
    ]);
    append(this.bodyEl, transform.node);

    // ---- composite
    const composite = section('合成', {});
    append(composite.body, [
      this.paramRow(clip.id, 'opacity'),
      selectField({
        label: 'ブレンドモード', value: clip.blendMode || 'source-over', options: BLEND_MODES,
        onChange: (v) => setParamValue(store, this.selectedClipIds, 'blendMode', v, { label: 'ブレンドモードを変更' }),
      }).node,
    ]);
    const cropRow = el('div.row', {}, [
      this.paramRow(clip.id, 'crop.left', { label: '左' }),
      this.paramRow(clip.id, 'crop.right', { label: '右' }),
    ]);
    append(composite.body, [
      el('div.hint', { text: 'クロップ (素材の端を切り取る)' }),
      cropRow,
      el('div.row', {}, [
        this.paramRow(clip.id, 'crop.top', { label: '上' }),
        this.paramRow(clip.id, 'crop.bottom', { label: '下' }),
      ]),
      button('クロップをリセット', {
        onclick: () => {
          store.transact('クロップをリセット', () => {
            for (const id of this.selectedClipIds) {
              const found = store.findClip(id);
              if (!found) continue;
              store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
              found.clip.crop = { left: 0, right: 0, top: 0, bottom: 0 };
            }
          });
        },
      }),
    ]);
    append(this.bodyEl, composite.node);

    // ---- mask
    const mask = section('マスク', {});
    const maskNode = checkField({
      label: 'マスクを有効化', value: clip.mask?.enabled,
      onChange: (v) => store.transact('マスク設定', () => {
        for (const id of this.selectedClipIds) {
          const found = store.findClip(id);
          if (!found) continue;
          store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
          found.clip.mask.enabled = v;
        }
      }),
    });
    append(mask.body, maskNode.node);
    append(mask.body, selectField({
      label: '形状', value: clip.mask?.type || 'rect',
      options: [{ value: 'rect', label: '矩形' }, { value: 'ellipse', label: '楕円' }],
      onChange: (v) => store.transact('マスク形状', () => {
        for (const id of this.selectedClipIds) {
          const found = store.findClip(id);
          if (!found) continue;
          store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
          found.clip.mask.type = v;
        }
      }),
    }).node);
    for (const path of ['mask.x', 'mask.y', 'mask.w', 'mask.h', 'mask.feather', 'mask.round']) {
      append(mask.body, this.paramRow(clip.id, path));
    }
    append(mask.body, checkField({
      label: 'マスクを反転', value: clip.mask?.invert,
      onChange: (v) => store.transact('マスク反転', () => {
        for (const id of this.selectedClipIds) {
          const found = store.findClip(id);
          if (!found) continue;
          store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
          found.clip.mask.invert = v;
        }
      }),
    }).node);
    append(this.bodyEl, mask.node);

    // ---- text
    if (clip.type === 'text') {
      const t = section('テキスト', {});
      append(t.body, [
        this.liveTextField('内容', clip.id, 'text.content', { multiline: true, rows: 3, label: 'テキストを編集' }),
        selectField({
          label: 'フォント', value: clip.text.fontFamily,
          options: [
            { value: 'Noto Sans JP, sans-serif', label: 'Noto Sans JP' },
            { value: 'sans-serif', label: 'サンセリフ' },
            { value: 'serif', label: 'セリフ' },
            { value: 'monospace', label: '等幅' },
            { value: '"Hiragino Sans", sans-serif', label: 'ヒラギノ角ゴ' },
            { value: '"Yu Gothic", sans-serif', label: '游ゴシック' },
          ],
          onChange: (v) => this.applyTextProp(clip.id, 'fontFamily', v),
        }).node,
        numberField({
          label: '太さ', value: clip.text.fontWeight, min: 100, max: 900, step: 100, digits: 0,
          onChange: (v) => this.applyTextProp(clip.id, 'fontWeight', v),
        }).node,
        colorField({ label: '文字色', value: clip.text.color, onChange: (v) => this.applyTextProp(clip.id, 'color', v) }).node,
        selectField({
          label: '揃え', value: clip.text.align,
          options: [{ value: 'center', label: '中央' }, { value: 'left', label: '左' }, { value: 'right', label: '右' }],
          onChange: (v) => this.applyTextProp(clip.id, 'align', v),
        }).node,
        this.paramRow(clip.id, 'text.fontSize'),
        this.paramRow(clip.id, 'text.lineHeight'),
        this.paramRow(clip.id, 'text.letterSpacing'),
        this.paramRow(clip.id, 'text.maxWidth'),
        this.paramRow(clip.id, 'text.strokeWidth'),
        colorField({ label: '縁取り色', value: clip.text.strokeColor, onChange: (v) => this.applyTextProp(clip.id, 'strokeColor', v) }).node,
      ]);
      const shadow = section('テキスト背景と影', { collapsed: true });
      append(shadow.body, [
        checkField({ label: '背景を表示', value: clip.text.background?.enabled, onChange: (v) => this.applyTextProp(clip.id, 'background.enabled', v) }).node,
        colorField({ label: '背景色', value: clip.text.background?.color, onChange: (v) => this.applyTextProp(clip.id, 'background.color', v) }).node,
        this.paramRow(clip.id, 'text.background.alpha'),
        this.paramRow(clip.id, 'text.background.padding'),
        this.paramRow(clip.id, 'text.background.radius'),
        checkField({ label: '影を表示', value: clip.text.shadow?.enabled, onChange: (v) => this.applyTextProp(clip.id, 'shadow.enabled', v) }).node,
        this.paramRow(clip.id, 'text.shadow.x'),
        this.paramRow(clip.id, 'text.shadow.y'),
        this.paramRow(clip.id, 'text.shadow.blur'),
        this.paramRow(clip.id, 'text.shadow.alpha'),
      ]);
      append(t.body, shadow.node);
      append(this.bodyEl, t.node);
    }

    // ---- shape
    if (clip.type === 'shape') {
      const s = section('図形', {});
      append(s.body, [
        selectField({
          label: '種類', value: clip.shape.kind,
          options: [
            { value: 'rect', label: '矩形' },
            { value: 'ellipse', label: '楕円' },
            { value: 'line', label: '線' },
            { value: 'arrow', label: '矢印' },
            { value: 'star', label: '星' },
          ],
          onChange: (v) => this.applyShapeProp(clip.id, 'kind', v),
        }).node,
        this.paramRow(clip.id, 'shape.width'),
        this.paramRow(clip.id, 'shape.height'),
        this.paramRow(clip.id, 'shape.radius'),
        this.paramRow(clip.id, 'shape.points'),
        colorField({ label: '塗り', value: clip.shape.fill, onChange: (v) => this.applyShapeProp(clip.id, 'fill', v) }).node,
        this.paramRow(clip.id, 'shape.fillAlpha'),
        colorField({ label: '線色', value: clip.shape.stroke, onChange: (v) => this.applyShapeProp(clip.id, 'stroke', v) }).node,
        this.paramRow(clip.id, 'shape.strokeWidth'),
      ]);
      append(this.bodyEl, s.node);
    }

    // ---- audio
    if (clip.type === 'audio' || clip.type === 'video') {
      const a = section('音声', {});
      append(a.body, [
        this.paramRow(clip.id, 'volume'),
        el('div.hint', { text: 'フェードはクリップ左上/右上のハンドルでも調整できます。' }),
        el('div.row', {}, [
          numberField({
            label: 'フェードイン', value: (clip.fades?.inTicks || 0) / TICKS_PER_SECOND, min: 0, max: 60, step: 0.05, digits: 2, unit: 's',
            onChange: (v) => this.setFade(clip.id, 'in', v),
          }).node,
        ]),
        el('div.row', {}, [
          numberField({
            label: 'フェードアウト', value: (clip.fades?.outTicks || 0) / TICKS_PER_SECOND, min: 0, max: 60, step: 0.05, digits: 2, unit: 's',
            onChange: (v) => this.setFade(clip.id, 'out', v),
          }).node,
        ]),
      ]);
      append(this.bodyEl, a.node);
    }

    // ---- quick effects summary
    const fx = section('エフェクト', {
      actions: iconButton('plus', { size: 13, title: 'エフェクトタブで追加', onclick: () => this.setActiveTab('effects') }),
    });
    if (!clip.effects?.length) {
      append(fx.body, el('div.hint', { text: 'エフェクトはありません。「エフェクト」タブで追加できます。' }));
    } else {
      for (const effect of clip.effects) {
        append(fx.body, el('div.row.kv', {}, [
          el('span', { text: getEffectDef(effect.type)?.label || effect.type }),
          el('span.keyframe-track-info', { text: effect.enabled ? '有効' : '無効' }),
        ]));
      }
    }
    append(this.bodyEl, fx.node);
  }

  applyTextProp(clipId, path, value) {
    this.store.transact('テキスト設定を変更', () => {
      for (const id of this.selectedClipIds) {
        const found = this.store.findClip(id);
        if (!found || !found.clip.text) continue;
        this.store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
        const segs = path.split('.');
        let cur = found.clip.text;
        for (let i = 0; i < segs.length - 1; i += 1) {
          if (cur[segs[i]] == null) cur[segs[i]] = {};
          cur = cur[segs[i]];
        }
        cur[segs.at(-1)] = value;
      }
    });
  }

  applyShapeProp(clipId, path, value) {
    this.store.transact('図形設定を変更', () => {
      for (const id of this.selectedClipIds) {
        const found = this.store.findClip(id);
        if (!found || !found.clip.shape) continue;
        this.store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
        found.clip.shape[path] = value;
      }
    });
  }

  setFade(clipId, side, seconds) {
    const ticks = Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
    this.store.transact('フェードを変更', () => {
      for (const id of this.selectedClipIds) {
        const found = this.store.findClip(id);
        if (!found) continue;
        this.store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
        if (side === 'in') found.clip.fades.inTicks = Math.min(ticks, found.clip.durationTicks);
        else found.clip.fades.outTicks = Math.min(ticks, found.clip.durationTicks);
      }
    });
  }

  // ------------------------------------------------------------ effects --

  renderEffectsTab(clip) {
    const store = this.store;
    const addSection = section('エフェクトを追加', {});
    append(addSection.body, this.buildEffectPicker(clip));
    append(this.bodyEl, addSection);

    const list = section(`適用中のエフェクト (${clip.effects?.length || 0})`, {
      actions: iconButton('copy', {
        size: 13,
        title: 'エフェクトを選択中の全クリップへコピー',
        onclick: () => {
          const source = this.store.clipRef(clip.id);
          store.transact('エフェクトをコピー', () => {
            for (const id of this.selectedClipIds) {
              if (id === clip.id) continue;
              const found = store.findClip(id);
              if (!found) continue;
              store.touch(['tracks', found.trackIndex, 'clips', found.clipIndex]);
              found.clip.effects = JSON.parse(JSON.stringify(source.effects));
            }
          });
        },
      }),
    });
    if (!clip.effects?.length) {
      append(list.body, el('div.hint', { text: 'エフェクトがありません。上のメニューから追加してください。' }));
    }
    clip.effects?.forEach((effect, index) => {
      append(list.body, this.buildEffectCard(clip.id, effect, index, clip.effects.length));
    });
    append(this.bodyEl, list);
  }

  buildEffectPicker(clip) {
    const wrap = el('div');
    const categories = new Map();
    for (const type of effectsForClipType(clip.type)) {
      const def = EFFECT_DEFS[type];
      if (!def) continue;
      if (!categories.has(def.category)) categories.set(def.category, []);
      categories.get(def.category).push({ type, label: def.label });
    }
    for (const [category, items] of categories) {
      const chipRow = el('div.effect-picker', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '5px' } });
      append(chipRow, el('span.field-label', { text: category, style: { flex: '0 0 56px' } }));
      for (const item of items) {
        append(chipRow, button(item.label, {
          class: 'small',
          onclick: () => {
            addEffect(this.store, this.selectedClipIds, item.type, {});
            this.render();
          },
        }));
      }
      append(wrap, chipRow);
    }
    return wrap;
  }

  buildEffectCard(clipId, effect, index, total) {
    const def = getEffectDef(effect.type);
    const card = el('div.effect-item', { class: effect.enabled ? '' : 'disabled-effect' });
    const head = el('div.effect-head', {}, [
      checkField({
        label: '', value: effect.enabled,
        onChange: () => toggleEffect(this.store, clipId, effect.id),
      }).node,
      el('span.effect-name', { text: def?.label || effect.type, title: effect.type }),
      iconButton('undo', { size: 12, title: '上へ', disabled: index === 0, onclick: () => { moveEffect(this.store, clipId, effect.id, -1); this.render(); } }),
      iconButton('redo', { size: 12, title: '下へ', disabled: index === total - 1, onclick: () => { moveEffect(this.store, clipId, effect.id, 1); this.render(); } }),
      iconButton('settings', { size: 12, title: 'リセット', onclick: () => { resetEffect(this.store, clipId, effect.id); this.render(); } }),
      iconButton('trash', { size: 12, title: '削除', onclick: () => { removeEffect(this.store, clipId, effect.id); this.render(); } }),
    ]);
    append(card, head);
    const body = el('div.effect-body');
    if (!def) {
      append(body, el('div.hint', { text: 'このエフェクトは利用できません (定義が見つかりません)' }));
    }
    for (const p of def?.params || []) {
      const path = `effects.${effect.id}.${p.key}`;
      if (p.type === 'number' || p.type === 'int') {
        append(body, this.paramRow(clipId, path, {
          label: p.label, min: p.min, max: p.max, step: p.step, digits: p.type === 'int' ? 0 : 2, unit: p.unit,
        }));
      } else if (p.type === 'color') {
        append(body, colorField({
          label: p.label, value: this.readEffectParam(clipId, effect, p),
          onChange: (v) => setEffectParam(this.store, clipId, effect.id, p.key, v, {}),
        }).node);
      } else if (p.type === 'bool') {
        append(body, checkField({
          label: p.label, value: this.readEffectParam(clipId, effect, p),
          onChange: (v) => setEffectParam(this.store, clipId, effect.id, p.key, v, {}),
        }).node);
      } else if (p.type === 'select') {
        append(body, selectField({
          label: p.label, value: this.readEffectParam(clipId, effect, p), options: p.options,
          onChange: (v) => setEffectParam(this.store, clipId, effect.id, p.key, v, {}),
        }).node);
      }
    }
    append(card, body);
    const keyframeCount = Object.keys(this.store.clipRef(clipId)?.keyframes || {})
      .filter((p) => p.startsWith(`effects.${effect.id}.`)).length;
    if (keyframeCount) {
      append(body, el('div.keyframe-track-info', { text: `アニメーション中のパラメータ: ${keyframeCount}` }));
    }
    return card;
  }

  readEffectParam(clipId, effect, p) {
    const clip = this.store.clipRef(clipId);
    const path = `effects.${effect.id}.${p.key}`;
    const value = evaluateParam(clip, path, localTicksFor(clip, this.session.playheadTicks), p.default);
    return value === undefined ? p.default : value;
  }

  // ---------------------------------------------------------- keyframes --

  renderKeyframesTab(clip) {
    const store = this.store;
    const paths = Object.keys(clip.keyframes || {});
    const addSection = section('アニメーションするプロパティ', {});
    const all = animatableParams(clip);
    const picker = el('select.input.select');
    append(picker, el('option', { value: '', text: '— プロパティを選択 —' }));
    for (const p of all) {
      append(picker, el('option', { value: p.path, text: `${p.label}${paths.includes(p.path) ? ' ●' : ''}` }));
    }
    picker.addEventListener('change', () => {
      if (!picker.value) return;
      toggleKeyframe(store, clip.id, picker.value, this.session.playheadTicks);
      this.activeKeyframePath = picker.value;
      this.render();
    });
    append(addSection.body, [
      el('div.hint', { text: `現在の再生ヘッド位置 (${formatTimecode(this.session.playheadTicks, store.state.settings.fps)}) にキーフレームを追加します。` }),
      picker,
    ]);
    append(this.bodyEl, addSection);

    if (!paths.length) {
      append(this.bodyEl, el('div.inspector-empty', { text: 'キーフレームがありません。上のメニューからプロパティを選ぶか、各プロパティ横の ◆ ボタンを押してください。' }));
      return;
    }

    const listSection = section(`キーフレーム (${paths.length} プロパティ)`, {
      actions: iconButton('trash', {
        size: 13, title: '全てのキーフレームを削除',
        onclick: () => {
          clearClipKeyframes(store, clip.id, null);
          this.render();
        },
      }),
    });
    const tabs = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } });
    for (const path of paths) {
      const count = clip.keyframes[path].length;
      append(tabs, button(`${paramSpec(path).label} (${count})`, {
        class: this.activeKeyframePath === path ? 'active' : '',
        onclick: () => {
          this.activeKeyframePath = path;
          this.render();
        },
      }));
    }
    append(listSection.body, tabs);
    append(this.bodyEl, listSection);

    const active = this.activeKeyframePath && paths.includes(this.activeKeyframePath)
      ? this.activeKeyframePath
      : paths[0];
    this.activeKeyframePath = active;
    append(this.bodyEl, this.buildKeyframeEditor(clip, active));
  }

  buildKeyframeEditor(clip, path) {
    const store = this.store;
    const list = getKeyframeList(clip, path) || [];
    const spec = paramSpec(path);
    const wrap = el('div', { style: { padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' } });
    append(wrap, el('div.row.kv', {}, [
      el('span', { text: `${spec.label} のキーフレーム` }),
      iconButton('trash', { size: 13, title: 'このプロパティのキーフレームを削除', onclick: () => { clearClipKeyframes(store, clip.id, path); this.render(); } }),
    ]));

    const canvas = el('canvas.kf-curve');
    append(wrap, canvas);
    this.drawKeyframeCurve(canvas, clip, path);

    const table = el('div.kf-list');
    const local = localTicksFor(clip, this.session.playheadTicks);
    list.forEach((kf, index) => {
      const valueInput = el('input', {
        value: String(typeof kf.v === 'number' ? Number(kf.v.toFixed ? kf.v.toFixed(4) : kf.v) : kf.v),
        title: '値',
      });
      valueInput.addEventListener('change', () => {
        const parsed = parseFloat(valueInput.value);
        if (Number.isFinite(parsed)) setKeyframeValue(store, clip.id, path, kf.id, parsed, {});
      });
      const timeInput = el('input', {
        value: (kf.t / TICKS_PER_SECOND).toFixed(3),
        title: 'ソース内の時間 (秒)',
      });
      timeInput.addEventListener('change', () => {
        const seconds = parseFloat(timeInput.value);
        if (Number.isFinite(seconds)) {
          const ok = moveKeyframeTo(store, clip.id, path, kf.id, Math.round(seconds * TICKS_PER_SECOND), {});
          if (!ok) this.app.toast('他のキーフレームと同じ位置には移動できません', 'warn');
          this.render();
        }
      });
      const interpSelect = el('select', { title: '補間方式' });
      for (const opt of INTERPOLATIONS) {
        append(interpSelect, el('option', { value: opt.value, text: opt.label, selected: opt.value === kf.interp }));
      }
      interpSelect.addEventListener('change', () => {
        setKeyframeInterpolation(store, clip.id, path, kf.id, interpSelect.value, null, {});
        this.render();
      });
      const delBtn = iconButton('trash', { size: 12, title: '削除', onclick: () => { removeKeyframeById(store, clip.id, path, kf.id); this.render(); } });
      const row = el('div.kf-row', {
        class: Math.abs(kf.t - local) <= 1 ? 'current' : '',
        title: index === 0 ? '最初のキーフレーム' : '',
      }, [timeInput, valueInput, interpSelect, delBtn]);
      append(table, row);
    });
    append(wrap, table);
    if (activeInterpNeedsBezier(list)) {
      append(wrap, el('div.hint', { text: 'Cubic Bezier は下のボタンで制御点を切り替えられます。' }));
    }
    const bezierCmd = el('div.row', { style: { flexWrap: 'wrap', gap: '4px' } });
    const presets = [
      { label: '滑らか', b: [0.33, 0, 0.67, 1] },
      { label: '急発進', b: [0.9, 0, 1, 1] },
      { label: '跳ね', b: [0.34, 1.56, 0.64, 1] },
      { label: '減速', b: [0, 0, 0.2, 1] },
    ];
    for (const preset of presets) {
      append(bezierCmd, button(preset.label, {
        title: `ベジェ制御点 ${preset.b.join(', ')} を適用`,
        onclick: () => {
          store.transact('ベジェ制御点を変更', () => {
            for (const kf of list) setKeyframeInterpolation(store, clip.id, path, kf.id, 'bezier', preset.b, {});
          });
          this.render();
        },
      }));
    }
    append(wrap, bezierCmd);

    const navRow = el('div.row', {}, [
      button('前のキーフレームへ', {
        onclick: () => this.jumpToKeyframe(clip, path, -1),
      }),
      button('次のキーフレームへ', {
        onclick: () => this.jumpToKeyframe(clip, path, 1),
      }),
    ]);
    append(wrap, navRow);
    return wrap;
  }

  jumpToKeyframe(clip, path, direction) {
    const list = getKeyframeList(clip, path) || [];
    const local = localTicksFor(clip, this.session.playheadTicks);
    const sorted = [...list].sort((a, b) => a.t - b.t);
    const target = direction > 0
      ? sorted.find((kf) => kf.t > local + 1)
      : [...sorted].reverse().find((kf) => kf.t < local - 1);
    if (!target) return;
    const timelineTicks = clip.startTicks + Math.round(target.t / (clip.speed || 1));
    this.app.setPlayhead(timelineTicks);
  }

  drawKeyframeCurve(canvas, clip, path) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 280;
    const h = 64;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#26313d';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const list = getKeyframeList(clip, path) || [];
    if (list.length < 2) {
      ctx.fillStyle = '#6f8098';
      ctx.font = '10px sans-serif';
      ctx.fillText('キーフレームを2つ以上追加すると曲線が表示されます', 6, h / 2 - 6);
      return;
    }
    const samples = sampleKeyframes(list, 96);
    ctx.strokeStyle = '#34d3c0';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = s.x * (w - 2) + 1;
      const y = h - 6 - s.y * (h - 12);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const t0 = list[0].t;
    const t1 = list[list.length - 1].t;
    const span = t1 - t0 || 1;
    const values = list.map((k) => Number(k.v)).filter(Number.isFinite);
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const range = maxV - minV || 1;
    ctx.fillStyle = '#f0a63c';
    for (const kf of list) {
      const x = ((kf.t - t0) / span) * (w - 2) + 1;
      const y = h - 6 - ((Number(kf.v) - minV) / range) * (h - 12);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const local = localTicksFor(clip, this.session.playheadTicks);
    if (local >= t0 && local <= t1) {
      const x = ((local - t0) / span) * (w - 2) + 1;
      ctx.strokeStyle = '#ff5f56';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------ project --

  renderProject() {
    const store = this.store;
    const settings = store.state.settings;
    const s = section('プロジェクト', {});
    const nameField = textField({
      label: '名前', value: store.state.name,
      onChange: (v) => store.transact('プロジェクト名を変更', () => {
        store.touch(['name']);
        store.state.name = v;
      }),
    });
    append(s.body, [nameField.node]);
    append(s.body, [
      el('div.row', {}, [
        el('span.field-label', { text: '解像度' }),
        selectField({
          label: '', value: `${settings.width}x${settings.height}`,
          options: [
            { value: '3840x2160', label: '3840×2160 (4K)' },
            { value: '2560x1440', label: '2560×1440' },
            { value: '1920x1080', label: '1920×1080' },
            { value: '1280x720', label: '1280×720' },
            { value: '1080x1920', label: '1080×1920 (縦)' },
            { value: '1080x1080', label: '1080×1080 (正方形)' },
          ],
          onChange: (v) => {
            const [w, h] = v.split('x').map(Number);
            this.app.applyProjectSettings({ width: w, height: h });
          },
        }).node,
      ]),
      el('div.row', {}, [
        el('span.field-label', { text: 'フレームレート' }),
        selectField({
          label: '', value: String(settings.fps),
          options: [23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((f) => ({ value: String(f), label: `${f} fps` })),
          onChange: (v) => this.app.applyProjectSettings({ fps: parseFloat(v) }),
        }).node,
      ]),
      colorField({
        label: '背景色', value: settings.backgroundColor,
        onChange: (v) => this.app.applyProjectSettings({ backgroundColor: v }),
      }).node,
    ]);
    append(this.bodyEl, s.node);

    const info = section('情報', {});
    const duration = this.app.projectDuration();
    append(info.body, [
      el('div.row.kv', {}, [el('span', { text: '長さ' }), el('span.keyframe-track-info', { text: `${formatTimecode(duration, settings.fps)} (${formatDuration(duration)})` })]),
      el('div.row.kv', {}, [el('span', { text: 'トラック数' }), el('span.keyframe-track-info', { text: String(store.state.tracks.length) })]),
      el('div.row.kv', {}, [el('span', { text: 'クリップ数' }), el('span.keyframe-track-info', { text: String(store.state.tracks.reduce((sum, t) => sum + t.clips.length, 0)) })]),
      el('div.row.kv', {}, [el('span', { text: '素材数' }), el('span.keyframe-track-info', { text: String(Object.keys(store.state.assets).length) })]),
    ]);
    append(this.bodyEl, info.node);

    const wa = section('ワークエリア (書き出し範囲)', {});
    append(wa.body, [
      el('div.hint', { text: 'I / O キーまたはルーラーの右クリックで設定します。未設定の場合はプロジェクト全体を書き出します。' }),
      el('div.row.kv', {}, [
        el('span', { text: '範囲' }),
        el('span.keyframe-track-info', {
          text: settings.workArea && settings.workArea.outTicks > settings.workArea.inTicks
            ? `${formatTimecode(settings.workArea.inTicks, settings.fps)} → ${formatTimecode(settings.workArea.outTicks, settings.fps)}`
            : '未設定 (全体)',
        }),
      ]),
      el('div.row', {}, [
        button('開始を再生ヘッドに', { onclick: () => this.app.setWorkAreaIn(this.session.playheadTicks) }),
        button('終了を再生ヘッドに', { onclick: () => this.app.setWorkAreaOut(this.session.playheadTicks) }),
        button('クリア', { onclick: () => this.app.clearWorkArea() }),
      ]),
    ]);
    append(this.bodyEl, wa.node);

    const storage = section('保存とストレージ', { collapsed: true });
    append(storage.body, [
      el('div.hint', { text: this.app.mediaPool.blobs.size ? '素材はこのブラウザの IndexedDB に保存され、再読み込み時に自動で復元されます。' : '素材が読み込まれていません。' }),
      el('div.row', {}, [
        button('自動保存を今すぐ実行', { onclick: () => this.app.autosaveNow() }),
        button('プロジェクトを複製', { onclick: () => this.app.duplicateProject() }),
      ]),
    ]);
    append(this.bodyEl, storage.node);

    const shortcuts = section('ショートカット', { collapsed: true });
    append(shortcuts.body, el('div.hint', {
      html: [
        '<b>Space</b> 再生/停止 · <b>←/→</b> 1フレーム · <b>Shift+←/→</b> 1秒',
        '<b>Home/End</b> 先頭/末尾 · <b>K</b> 分割 · <b>T</b> 全分割 · <b>Del</b> 削除 · <b>Enter</b> 字幕編集',
        '<b>Ctrl+Z / Ctrl+Shift+Z</b> 元に戻す/やり直し · <b>Ctrl+D</b> 複製',
        '<b>Ctrl+A</b> 全選択 · <b>S</b> スナップ切替 · <b>+/-</b> ズーム · <b>M</b> マーカー',
        '<b>I / O</b> ワークエリア開始/終了 · <b>Ctrl+S</b> 保存 · <b>Ctrl+E</b> 書き出し',
      ].join('<br>'),
    }));
    append(this.bodyEl, shortcuts.node);
  }
}

function activeInterpNeedsBezier(list) {
  return list.some((kf) => kf.interp === 'bezier');
}

export { icon };
