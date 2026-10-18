import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../src/ui/dom.js', import.meta.url), 'utf8');

function parseBbox(path) {
  let x = 0;
  let y = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const push = () => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  const tokens = path.match(/[MmLlHhVvZz]|-?\d*\.?\d+/g) || [];
  let i = 0;
  let cmd = '';
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      i += 1;
      if (cmd === 'z' || cmd === 'Z') continue;
    }
    const num = () => Number(tokens[i++]);
    if (cmd === 'M' || cmd === 'L') { x = num(); y = num(); push(); }
    else if (cmd === 'm' || cmd === 'l') { x += num(); y += num(); push(); }
    else if (cmd === 'H') { x = num(); push(); }
    else if (cmd === 'h') { x += num(); push(); }
    else if (cmd === 'V') { y = num(); push(); }
    else if (cmd === 'v') { y += num(); push(); }
    else throw new Error(`unsupported path command: ${cmd}`);
  }
  return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

function iconPath(name) {
  const m = SOURCE.match(new RegExp(`\\b${name}: '([^']+)'`));
  assert.ok(m, `icon "${name}" exists in dom.js`);
  return m[1];
}

test('transport icons are optically centered in the 24x24 viewBox', () => {
  for (const name of ['play', 'pause', 'start', 'end', 'prevFrame', 'nextFrame']) {
    const b = parseBbox(iconPath(name));
    assert.ok(Math.abs(b.cx - 12) <= 0.35, `${name} is horizontally centered (got ${b.cx})`);
    assert.ok(Math.abs(b.cy - 12) <= 0.35, `${name} is vertically centered (got ${b.cy})`);
    assert.ok(b.maxY - b.minY >= 12, `${name} uses the full icon height (got ${b.maxY - b.minY})`);
  }
});
