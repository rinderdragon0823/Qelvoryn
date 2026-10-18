/** Lightweight context menu. */

import { el, append, clear } from './dom.js';

let current = null;

export function closeContextMenu() {
  if (current) {
    current.remove();
    current = null;
  }
}

/**
 * @param {HTMLElement} anchor
 * @param {Array<{label?:string, shortcut?:string, disabled?:boolean, danger?:boolean, action?:Function}|'---'>} items
 */
export function contextMenu(anchor, items) {
  closeContextMenu();
  const menu = el('div.context-menu');
  for (const item of items) {
    if (item === '---' || item?.label === '---') {
      append(menu, el('div.sep'));
      continue;
    }
    const node = el('div.item', {
      class: `${item.disabled ? 'disabled' : ''} ${item.danger ? 'danger' : ''}`.trim(),
      onclick: () => {
        closeContextMenu();
        item.action?.();
      },
    }, [
      el('span', { text: item.label }),
      item.shortcut ? el('span.shortcut', { text: item.shortcut }) : null,
    ]);
    append(menu, node);
  }
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 0, top: 0, bottom: 0, right: 0 };
  const menuRect = menu.getBoundingClientRect();
  const x = Math.min(window.innerWidth - menuRect.width - 8, Math.max(4, rect.left));
  const y = Math.min(window.innerHeight - menuRect.height - 8, Math.max(4, rect.bottom + 2));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  current = menu;

  const onDown = (ev) => {
    if (!menu.contains(ev.target)) {
      closeContextMenu();
      document.removeEventListener('pointerdown', onDown, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  return menu;
}

export { clear };
