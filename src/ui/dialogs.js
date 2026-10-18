/**
 * Dialogs, modals and toasts.
 */

import { el, append, clear, button, icon, iconButton } from './dom.js';
import { numberField, selectField, checkField, textField, colorField, textareaField, row } from './widgets.js';
import { Persistence, formatBytes } from '../core/persist.js';
import { supportedContainers, Exporter, suggestBitrate } from '../export/exporter.js';
import { AUTO_OPTIONS, AUTO_META } from '../auto/autodirector.js';
import { parseSubtitleFile, parsePlainText, cuesToSrt } from '../auto/subtitles.js';
import { formatTimecode, formatDuration, TICKS_PER_SECOND } from '../core/time.js';

// ---------------------------------------------------------------- toasts -----

export class ToastHost {
  constructor() {
    this.node = el('div.toast-host');
  }

  push(message, kind = 'info', timeout = 3600) {
    const node = el('div.toast', { class: kind, text: String(message) });
    this.node.appendChild(node);
    const remove = () => {
      node.style.transition = 'opacity .2s';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 220);
    };
    setTimeout(remove, timeout);
    node.addEventListener('click', remove);
    return node;
  }
}

// ---------------------------------------------------------------- modal ------

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {Array|Node} [opts.body]
 * @param {Array|Node} [opts.footer]
 * @param {string} [opts.width]
 * @param {boolean} [opts.closeOnBackdrop]
 * @returns {{node:HTMLElement, body:HTMLElement, footer:HTMLElement, close:()=>void}}
 */
export function modal(opts = {}) {
  const bodyNode = el('div.modal-body');
  append(bodyNode, opts.body || []);
  const footerNode = el('div.modal-footer');
  append(footerNode, opts.footer || []);

  const closeBtn = iconButton('plus', {
    class: 'close',
    title: '閉じる',
    onclick: () => close(),
  });
  closeBtn.querySelector('svg')?.setAttribute('transform', 'rotate(45)');

  const dialog = el('div.modal', {
    style: opts.width ? { minWidth: opts.width, maxWidth: opts.width } : {},
    onclick: (ev) => ev.stopPropagation(),
  }, [
    el('div.modal-header', {}, [el('span', { text: opts.title || '' }), el('span.spacer'), closeBtn]),
    bodyNode,
    opts.footer ? footerNode : null,
  ]);

  const backdrop = el('div.modal-backdrop', {
    onclick: () => {
      if (opts.closeOnBackdrop !== false) close();
    },
  }, [dialog]);

  let closed = false;
  const onKey = (ev) => {
    if (ev.key === 'Escape' && opts.closeOnEscape !== false) {
      ev.stopPropagation();
      close();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    opts.onClose?.();
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  return { node: dialog, body: bodyNode, footer: footerNode, close, backdrop };
}

export function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const okBtn = button(opts.okLabel || 'OK', {
      variant: opts.danger ? 'danger' : 'primary',
      onclick: () => {
        done(true);
        dlg.close();
      },
    });
    const dlg = modal({
      title: opts.title || '確認',
      width: '420px',
      body: [el('div.dialog-text', { text: message })],
      footer: [button('キャンセル', { onclick: () => { done(false); dlg.close(); } }), okBtn],
      onClose: () => done(false),
    });
    okBtn.focus?.();
  });
}

export function promptDialog(message, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const field = textField({ value: opts.value ?? '', placeholder: opts.placeholder || '' });
    const ok = () => {
      done(field.node.querySelector('input').value);
      dlg.close();
    };
    const dlg = modal({
      title: opts.title || '入力',
      width: '420px',
      body: [el('div.dialog-text', { text: message }), field.node],
      footer: [
        button('キャンセル', { onclick: () => { done(null); dlg.close(); } }),
        button(opts.okLabel || 'OK', { variant: 'primary', onclick: ok }),
      ],
      onClose: () => done(null),
    });
    const input = field.node.querySelector('input');
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ok();
    });
    input.focus();
    input.select();
  });
}

/** Generic "long task with progress" dialog. */
export function progressDialog(opts = {}) {
  const bar = el('div.progress-bar');
  const label = el('div.dialog-text', { text: opts.message || '処理中…' });
  const logNode = el('div.log', { style: opts.log === false ? { display: 'none' } : {} });
  const cancelBtn = button('キャンセル', {
    onclick: () => {
      opts.onCancel?.();
      dlg.close();
    },
  });
  const dlg = modal({
    title: opts.title || '処理中',
    width: opts.width || '520px',
    closeOnBackdrop: false,
    closeOnEscape: false,
    closeOnBackdropClick: false,
    body: [label, el('div.progress', {}, [bar]), logNode],
    footer: [cancelBtn],
  });
  let lines = [];
  return {
    node: dlg.node,
    close: dlg.close,
    setMessage(text) {
      label.textContent = text;
    },
    setProgress(value) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
    },
    log(text) {
      lines.push(text);
      if (lines.length > 200) lines = lines.slice(-200);
      logNode.textContent = lines.join('\n');
      logNode.scrollTop = logNode.scrollHeight;
    },
    finish() {
      cancelBtn.remove();
    },
    disableCancel() {
      cancelBtn.disabled = true;
      cancelBtn.remove();
    },
  };
}

// ------------------------------------------------------------ export dialog --

const RESOLUTIONS = [
  { label: 'プロジェクト設定を使用', value: 'project' },
  { label: '3840 × 2160 (4K UHD)', value: '3840x2160' },
  { label: '2560 × 1440 (QHD)', value: '2560x1440' },
  { label: '1920 × 1080 (Full HD)', value: '1920x1080' },
  { label: '1280 × 720 (HD)', value: '1280x720' },
  { label: '854 × 480 (SD)', value: '854x480' },
  { label: '1080 × 1920 (縦動画)', value: '1080x1920' },
  { label: '1080 × 1080 (正方形)', value: '1080x1080' },
];

export function exportDialog(app) {
  const state = app.store.state;
  const containers = supportedContainers();
  if (!containers.length) {
    app.toast('この環境は MediaRecorder に対応していないため書き出しできません', 'error');
    return;
  }
  const projectMp4 = containers.find((c) => c.ext === 'mp4');

  const settings = { ...(app.exportPrefs || {}) };
  const containerField = selectField({
    label: '形式',
    value: settings.mime || containers[0].mime,
    options: containers.map((c) => ({ label: c.label, value: c.mime })),
    onChange: (v) => {
      settings.mime = v;
    },
  });
  const resolutionField = selectField({
    label: '解像度',
    value: settings.resolution || 'project',
    options: RESOLUTIONS,
    onChange: (v) => {
      settings.resolution = v;
    },
  });
  const fpsField = selectField({
    label: 'フレームレート',
    value: settings.fps || 'project',
    options: [
      { label: `プロジェクト設定 (${state.settings.fps} fps)`, value: 'project' },
      { label: '24 fps', value: '24' },
      { label: '25 fps', value: '25' },
      { label: '30 fps', value: '30' },
      { label: '60 fps', value: '60' },
    ],
    onChange: (v) => {
      settings.fps = v;
    },
  });
  const qualityField = selectField({
    label: '品質',
    value: settings.quality || 'high',
    options: [
      { label: '高画質（大きいファイル）', value: 'high' },
      { label: '標準', value: 'medium' },
      { label: '低容量', value: 'low' },
    ],
    onChange: (v) => {
      settings.quality = v;
    },
  });
  const workArea = state.settings.workArea;
  const hasWork = !!(workArea && workArea.outTicks > workArea.inTicks);
  const rangeFieldNode = checkField({
    label: hasWork ? 'ワークエリアのみ書き出す' : 'ワークエリアが未設定です（全編を書き出します）',
    value: hasWork,
    disabled: !hasWork,
    onChange: (v) => {
      settings.workAreaOnly = v;
    },
  });
  settings.workAreaOnly = hasWork;

  const bar = el('div.progress-bar');
  const info = el('div.dialog-text');
  const logNode = el('div.log');

  const note = el('div.dialog-note', {
    text: [
      '書き出しはリアルタイム（1倍速）で行われます。',
      '処理中はこのタブを表示したままにしてください（タブを離れるとフレームが欠けることがあります）。',
      containers.some((c) => c.ext === 'mp4')
        ? ''
        : 'このブラウザは MP4 録画に未対応のため WebM で保存されます（動画共有サイトはWebMを受け付けます）。',
    ].filter(Boolean).join('\n'),
  });

  const startBtn = button('書き出し開始', { variant: 'primary', icon: 'download' });
  const closeBtn = button('閉じる', { onclick: () => dlg.close() });
  const cancelBtn = button('キャンセル', {
    class: 'hidden',
    onclick: () => {
      app.exporter.cancel();
      info.textContent = 'キャンセルしています…';
    },
  });

  const dlg = modal({
    title: '書き出し',
    width: '560px',
    body: [
      row([containerField.node, resolutionField.node]),
      row([fpsField.node, qualityField.node]),
      rangeFieldNode.node,
      note,
      el('div.progress', {}, [bar]),
      info,
      logNode,
    ],
    footer: [closeBtn, cancelBtn, startBtn],
  });

  startBtn.addEventListener('click', async () => {
    const [w, h] = settings.resolution === 'project'
      ? [state.settings.width, state.settings.height]
      : settings.resolution.split('x').map(Number);
    const fps = settings.fps === 'project' ? state.settings.fps : Number(settings.fps);
    const range = settings.workAreaOnly && hasWork
      ? { inTicks: workArea.inTicks, outTicks: workArea.outTicks }
      : { inTicks: 0, outTicks: Math.max(TICKS_PER_SECOND, app.projectDuration()) };
    const bitrate = suggestBitrate(w, h, fps, settings.quality || 'high');
    const container = containers.find((c) => c.mime === (settings.mime || containers[0].mime));

    startBtn.disabled = true;
    cancelBtn.classList.remove('hidden');
    logNode.textContent = '';
    info.textContent = '';
    if (app.playback?.playing) app.playback.pause();
    app.setExporting?.(true);
    app.exportPrefs = settings;

    const started = performance.now();
    const result = await app.exporter.export({
      width: w,
      height: h,
      fps,
      mime: container?.mime || projectMp4?.mime || '',
      bitrate,
      range,
      onProgress: (p) => {
        bar.style.width = `${Math.round(p.progress * 100)}%`;
        const elapsed = (performance.now() - started) / 1000;
        const remaining = p.progress > 0.01 ? Math.max(0, elapsed / p.progress - elapsed) : 0;
        info.textContent = `${Math.round(p.progress * 100)}% ・ 残り約 ${Math.ceil(remaining)} 秒 ・ ${p.message || ''}`;
        if (p.message && p.message.includes('警告')) logNode.textContent += `${p.message}\n`;
      },
    });
    app.setExporting?.(false);
    startBtn.disabled = false;
    cancelBtn.classList.add('hidden');

    if (!result) {
      info.textContent = '書き出しをキャンセルしました（データは保存されていません）';
      return;
    }
    bar.style.width = '100%';
    info.textContent = `完成: ${result.filename} (${formatBytes(result.blob.size)}, ${result.mime})`;
    Persistence.download(result.filename, result.blob);
    logNode.textContent += 'ダウンロードを開始しました。\n';
    app.toast(`書き出し完了: ${result.filename}`, 'info', 6000);
  });
}

// ------------------------------------------------------ auto director dialog --

export function autoDirectorDialog(app) {
  const store = app.store;
  const workArea = store.state.settings.workArea;
  const hasWork = !!(workArea && workArea.outTicks > workArea.inTicks);
  const range = app.autodirector.defaultRange();
  const state = {
    mode: 'clicks',
    zooms: true,
    rings: false,
    zoomLevel: AUTO_OPTIONS.zoomLevel,
    sensitivity: AUTO_OPTIONS.sensitivity,
    intervalSeconds: AUTO_OPTIONS.intervalSeconds,
    ringColor: AUTO_OPTIONS.ringColor,
    subtitleOffset: 0,
    subtitleSecondsPerLine: 2.5,
    cues: null,
    cueCount: 0,
    clicks: null,
    analyzed: false,
    useWorkArea: hasWork,
  };

  // ---- range --------------------------------------------------------------
  const rangeFieldNode = checkField({
    label: hasWork
      ? `ワークエリアのみ（${formatTimecode(range.inTicks, store.state.settings.fps)} 〜 ${formatTimecode(range.outTicks, store.state.settings.fps)}）`
      : 'ワークエリアが未設定（全編を対象にします）',
    value: hasWork,
    disabled: !hasWork,
    onChange: (v) => {
      state.useWorkArea = v;
    },
  });

  // ---- mode ---------------------------------------------------------------
  const modeField = selectField({
    label: '解析方法',
    value: 'clicks',
    options: [
      { label: 'クリック音/操作を自動検出（映像解析）', value: 'clicks' },
      { label: '一定間隔で自動ズーム', value: 'interval' },
    ],
    onChange: (v) => {
      state.mode = v;
      intervalField.setDisabled?.(v !== 'interval');
    },
  });
  const sensitivityField = numberField({
    label: '検出感度',
    value: state.sensitivity,
    min: 0.4,
    max: 4,
    step: 0.1,
    digits: 2,
    onChange: (v) => {
      state.sensitivity = v;
      state.analyzed = false;
    },
  });
  const intervalField = numberField({
    label: '間隔（秒）',
    value: state.intervalSeconds,
    min: 1,
    max: 120,
    step: 0.5,
    digits: 1,
    unit: 's',
    disabled: true,
    onChange: (v) => {
      state.intervalSeconds = v;
    },
  });
  const zoomLevelField = numberField({
    label: 'ズーム倍率',
    value: state.zoomLevel,
    min: 1.05,
    max: 4,
    step: 0.05,
    digits: 2,
    unit: '×',
    onChange: (v) => {
      state.zoomLevel = v;
    },
  });
  const zoomCheck = checkField({
    label: '自動ズームを生成（編集可能なカメラアニメーション）',
    value: true,
    onChange: (v) => {
      state.zooms = v;
    },
  });
  const ringCheck = checkField({
    label: 'クリック位置にエフェクト（波紋）を生成',
    value: false,
    onChange: (v) => {
      state.rings = v;
    },
  });
  const ringColorField = colorField({
    label: '波紋の色',
    value: state.ringColor,
    onChange: (v) => {
      state.ringColor = v;
    },
  });

  // ---- analysis -----------------------------------------------------------
  const status = el('div.dialog-text', { text: '「クリックを解析」を押すと映像を解析します。' });
  const bar = el('div.progress-bar');
  const analyzeBtn = button('クリックを解析', { icon: 'sparkles' });
  analyzeBtn.addEventListener('click', async () => {
    analyzeBtn.disabled = true;
    status.textContent = '解析中…';
    try {
      const r = state.useWorkArea ? { inTicks: workArea.inTicks, outTicks: workArea.outTicks } : app.autodirector.defaultRange();
      const clicks = await app.autodirector.analyzeClicks({
        range: r,
        sensitivity: state.sensitivity,
        onProgress: (p, msg) => {
          bar.style.width = `${Math.round(p * 100)}%`;
          status.textContent = `${Math.round(p * 100)}% ${msg || ''}`;
        },
      });
      state.clicks = clicks;
      state.analyzed = true;
      status.textContent = clicks.length
        ? `${clicks.length} 件のクリックを検出しました。適用するとクリック位置へ自動ズームが追加されます。`
        : 'クリックを検出できませんでした。感度を上げるか「一定間隔で自動ズーム」を試してください。';
    } catch (err) {
      state.analyzed = false;
      status.textContent = `解析できませんでした: ${err.message}`;
      app.toast(`解析エラー: ${err.message}`, 'error');
    } finally {
      analyzeBtn.disabled = false;
      bar.style.width = '0%';
    }
  });

  // ---- subtitles ----------------------------------------------------------
  const cueLabel = el('div.dialog-text', { text: '字幕ファイル（SRT / VTT / TXT）を読み込むと、字幕クリップを生成します。' });
  const fileInput = el('input', { type: 'file', accept: '.srt,.vtt,.txt', class: 'input-file' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    state.cues = parseSubtitleFile(text, file.name, { secondsPerLine: state.subtitleSecondsPerLine });
    state.cueCount = state.cues.length;
    cueLabel.textContent = `${file.name}: ${state.cues.length} 件の字幕を読み込みました。`;
  });
  const subtitleLink = el('button.link', {
    text: '字幕を貼り付け / 書き出す',
    onclick: () => subtitleTextDialog(app, {
      onApply: (cues, label) => {
        state.cues = cues;
        state.cueCount = cues.length;
        cueLabel.textContent = label;
      },
    }),
  });
  const subtitleOffsetField = numberField({
    label: '字幕オフセット',
    value: 0,
    min: -600,
    max: 600,
    step: 0.1,
    digits: 2,
    unit: 's',
    onChange: (v) => {
      state.subtitleOffset = v;
    },
  });

  // ---- apply --------------------------------------------------------------
  const applyBtn = button('適用', { variant: 'primary', icon: 'sparkles' });
  applyBtn.addEventListener('click', () => {
    const r = state.useWorkArea && hasWork
      ? { inTicks: workArea.inTicks, outTicks: workArea.outTicks }
      : app.autodirector.defaultRange();
    try {
      const summary = app.autodirector.apply({
        range: r,
        zooms: state.zooms,
        rings: state.rings,
        ringColor: state.ringColor,
        zoomLevel: state.zoomLevel,
        sensitivity: state.sensitivity,
        mode: state.mode,
        intervalSeconds: state.intervalSeconds,
        clicks: state.mode === 'clicks' ? state.clicks : null,
        cues: state.cues,
        subtitleOffsetMs: Math.round(state.subtitleOffset * 1000),
      });
      const parts = [];
      if (summary.zooms) parts.push(`自動ズーム ${summary.zooms} 件`);
      if (summary.rings) parts.push(`クリック演出 ${summary.rings} 件`);
      if (summary.subtitles) parts.push(`字幕 ${summary.subtitles} 件`);
      if (!parts.length) {
        status.textContent = state.mode === 'clicks' && !state.analyzed
          ? '先に「クリックを解析」を実行してください。'
          : '追加できる項目がありませんでした。';
        return;
      }
      app.toast(`AI演出を追加: ${parts.join('、')}（元に戻すで一括削除できます）`, 'info', 6000);
      dlg.close();
    } catch (err) {
      status.textContent = `適用できませんでした: ${err.message}`;
      app.toast(`適用エラー: ${err.message}`, 'error');
    }
  });

  const removeBtn = button('自動演出を削除', {
    variant: 'danger',
    onclick: async () => {
      const ok = await confirmDialog('これまでに生成した自動演出（ズーム/クリック/字幕）をすべて削除します。手動で作ったクリップは残ります。', {
        title: '自動演出を削除',
        danger: true,
        okLabel: '削除',
      });
      if (!ok) return;
      const n = app.autodirector.removeAutoObjects();
      app.toast(n ? `${n} 件の自動演出を削除しました` : '削除する自動演出がありませんでした');
      dlg.close();
    },
  });

  // ---- build --------------------------------------------------------------
  const body = [
    rangeFieldNode.node,
    el('hr.rule'),
    modeField.node,
    row([sensitivityField.node, intervalField.node]),
    zoomCheck.node,
    zoomLevelField.node,
    row([ringCheck.node, ringColorField.node]),
    el('div.row', {}, [analyzeBtn]),
    el('div.progress', {}, [bar]),
    status,
    el('hr.rule'),
    cueLabel,
    row([fileInput, subtitleLink]),
    subtitleOffsetField.node,
    el('div.dialog-note', {
      text: '生成された演出は通常のクリップ/キーフレームとして追加され、あとから自由に編集・削除できます。手動編集を上書きすることはありません。',
    }),
  ];

  const dlg = modal({
    title: 'AI 演出アシスタント',
    width: '620px',
    body,
    footer: [removeBtn, button('閉じる', { onclick: () => dlg.close() }), applyBtn],
    onClose: () => {
      app.autodirector.cancelled = true;
    },
  });
}

/** Paste / export subtitles as SRT. */
export function subtitleTextDialog(app, opts = {}) {
  const area = textareaField({
    label: '字幕テキスト（SRT / VTT / 1行1字幕）',
    rows: 12,
    placeholder: '1\n00:00:00,000 --> 00:00:02,000\nこんにちは\n',
  });
  const secondsPerLine = numberField({
    label: '1行あたりの秒数（プレーンテキスト時）',
    value: 2.5,
    min: 0.5,
    max: 30,
    step: 0.1,
    digits: 1,
    unit: 's',
  });
  const status = el('div.dialog-text');
  const dlg = modal({
    title: '字幕の貼り付け / 書き出し',
    width: '620px',
    body: [
      area.node,
      secondsPerLine.node,
      row([
        button('読み込み内容を確認', {
          onclick: () => {
            const cues = parsePlainText(area.node.querySelector('textarea').value, secondsPerLine.value);
            status.textContent = `${cues.length} 件の字幕を認識しました（1行またはタイムコード付き）。`;
          },
        }),
        button('貼り付け内容を適用', {
          variant: 'primary',
          onclick: () => {
            const text = area.node.querySelector('textarea').value;
            if (!text.trim()) {
              status.textContent = 'テキストが空です。';
              return;
            }
            const cues = parseSubtitleFile(text, '', { secondsPerLine: secondsPerLine.value });
            opts.onApply?.(cues, `貼り付けテキスト: ${cues.length} 件の字幕`);
            dlg.close();
          },
        }),
      ]),
      status,
      el('div.dialog-note', { text: 'ヒント: 既存の字幕を編集してここに貼り戻すと、SRT として再生成できます。' }),
    ],
    footer: [button('閉じる', { onclick: () => dlg.close() })],
  });
}

// ------------------------------------------------------- project settings ----

export function projectSettingsDialog(app) {
  const s = app.store.state.settings;
  const spec = {
    name: app.store.state.name,
    width: s.width,
    height: s.height,
    fps: s.fps,
    backgroundColor: s.backgroundColor || '#000000',
  };
  const presets = [
    { label: '1920 × 1080 / 30fps', value: '1920x1080x30' },
    { label: '1920 × 1080 / 60fps', value: '1920x1080x60' },
    { label: '1280 × 720 / 30fps', value: '1280x720x30' },
    { label: '1080 × 1920（縦）/ 30fps', value: '1080x1920x30' },
    { label: '1080 × 1080（正方形）/ 30fps', value: '1080x1080x30' },
    { label: '3840 × 2160 / 30fps', value: '3840x2160x30' },
    { label: '1440 × 1080（4:3）/ 30fps', value: '1440x1080x30' },
  ];
  const nameField = textField({
    label: 'プロジェクト名',
    value: spec.name,
    onChange: (v) => {
      spec.name = v;
    },
  });
  const widthField = numberField({
    label: '幅',
    value: spec.width,
    min: 16,
    max: 7680,
    step: 2,
    digits: 0,
    unit: 'px',
    onChange: (v) => {
      spec.width = Math.round(v);
    },
  });
  const heightField = numberField({
    label: '高さ',
    value: spec.height,
    min: 16,
    max: 4320,
    step: 2,
    digits: 0,
    unit: 'px',
    onChange: (v) => {
      spec.height = Math.round(v);
    },
  });
  const fpsField = numberField({
    label: 'フレームレート',
    value: spec.fps,
    min: 1,
    max: 240,
    step: 1,
    digits: 3,
    unit: 'fps',
    onChange: (v) => {
      spec.fps = v;
    },
  });
  const bgField = colorField({
    label: '背景色',
    value: spec.backgroundColor,
    onChange: (v) => {
      spec.backgroundColor = v;
    },
  });
  const presetField = selectField({
    label: 'プリセット',
    value: '',
    options: [{ label: '選択…', value: '' }, ...presets],
    onChange: (v) => {
      if (!v) return;
      const [w, h, f] = v.split('x').map(Number);
      widthField.setValue(w);
      heightField.setValue(h);
      fpsField.setValue(f);
      spec.width = w;
      spec.height = h;
      spec.fps = f;
    },
  });

  const dlg = modal({
    title: 'プロジェクト設定',
    width: '520px',
    body: [
      nameField.node,
      presetField.node,
      row([widthField.node, heightField.node, fpsField.node]),
      bgField.node,
      el('div.dialog-note', {
        text: '解像度やフレームレートを変更しても、クリップの時間位置は保持されます。フレームレートはタイムコード表示とスナップに影響します。',
      }),
    ],
    footer: [
      button('キャンセル', { onclick: () => dlg.close() }),
      button('適用', {
        variant: 'primary',
        onclick: () => {
          app.applyProjectSettings(spec);
          dlg.close();
        },
      }),
    ],
  });
}

// ------------------------------------------------------------ app settings ---

export function settingsDialog(app) {
  const body = [];
  const state = app.store.state;

  const storageLabel = el('div.dialog-text', { text: '使用量を取得中…' });
  app.persistence.usage().then((est) => {
    const used = est.usage || 0;
    const quota = est.quota || 0;
    storageLabel.textContent = quota
      ? `ブラウザ保存領域: ${formatBytes(used)} / ${formatBytes(quota)} (${((used / quota) * 100).toFixed(1)}%)`
      : `ブラウザ保存領域: ${formatBytes(used)}`;
  });

  const autosaveCheck = checkField({
    label: '自動保存を有効にする',
    value: app.persistence.enabled,
    onChange: (v) => {
      app.persistence.enabled = v;
    },
  });
  const delayField = numberField({
    label: '自動保存の間隔',
    value: Math.round(app.persistence.autosaveDelay / 100) / 10,
    min: 0.5,
    max: 60,
    step: 0.5,
    digits: 1,
    unit: 's',
    onChange: (v) => {
      app.persistence.autosaveDelay = Math.max(500, v * 1000);
    },
  });

  const mediaInput = el('input', { type: 'file', multiple: true, class: 'input-file' });
  mediaInput.addEventListener('change', async () => {
    const n = await app.relinkAssets(mediaInput.files);
    app.toast(n ? `${n} 件のメディアを再リンクしました` : '再リンクできるファイルがありませんでした', n ? 'info' : 'warn');
  });
  const projectInput = el('input', { type: 'file', accept: '.json', class: 'input-file' });
  projectInput.addEventListener('change', async () => {
    const file = projectInput.files?.[0];
    if (!file) return;
    try {
      await app.openProjectFile(file);
    } catch (err) {
      app.toast(`読み込みエラー: ${err.message}`, 'error');
    }
  });

  append(body, [
    storageLabel,
    el('hr.rule'),
    autosaveCheck.node,
    delayField.node,
    el('div.row', {}, [
      button('自動保存を削除', {
        onclick: async () => {
          const ok = await confirmDialog('このブラウザに保存された自動保存データを削除します。開いているプロジェクトはそのまま残ります。', {
            title: '自動保存を削除',
            danger: true,
          });
          if (!ok) return;
          await app.persistence.clear();
          app.toast('自動保存データを削除しました');
        },
      }),
      button('未使用メディアを削除', {
        title: 'プロジェクトから外された素材のデータをブラウザから削除します',
        onclick: async () => {
          const n = await app.persistence.pruneOrphanBlobs();
          app.toast(n ? `${n} 件の未使用データを削除しました` : '削除するデータはありません');
        },
      }),
    ]),
    el('hr.rule'),
    el('div.dialog-text', { text: 'プロジェクトファイル' }),
    row([
      button('JSONを保存', { icon: 'download', onclick: () => app.persistence.exportProjectFile() }),
      labelFor(projectInput, 'JSONを開く'),
    ]),
    el('div.dialog-note', {
      text: `現在のプロジェクト: ${state.name}（素材はこのブラウザ内にのみ保存されています。プロジェクトファイルにはメディアは含まれません）`,
    }),
    el('hr.rule'),
    el('div.dialog-text', { text: 'メディアの再リンク' }),
    row([labelFor(mediaInput, '動画/音声/画像を選択')]),
  ]);

  const dlg = modal({
    title: '設定',
    width: '560px',
    body,
    footer: [button('閉じる', { onclick: () => dlg.close() })],
  });
}

function labelFor(input, text) {
  const wrap = el('label.btn', { title: text });
  append(wrap, [icon('film', 15), el('span.text', { text })]);
  wrap.appendChild(input);
  input.style.display = 'none';
  return wrap;
}

// --------------------------------------------------------------- asset info --

export function assetInfoDialog(app, assetId) {
  const asset = app.store.state.assets[assetId];
  if (!asset) return;
  const rows = [
    ['名前', asset.name],
    ['ファイル名', asset.sourceName || '-'],
    ['種類', asset.kind],
    ['状態', asset.status],
    ['サイズ', formatBytes(asset.size)],
    ['MIME', asset.mimeType || '-'],
    ['解像度', asset.width ? `${asset.width} × ${asset.height}` : '-'],
    ['長さ', asset.durationTicks ? formatDuration(asset.durationTicks) : '-'],
    ['音声', asset.hasAudio ? `あり（${asset.channels}ch / ${asset.sampleRate} Hz）` : 'なし'],
    ['ブラウザ内保存', app.mediaPool.blobs.has(assetId) ? 'あり' : 'なし（再リンクが必要）'],
  ];
  const body = rows.map(([k, v]) => el('div.row.kv', {}, [el('span.field-label', { text: k }), el('span.value', { text: String(v) })]));
  const clipCount = countAssetUsage(app.store.state, assetId);
  body.push(el('div.dialog-note', { text: `この素材は ${clipCount} 個のクリップで使用されています。` }));

  const dlg = modal({
    title: '素材情報',
    width: '520px',
    body,
    footer: [
      button('タイムラインに追加', {
        icon: 'plus',
        onclick: () => {
          app.addAssetToTimeline(assetId);
          dlg.close();
        },
      }),
      button('閉じる', { onclick: () => dlg.close() }),
    ],
  });
}

export function countAssetUsage(project, assetId) {
  let n = 0;
  for (const track of project.tracks) for (const clip of track.clips) if (clip.assetId === assetId) n += 1;
  return n;
}

// -------------------------------------------------------------------- help ---

export function helpDialog() {
  const shortcuts = [
    ['Space', '再生 / 一時停止'],
    ['← / →', '1フレーム移動'],
    ['Shift + ← / →', '1秒移動'],
    ['Home / End', '先頭 / 末尾へ'],
    ['I / O', 'ワークエリアの開始 / 終了を設定'],
    ['Ctrl + Z / Ctrl + Shift + Z', '元に戻す / やり直し'],
    ['Ctrl + S', 'プロジェクトを保存（JSON）'],
    ['Ctrl + E', '書き出し'],
    ['Ctrl + K', '再生ヘッドで分割'],
    ['S', 'スナップの切替'],
    ['Delete / Backspace', '選択クリップを削除'],
    ['Ctrl + D', '選択クリップを複製'],
    ['M', 'マーカーを追加'],
    ['+ / -', 'ズームイン / アウト'],
    ['F', '選択クリップを表示'],
  ];
  const body = shortcuts.map(([k, v]) => el('div.row.kv', {}, [el('code.key', { text: k }), el('span.value', { text: v })]));
  const dlg = modal({
    title: 'Qelvoryn の使い方',
    width: '560px',
    body: [
      el('div.dialog-text', {
        text: 'Qelvoryn はブラウザだけで動くノンリニア動画編集アプリです。素材を読み込み、タイムラインに並べ、効果とキーフレームで仕上げます。',
      }),
      el('hr.rule'),
      ...body,
    ],
    footer: [button('閉じる', { onclick: () => dlg.close() })],
  });
}

export { Exporter, AUTO_META, cuesToSrt };
