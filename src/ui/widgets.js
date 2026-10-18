/**
 * Form widgets used by the inspector and dialogs.
 * All of them support pointer-drag scrubbing, keyboard nudging and commit on
 * Enter/blur so numeric editing feels like a real NLE.
 */

import { el, append, button, iconButton, icon, formatNumber } from './dom.js';

function clamp(value, min, max) {
  let v = value;
  if (min != null) v = Math.max(min, v);
  if (max != null) v = Math.min(max, v);
  return v;
}

/**
 * Numeric input with drag-to-scrub label.
 * @param {object} spec
 * @returns {{node:HTMLElement, refresh:()=>void, setValue:(v:number)=>void}}
 */
export function numberField(spec = {}) {
  const {
    label, min = -Infinity, max = Infinity, step = 0.01, digits = 2, unit = '',
    onChange, onLive, scrubScale = 1, disabled = false,
  } = spec;
  let value = Number(spec.value) || 0;

  const input = el('input.input.number', {
    type: 'text',
    value: formatNumber(value, digits),
    disabled,
  });
  const unitNode = unit ? el('span.unit', { text: unit }) : null;
  const labelNode = el('span.field-label', { text: label || '' });

  let dragging = false;
  let dragStartX = 0;
  let dragStartValue = 0;
  let moved = false;

  labelNode.addEventListener('pointerdown', (ev) => {
    if (disabled) return;
    ev.preventDefault();
    dragging = true;
    moved = false;
    dragStartX = ev.clientX;
    dragStartValue = value;
    labelNode.setPointerCapture(ev.pointerId);
    labelNode.classList.add('scrubbing');
  });

  labelNode.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - dragStartX;
    if (Math.abs(dx) < 2 && !moved) return;
    moved = true;
    const fine = ev.shiftKey ? 0.1 : 1;
    const next = clamp(dragStartValue + dx * step * scrubScale * fine, min, max);
    value = next;
    input.value = formatNumber(next, digits);
    (onLive || onChange)?.(next);
  });

  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    labelNode.classList.remove('scrubbing');
    try {
      labelNode.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    if (moved) onChange?.(value);
  };
  labelNode.addEventListener('pointerup', endDrag);
  labelNode.addEventListener('pointercancel', endDrag);

  const commitText = () => {
    const parsed = parseFloat(String(input.value).replace(/[^0-9.+-eE]/g, ''));
    if (Number.isFinite(parsed)) {
      const next = clamp(parsed, min, max);
      if (next !== value) {
        value = next;
        onChange?.(next);
      }
    }
    input.value = formatNumber(value, digits);
  };
  input.addEventListener('blur', commitText);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      commitText();
      input.blur();
      ev.preventDefault();
    } else if (ev.key === 'Escape') {
      input.value = formatNumber(value, digits);
      input.blur();
      ev.preventDefault();
    } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const dir = ev.key === 'ArrowUp' ? 1 : -1;
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const next = clamp(value + dir * step * mult, min, max);
      value = next;
      input.value = formatNumber(next, digits);
      onChange?.(next);
    }
  });

  const node = el('div.field.number-field', {}, [labelNode, el('div.input-wrap', {}, [input, unitNode])]);

  return {
    node,
    get value() {
      return value;
    },
    setValue(v) {
      value = clamp(Number(v) || 0, min, max);
      if (document.activeElement !== input) input.value = formatNumber(value, digits);
    },
    refresh() {
      if (document.activeElement !== input) input.value = formatNumber(value, digits);
    },
    setDisabled(v) {
      input.disabled = !!v;
      labelNode.classList.toggle('disabled', !!v);
    },
  };
}

export function colorField(spec = {}) {
  const { label, onChange } = spec;
  let value = spec.value || '#ffffff';
  const input = el('input.input.color', { type: 'color', value });
  input.addEventListener('input', () => {
    value = input.value;
    onChange?.(value);
  });
  const hexText = el('input.input.hex', { type: 'text', value });
  hexText.addEventListener('change', () => {
    if (/^#?[0-9a-f]{6}$/i.test(hexText.value.trim())) {
      value = hexText.value.trim().startsWith('#') ? hexText.value.trim() : `#${hexText.value.trim()}`;
      input.value = value;
      hexText.value = value;
      onChange?.(value);
    }
  });
  const node = el('div.field.color-field', {}, [el('span.field-label', { text: label || '' }), input, hexText]);
  return {
    node,
    setValue(v) {
      value = v;
      input.value = v;
      hexText.value = v;
    },
    refresh() {},
  };
}

export function selectField(spec = {}) {
  const { label, options = [], onChange, disabled } = spec;
  const select = el('select.input.select', { disabled });
  for (const opt of options) {
    append(select, el('option', { value: opt.value, text: opt.label, selected: String(opt.value) === String(spec.value) }));
  }
  select.value = spec.value;
  select.addEventListener('change', () => onChange?.(select.value));
  const node = el('div.field.select-field', {}, [el('span.field-label', { text: label || '' }), select]);
  return {
    node,
    setValue(v) {
      select.value = v;
    },
    refresh() {},
  };
}

export function checkField(spec = {}) {
  const { label, onChange, disabled } = spec;
  const input = el('input', { type: 'checkbox', checked: !!spec.value, disabled });
  input.addEventListener('change', () => onChange?.(input.checked));
  const node = el('label.field.check-field', {}, [input, el('span.field-label', { text: label || '' })]);
  return {
    node,
    setValue(v) {
      input.checked = !!v;
    },
    refresh() {},
  };
}

export function textField(spec = {}) {
  const { label, onChange, placeholder, disabled } = spec;
  const input = el('input.input.text', { type: 'text', value: spec.value ?? '', placeholder, disabled });
  input.addEventListener('change', () => onChange?.(input.value));
  const node = el('div.field.text-field', {}, [
    label ? el('span.field-label', { text: label }) : null,
    input,
  ]);
  return {
    node,
    setValue(v) {
      if (document.activeElement !== input) input.value = v ?? '';
    },
    refresh() {},
  };
}

export function textareaField(spec = {}) {
  const { label, onChange, rows = 4 } = spec;
  const input = el('textarea.input.textarea', { rows });
  input.value = spec.value ?? '';
  input.addEventListener('change', () => onChange?.(input.value));
  input.addEventListener('input', () => onChange?.(input.value));
  const node = el('div.field.textarea-field', {}, [
    label ? el('span.field-label', { text: label }) : null,
    input,
  ]);
  return {
    node,
    setValue(v) {
      if (document.activeElement !== input) input.value = v ?? '';
    },
    refresh() {},
  };
}

export function rangeField(spec = {}) {
  const { label, min = 0, max = 1, step = 0.01, onChange, digits = 2 } = spec;
  let value = Number(spec.value) || 0;
  const range = el('input.input.range', { type: 'range', min, max, step, value });
  const readout = el('span.readout', { text: formatNumber(value, digits) });
  range.addEventListener('input', () => {
    value = Number(range.value);
    readout.textContent = formatNumber(value, digits);
    onChange?.(value);
  });
  const node = el('div.field.range-field', {}, [el('span.field-label', { text: label || '' }), range, readout]);
  return {
    node,
    setValue(v) {
      value = Number(v) || 0;
      range.value = String(value);
      readout.textContent = formatNumber(value, digits);
    },
    refresh() {},
  };
}

/** Collapsible inspector section. */
export function section(title, opts = {}) {
  const body = el('div.section-body');
  const chevron = el('span.chevron', { text: '▾' });
  const header = el('div.section-header', {
    onclick: () => {
      body.classList.toggle('collapsed');
      chevron.textContent = body.classList.contains('collapsed') ? '▸' : '▾';
    },
  }, [chevron, el('span.section-title', { text: title }), opts.actions || null]);
  if (opts.collapsed) {
    body.classList.add('collapsed');
    chevron.textContent = '▸';
  }
  const node = el('div.section', { class: opts.class || '' }, [header, body]);
  return { node, body, header };
}

export function row(children, opts = {}) {
  return el('div.row', { class: opts.class || '' }, children);
}

export function kvRow(label, valueNode) {
  return el('div.row.kv', {}, [el('span.field-label', { text: label }), valueNode]);
}

export { iconButton, icon, button };
