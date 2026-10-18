/**
 * Qelvoryn entry point.
 * Boots the app, and surfaces a readable error if the environment is too old.
 */

import { QelvorynApp } from './app.js';

async function main() {
  const boot = document.getElementById('boot');
  const fail = (message, detail) => {
    if (boot) {
      boot.classList.remove('hidden');
      boot.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'boot-error';
      box.innerHTML = `<h1>Qelvoryn を起動できません</h1><p></p><pre></pre>`;
      box.querySelector('p').textContent = message;
      box.querySelector('pre').textContent = String(detail || '');
      boot.appendChild(box);
    }
    console.error('[Qelvoryn]', message, detail);
  };

  try {
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      console.warn('[Qelvoryn] このブラウザは録画APIに未対応です（編集は可能ですが書き出しはできません）');
    }
    const app = new QelvorynApp();
    window.qelvoryn = app;
    await app.boot();
    boot?.remove();
    app.setStatus('準備完了。素材を追加してください。', 'ok');
  } catch (err) {
    fail('起動中にエラーが発生しました。', err && err.stack ? err.stack : err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}
