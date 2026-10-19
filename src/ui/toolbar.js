/**
 * Top toolbar: project actions, undo/redo, edit commands, snap, AI, export.
 */

import { el, button, iconButton } from './dom.js';
import { autoDirectorDialog, exportDialog, helpDialog, projectSettingsDialog, settingsDialog, promptDialog } from './dialogs.js';
import { formatDuration } from '../core/time.js';

export const APP_VERSION = '1.0.0';

export class Toolbar {
  constructor(app) {
    this.app = app;
    this.undoBtn = null;
    this.redoBtn = null;
    this.snapBtn = null;
    this.timecodeNode = el('span.tool-timecode', { text: '0:00:00:00' });
    this.saveState = el('span.save-state', { text: '' });
    this.nameNode = el('button.project-name', {
      text: app.store.state.name,
      title: 'クリックで名前を変更',
      onclick: () => this.renameProject(),
    });

    this.node = el('header.toolbar', {}, [
      el('div.brand', {}, [
        el('div.brand-mark', { text: 'Q' }),
        el('div', {}, [
          el('div.brand-name', { text: 'Qelvoryn' }),
          el('div.brand-sub', { text: `browser NLE v${APP_VERSION}` }),
        ]),
      ]),
      el('div.toolbar-sep'),
      this.nameNode,
      this.saveState,
      el('div', { style: { flex: '1 1 auto' } }),
      this.buildEditGroup(),
      el('div.toolbar-sep'),
      this.buildViewGroup(),
      el('div', { style: { flex: '1 1 auto' } }),
      this.timecodeNode,
      el('div.toolbar-sep'),
      this.buildFileGroup(),
    ]);

    this.refresh();
    app.store.on('change', () => this.refresh());
  }

  buildEditGroup() {
    this.undoBtn = iconButton('undo', { title: '元に戻す (Ctrl+Z)', onclick: () => this.app.undo() });
    this.redoBtn = iconButton('redo', { title: 'やり直す (Ctrl+Shift+Z)', onclick: () => this.app.redo() });
    const split = iconButton('scissors', { title: '再生ヘッドで分割 (K)', onclick: () => this.app.splitAtPlayhead() });
    const del = iconButton('trash', { title: '選択を削除 (Delete)', onclick: () => this.app.deleteSelection() });
    const dup = iconButton('copy', { title: '選択を複製 (Ctrl+D)', onclick: () => this.app.duplicateSelection() });
    const marker = iconButton('key', { title: 'マーカーを追加 (M)', onclick: () => this.app.addMarkerAt() });
    const subtitle = iconButton('text', { title: '再生ヘッドに字幕を追加', onclick: () => this.app.addSubtitleAtPlayhead() });
    return el('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, [this.undoBtn, this.redoBtn, split, del, dup, marker, subtitle]);
  }

  buildViewGroup() {
    this.snapBtn = iconButton('magnet', {
      title: 'スナップ (S)',
      class: 'toggle',
      onclick: () => this.app.setSnapEnabled(!this.app.session.snapEnabled),
    });
    const fit = iconButton('zoomIn', { title: '全体表示 (F)', onclick: () => this.app.zoomToFit() });
    const zoomIn = iconButton('plus', { title: 'ズームイン (+)', onclick: () => this.app.zoomBy(1.35) });
    const zoomOut = iconButton('zoomOut', { title: 'ズームアウト (−)', onclick: () => this.app.zoomBy(1 / 1.35) });
    return el('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, [this.snapBtn, zoomOut, zoomIn, fit]);
  }

  buildFileGroup() {
    return el('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, [
      iconButton('plus', { title: '新規プロジェクト', onclick: () => this.app.newProject() }),
      button('デモ', { icon: 'film', title: 'デモプロジェクトを開く', onclick: () => this.app.loadDemo() }),
      iconButton('download', { title: 'プロジェクトをJSONで保存', onclick: () => this.app.persistence.exportProjectFile() }),
      button('AI演出', { icon: 'sparkles', title: '自動ズーム・クリック演出・字幕', onclick: () => autoDirectorDialog(this.app) }),
      button('書き出し', { icon: 'download', title: '動画を書き出す (Ctrl+E)', onclick: () => exportDialog(this.app) }),
      iconButton('settings', { title: 'プロジェクト設定', onclick: () => projectSettingsDialog(this.app) }),
      iconButton('layers', { title: '設定（保存・再リンク）', onclick: () => settingsDialog(this.app) }),
      iconButton('film', { title: '使い方 / ショートカット', onclick: () => helpDialog() }),
    ]);
  }

  async renameProject() {
    const name = await promptDialog('プロジェクト名', {
      title: 'プロジェクト名の変更',
      value: this.app.store.state.name,
    });
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    this.app.store.transact('プロジェクト名を変更', () => {
      this.app.store.touch(['name']);
      this.app.store.state.name = trimmed;
    });
  }

  refresh() {
    const store = this.app.store;
    if (this.undoBtn) {
      this.undoBtn.disabled = store.undoStack.length === 0;
      this.undoBtn.title = store.undoStack.length
        ? `元に戻す: ${store.undoStack[store.undoStack.length - 1].label} (Ctrl+Z)`
        : '元に戻す (Ctrl+Z)';
    }
    if (this.redoBtn) {
      this.redoBtn.disabled = store.redoStack.length === 0;
      this.redoBtn.title = store.redoStack.length
        ? `やり直す: ${store.redoStack[store.redoStack.length - 1].label} (Ctrl+Shift+Z)`
        : 'やり直す (Ctrl+Shift+Z)';
    }
    if (this.snapBtn) this.snapBtn.classList.toggle('active', !!this.app.session.snapEnabled);
    this.nameNode.textContent = store.state.name;
    this.timecodeNode.textContent = `${formatDuration(this.app.session.playheadTicks)} / ${formatDuration(this.app.projectDuration())}`;
    if (this.saveState) {
      const saved = this.app.persistence?.lastSavedAt;
      this.saveState.textContent = saved ? `保存済み ${new Date(saved).toLocaleTimeString('ja-JP')}` : '';
    }
  }

  setTimecode(text) {
    this.timecodeNode.textContent = text;
  }
}
