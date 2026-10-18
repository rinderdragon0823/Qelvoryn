import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);

test('every page declares a favicon (prevents the /favicon.ico 404)', () => {
  for (const page of ['index.html', 'tests.html']) {
    const html = fs.readFileSync(new URL(page, root), 'utf8');
    assert.ok(html.includes('rel="icon"'), `${page} declares rel="icon"`);
  }
});

test('favicon files are present and valid', () => {
  const svg = fs.readFileSync(new URL('favicon.svg', root), 'utf8');
  assert.ok(svg.trimStart().startsWith('<svg'), 'favicon.svg is an SVG document');
  assert.ok(svg.includes('34d3c0'), 'favicon.svg keeps the brand color');

  const ico = fs.readFileSync(new URL('favicon.ico', root));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type is icon');
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 1, 'ICO contains at least one image');
  const dataOffset = ico.readUInt32LE(6 + 12);
  assert.equal(ico.readUInt32LE(dataOffset), 40, 'first ICO image is a BITMAPINFOHEADER bitmap');
});
