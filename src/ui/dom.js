/** Tiny DOM helpers (no framework, no dependencies). */

/**
 * @param {string} tag  tag name, optionally with `.class` and `#id` suffixes
 * @param {object} [props]
 * @param {Array|Node|string} [children]
 */
export function el(tag, props = {}, children = []) {
  const match = /^([a-zA-Z0-9-]+)?([.#][^ ]*)?$/.exec(tag) || [];
  const name = match[1] || 'div';
  const node = document.createElement(name);
  if (match[2]) {
    for (const cls of match[2].split(/[.#]/).filter(Boolean)) node.classList.add(cls);
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = `${node.className} ${value}`.trim();
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') node[key] = !!value;
    else node.setAttribute(key, value);
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    if (typeof child === 'string') {
      parent.appendChild(document.createTextNode(child));
      continue;
    }
    let node = child;
    if (node.nodeType == null && node.node && node.node.nodeType != null) {
      console.warn('[Qelvoryn] append: {node} オブジェクトを展開しました (.node を渡してください)', node);
      node = node.node;
    }
    if (node.nodeType == null) {
      console.warn('[Qelvoryn] append: Node 以外の値は無視しました', node);
      continue;
    }
    parent.appendChild(node);
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function on(node, event, handler, opts) {
  node.addEventListener(event, handler, opts);
  return () => node.removeEventListener(event, handler, opts);
}

export function icon(name, size = 16) {
  const paths = {
    play: 'M7 5l10 7-10 7z',
    pause: 'M6.5 5h4v14h-4zM13.5 5h4v14h-4z',
    stop: 'M4.5 4.5h11v11h-11z',
    start: 'M7 5h2.6v14H7zM17 5v14l-7.4-7z',
    end: 'M7 5l7.4 7L7 19zM14.4 5H17v14h-2.6z',
    prevFrame: 'M11 5v14l-6.4-7zM19.4 5v14l-6.4-7z',
    nextFrame: 'M4.6 5v14l6.4-7zM13 5v14l6.4-7z',
    scissors: 'M9.6 6.6L14 2h3v2h-2l-4.2 4.2c.4.6.6 1.3.6 2 0 2.2-1.8 4-4 4s-4-1.8-4-4 1.8-4 4-4c.8 0 1.5.2 2.2.6zm-2.4 6.6c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7.4-3.4L17 12l-4.6 4.4c.4-.6.6-1.3.6-2 0-1.6-.9-2.9-2.1-3.5l3.1-3.1z',
    trash: 'M6 7h12l-1 13H7L6 7zm3-3h6l1 2H8l1-2z',
    copy: 'M8 3h9v14H8zM5 6h2v13h9v2H5z',
    undo: 'M12 6c3.9 0 7 2.7 7 6.5S16 19 12 19H7v-2h5c2.8 0 5-1.8 5-4.5S14.8 8 12 8V5L6 11l6 6V6z',
    redo: 'M12 6c-3.9 0-7 2.7-7 6.5S8 19 12 19h5v-2h-5c-2.8 0-5-1.8-5-4.5S9.2 8 12 8V5l6 6-6 6V6z',
    plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
    lock: 'M7 10V8a5 5 0 0110 0v2h1v10H6V10h1zm2 0h6V8a3 3 0 00-6 0v2z',
    unlock: 'M7 10V8a5 5 0 019.5-2l-1.8.8A3 3 0 009 8v2h9v10H6V10h1z',
    eye: 'M12 5c5 0 9 4.5 9 7s-4 7-9 7-9-4.5-9-7 4-7 9-7zm0 3a4 4 0 100 8 4 4 0 000-8z',
    eyeOff: 'M3 4.3L4.3 3l16.7 16.7-1.3 1.3-3-3A9.9 9.9 0 0112 19c-5 0-9-4.5-9-7 0-1.2 1-2.9 2.7-4.3L3 4.3zM12 8a4 4 0 013.9 3.1l-4-4c.3-.1.6-.1 1-.1z',
    speaker: 'M4 9h3l4-4v14l-4-4H4zM14.5 8.5a5 5 0 010 7l-1.4-1.4a3 3 0 000-4.2z',
    mute: 'M4 9h3l4-4v14l-4-4H4zM15 9.5l4 5m0-5l-4 5',
    download: 'M11 4h2v9l3.5-3.5 1.4 1.4L12 16.8 6.1 10.9l1.4-1.4L11 13zM5 18h14v2H5z',
    settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zm9 4l-2-1 .5-2.2-2-1.2-1.7 1.4-2-.9L13 6h-2.4l-.7 2-2 .9L6.2 7.5l-2 1.2.5 2.2-2 1v2.4l2 1-.5 2.2 2 1.2 1.7-1.4 2 .9.7 2H13l.8-2 2-.9 1.7 1.4 2-1.2-.5-2.2 2-1v-2.4z',
    sparkles: 'M9 3l1.6 4.4L15 9l-4.4 1.6L9 15l-1.6-4.4L3 9l4.4-1.6zM17 13l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z',
    key: 'M12 3l4 4-3 3-1-1-5 5v3H5v-3l7-7-1-1z',
    film: 'M4 4h16v16H4zm2 2v3h3V6zm5 0v3h3V6zm5 0v3h3V6zM6 11v3h3v-3zm5 0v3h3v-3zm5 0v3h3v-3zM6 16v2h3v-2zm8 0v2h4v-2z',
    zoomIn: 'M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10zm-1 2h2v2h2v2h-2v2h-2v-2H7V9h2z',
    zoomOut: 'M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10zM7 9h6v2H7z',
    magnet: 'M6 4h4v7a2 2 0 004 0V4h4v7a6 6 0 01-12 0z',
    text: 'M5 5h14v3h-5.5v11h-3V8H5z',
    image: 'M4 5h16v14H4zm2 2v8l4-4 3 3 3-3 4 4V7z',
    audio: 'M12 3v11.5a3.5 3.5 0 11-2-3.2V5l10-2v9.5a3.5 3.5 0 11-2-3.2V6z',
    layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5-2-1.1L12 16 5 11.9z',
    effect: 'M12 2l2.4 6.2L21 10l-6.6 1.8L12 18l-2.4-6.2L3 10l6.6-1.8z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || paths.film);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

export function button(label, opts = {}) {
  const node = el('button', {
    class: `btn ${opts.variant || ''} ${opts.class || ''}`.trim(),
    title: opts.title || label,
    onclick: opts.onclick,
    disabled: opts.disabled,
  });
  if (opts.icon) append(node, [icon(opts.icon, opts.iconSize || 15)]);
  if (label) append(node, el('span.text', { text: label }));
  return node;
}

export function iconButton(name, opts = {}) {
  const node = el('button', {
    class: `icon-btn ${opts.class || ''}`.trim(),
    title: opts.title || name,
    onclick: opts.onclick,
    disabled: opts.disabled,
  });
  append(node, icon(name, opts.size || 16));
  return node;
}

export function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '0';
  const fixed = Number(value).toFixed(digits);
  return fixed.replace(/\.?0+$/, '') || '0';
}

export function debounce(fn, ms = 150) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let timer = 0;
  return (...args) => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => {
        last = performance.now();
        fn(...args);
      }, ms - (now - last));
    }
  };
}
