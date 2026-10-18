/**
 * Media pool panel: import files, preview thumbnails, drag to the timeline.
 * Also hosts the auto-director entry points.
 */

import { el, append, clear, icon, button, iconButton, formatNumber } from './dom.js';
import { ASSET_KINDS } from '../core/model.js';
import { formatDuration } from '../core/time.js';
import { contextMenu } from './menu.js';
import { autoDirectorDialog } from './dialogs.js';

export class MediaPanel {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.selected = new Set();
    this.build();
  }

  build() {
    this.root = el('div.panel', { id: 'panel-media' });
    this.listEl = el('div.media-list');
    this.dropEl = el('div.media-drop', {}, [
      el('div', { text: 'クリックまたはドロップで素材を追加' }),
      el('div', { style: { fontSize: '10px', marginTop: '4px', color: 'var(--text-2)' }, text: '動画 / 画像 / 音声' }),
    ]);
    const fileInput = el('input', {
      type: 'file',
      multiple: true,
      accept: 'video/*,image/*,audio/*',
      style: { display: 'none' },
    });
    fileInput.addEventListener('change', async () => {
      if (fileInput.files?.length) await this.app.importFiles([...fileInput.files]);
      fileInput.value = '';
    });
    this.fileInput = fileInput;

    this.dropEl.addEventListener('click', () => fileInput.click());
    this.dropEl.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      this.dropEl.classList.add('over');
    });
    this.dropEl.addEventListener('dragleave', () => this.dropEl.classList.remove('over'));
    this.dropEl.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      this.dropEl.classList.remove('over');
      const files = [...(ev.dataTransfer?.files || [])];
      if (files.length) await this.app.importFiles(files);
    });

    const header = el('div.panel-header', {}, [
      el('span', { text: '素材' }),
      el('span.spacer'),
      iconButton('plus', { title: '素材を追加', onclick: () => fileInput.click() }),
      iconButton('sparkles', { title: '自動演出', onclick: () => autoDirectorDialog(this.app) }),
    ]);
    this.bodyEl = el('div.panel-body', {}, [this.dropEl, this.listEl]);
    append(this.root, [header, this.bodyEl, fileInput]);
    this.render();
  }

  render() {
    const project = this.store.state;
    clear(this.listEl);
    const ids = project.assetOrder.filter((id) => project.assets[id]);
    if (!ids.length) {
      append(this.listEl, el('div.hint', {
        style: { padding: '8px 10px' },
        text: '素材がありません。動画・画像・音声ファイルを追加してください。タイムラインへドラッグして配置できます。',
      }));
      return;
    }
    for (const id of ids) {
      const asset = project.assets[id];
      append(this.listEl, this.buildItem(asset));
    }
  }

  buildItem(asset) {
    const thumb = el('div.media-thumb');
    if (asset.kind === 'image') {
      const img = el('img', { style: { width: '100%', height: '100%', objectFit: 'cover' }, alt: '' });
      this.app.mediaPool.getURL(asset.id).then((url) => {
        if (url) img.src = url;
      });
      append(thumb, img);
    } else {
      append(thumb, icon(asset.kind === 'audio' ? 'audio' : 'film', 16));
    }
    if (asset.kind === 'video') {
      this.app.mediaPool.getURL(asset.id).then((url) => {
        if (!url) return;
        const video = el('video', { src: url, muted: true, preload: 'metadata', style: { width: '100%', height: '100%', objectFit: 'cover' } });
        video.addEventListener('loadeddata', () => {
          try {
            video.currentTime = Math.min(0.1, (video.duration || 1) / 10);
          } catch {
            /* ignore */
          }
        });
        video.addEventListener('seeked', () => {
          clear(thumb);
          append(thumb, video);
        });
      });
    }

    const info = [];
    info.push(`${ASSET_KINDS[asset.kind]?.label || asset.kind}`);
    if (asset.width && asset.height) info.push(`${asset.width}×${asset.height}`);
    if (asset.durationTicks) info.push(formatDuration(asset.durationTicks));
    const badges = [];
    if (asset.status === 'probing') badges.push(el('span.badge', { text: '読込中' }));
    else if (asset.status === 'error') badges.push(el('span.badge.err', { text: 'エラー' }));
    if (asset.hasAudio) badges.push(el('span.badge', { text: 'A' }));
    if (!this.app.mediaPool.blobs.has(asset.id)) badges.push(el('span.badge.warn', { text: '要再リンク' }));

    const item = el('div.media-item', {
      draggable: 'true',
      dataset: { assetId: asset.id },
      title: 'ダブルクリックで再生ヘッド位置に挿入 / タイムラインへドラッグ',
    }, [
      thumb,
      el('div.media-meta', {}, [
        el('div.media-name', { text: asset.name }),
        el('div.media-info', { text: info.join(' · ') }),
        el('div', {}, badges),
      ]),
      el('div.media-actions', {}, [
        iconButton('plus', { size: 14, title: '再生ヘッド位置に挿入', onclick: (ev) => { ev.stopPropagation(); this.app.insertAssetAtPlayhead(asset.id); } }),
        iconButton('trash', { size: 14, title: '素材を削除', onclick: (ev) => { ev.stopPropagation(); this.confirmRemove(asset); } }),
      ]),
    ]);

    item.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('application/x-qelvoryn-asset', asset.id);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dblclick', () => this.app.insertAssetAtPlayhead(asset.id));
    item.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      contextMenu(ev.target, [
        { label: '再生ヘッド位置に挿入', action: () => this.app.insertAssetAtPlayhead(asset.id) },
        { label: '新しいトラックを作成して挿入', action: () => this.app.insertAssetOnNewTrack(asset.id) },
        { label: '---' },
        { label: '素材の情報', action: () => this.app.showAssetInfo(asset.id) },
        { label: '再リンク (ファイルを選択)', action: () => this.app.relinkAssets() },
        { label: '削除', danger: true, action: () => this.confirmRemove(asset) },
      ]);
    });

    void formatNumber;
    return item;
  }

  confirmRemove(asset) {
    const used = this.store.state.tracks.some((t) => t.clips.some((c) => c.assetId === asset.id));
    const message = used
      ? `「${asset.name}」はタイムラインで使用されています。削除するとクリップからも参照が外れます。削除しますか?`
      : `「${asset.name}」を削除しますか?`;
    this.app.confirm(message, async () => {
      await this.app.mediaPool.removeAsset(asset.id);
      this.render();
    });
  }
}

export { button };
