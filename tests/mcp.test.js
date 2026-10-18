import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSession, handleMessage, TOOLS } from '../tools/mcp-server.mjs';

const SERVER_PATH = fileURLToPath(new URL('../tools/mcp-server.mjs', import.meta.url));

let tmpDir;

function tempProject(name = 'demo.qelvoryn.json') {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qelvoryn-mcp-'));
  return path.join(tmpDir, name);
}

async function call(session, name, args = {}) {
  const res = await handleMessage(session, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  });
  return res.result;
}

function parse(result) {
  assert.ok(result?.content?.[0]?.text, 'tool result has text content');
  return JSON.parse(result.content[0].text);
}

test('initialize / tools/list / unknown method behave per MCP spec', async () => {
  const session = createSession();
  const init = await handleMessage(session, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0' } },
  });
  assert.equal(init.result.serverInfo.name, 'qelvoryn');
  assert.deepEqual(init.result.capabilities, { tools: {} });

  const list = await handleMessage(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.result.tools.length >= 20, `expected many tools, got ${list.result.tools.length}`);
  for (const tool of list.result.tools) {
    assert.ok(tool.name.startsWith('qelvoryn_'), `${tool.name} is namespaced`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 10);
  }
  assert.equal(TOOLS.length, list.result.tools.length);

  const notif = await handleMessage(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif, null, 'notifications produce no response');

  const unknown = await handleMessage(session, { jsonrpc: '2.0', id: 3, method: 'bogus/method' });
  assert.equal(unknown.error.code, -32601);
});

test('full editing flow: open, edit, save, reopen', async () => {
  const file = tempProject();

  // --- open (creates a fresh project) -------------------------------------
  const session = createSession();
  const opened = parse(await call(session, 'qelvoryn_open_project', { path: file }));
  assert.equal(opened.layers.length, 1);
  assert.equal(opened.layers[0].name, 'レイヤー 1');

  // --- layer + text --------------------------------------------------------
  const layer = parse(await call(session, 'qelvoryn_add_layer', { name: 'テロップ' }));
  assert.equal(layer.index, 0);

  const text = parse(await call(session, 'qelvoryn_add_text', {
    text: 'こんにちは、世界', startSec: 1, durationSec: 2.5, layerId: layer.layerId,
  }));
  assert.equal(text.layer, 'テロップ');

  const clip = parse(await call(session, 'qelvoryn_get_clip', { clipId: text.clipId }));
  assert.equal(clip.clip.type, 'text');
  assert.equal(clip.clip.text.content, 'こんにちは、世界');
  assert.equal(clip.clip.transform.y, 0.86, 'subtitle preset sits near the bottom');
  assert.equal(clip.startSec, 1);
  assert.equal(clip.durationSec, 2.5);

  // --- keyframes -----------------------------------------------------------
  await call(session, 'qelvoryn_add_keyframe', {
    clipId: text.clipId, path: 'transform.x', atSec: 1, value: 0.2, interp: 'easeInOut',
  });
  await call(session, 'qelvoryn_add_keyframe', {
    clipId: text.clipId, path: 'transform.x', atSec: 3.5, value: 0.8,
  });
  const withKeys = parse(await call(session, 'qelvoryn_get_clip', { clipId: text.clipId }));
  assert.equal(withKeys.clip.keyframes['transform.x'].length, 2);
  assert.equal(withKeys.clip.keyframes['transform.x'][0].v, 0.2);

  // --- split + trim --------------------------------------------------------
  const split = parse(await call(session, 'qelvoryn_split_clip', { clipId: text.clipId, atSec: 2 }));
  assert.equal(split.clips.length, 2, 'one clip became two');
  const leftClip = split.clips.find((c) => c.startSec === 1);
  const rightClip = split.clips.find((c) => c.startSec === 2);
  assert.ok(leftClip && rightClip);
  assert.equal(leftClip.durationSec, 1);

  const trimmed = parse(await call(session, 'qelvoryn_trim_clip', {
    clipId: rightClip.clipId, edge: 'right', deltaSec: -0.5,
  }));
  assert.equal(trimmed.durationSec, 1);
  const legacyKeyframes = parse(await call(session, 'qelvoryn_get_clip', { clipId: rightClip.clipId }));
  assert.equal(legacyKeyframes.clip.keyframes['transform.x'].length, 2, 'both keyframes travel with the right half');
  assert.ok(legacyKeyframes.clip.keyframes['transform.x'][0].t < 0, 'keyframes trimmed into the past stay (negative local time)');

  // --- property + subtitles + zoom ----------------------------------------
  await call(session, 'qelvoryn_set_clip_prop', { clipId: text.clipId, path: 'opacity', value: 0.5 });
  const faded = parse(await call(session, 'qelvoryn_get_clip', { clipId: text.clipId }));
  assert.equal(faded.clip.opacity, 0.5);

  const subs = parse(await call(session, 'qelvoryn_add_subtitles', {
    cues: [
      { startSec: 5, endSec: 6, text: 'その一' },
      { startSec: 6, endSec: 7, text: 'その二' },
    ],
  }));
  assert.equal(subs.count, 2);

  const zoom = parse(await call(session, 'qelvoryn_add_camera_zoom', { startSec: 0, durationSec: 1, scale: 1.8 }));
  assert.equal(zoom.scale, 1.8);
  const tracks = parse(await call(session, 'qelvoryn_list_tracks'));
  assert.equal(tracks[0].name, 'ズーム', 'zoom layer sits on top');

  // --- markers / work area / project --------------------------------------
  await call(session, 'qelvoryn_add_marker', { atSec: 2, name: 'カット' });
  const wa = parse(await call(session, 'qelvoryn_set_work_area', { inSec: 1, outSec: 7 }));
  assert.deepEqual(wa.workArea, { inSec: 1, outSec: 7 });
  const renamed = parse(await call(session, 'qelvoryn_set_project', { name: 'テスト動画', fps: 60 }));
  assert.equal(renamed.name, 'テスト動画');
  assert.equal(renamed.fps, 60);

  // --- save + reopen -------------------------------------------------------
  const saved = parse(await call(session, 'qelvoryn_save_project', {}));
  assert.equal(saved.saved, file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.format, 'qelvoryn-project');
  assert.equal(raw.project.name, 'テスト動画');

  const session2 = createSession();
  const reopened = parse(await call(session2, 'qelvoryn_open_project', { path: file }));
  assert.equal(reopened.name, 'テスト動画');
  assert.equal(reopened.fps, 60);
  assert.equal(reopened.layers.length, tracks.length);
  const clips = parse(await call(session2, 'qelvoryn_list_clips', {}));
  assert.ok(clips.length >= 5, `clips survive the round trip (${clips.length})`);
});

test('tool errors are reported as isError results', async () => {
  const session = createSession();
  const notOpen = await call(session, 'qelvoryn_project_summary', {});
  assert.equal(notOpen.isError, true);
  assert.match(notOpen.content[0].text, /開かれていません/);

  const missing = await call(session, 'qelvoryn_open_project', { path: 'Z:\\does\\not\\exist.qelvoryn.json', createIfMissing: false });
  assert.equal(missing.isError, true);

  const unknown = await call(session, 'qelvoryn_nope', {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /未知のツール/);

  await call(session, 'qelvoryn_open_project', { path: tempProject('errors.qelvoryn.json') });
  const badTrim = await call(session, 'qelvoryn_trim_clip', { clipId: 'nope', edge: 'right', deltaSec: 1 });
  assert.equal(badTrim.isError, true);
  const badCue = await call(session, 'qelvoryn_add_subtitles', { cues: [{ startSec: 'x', text: 'a' }] });
  assert.equal(badCue.isError, true);
});

test('the server speaks MCP over stdio as a real process', async () => {
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'e2e', version: '0' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'qelvoryn_open_project', arguments: { path: tempProject('e2e.qelvoryn.json') } },
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('e2e timeout')), 10000);
    const check = () => {
      if (lines.length >= 3) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
  child.kill();

  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.serverInfo.name, 'qelvoryn');
  assert.equal(lines[1].id, 2);
  assert.ok(lines[1].result.tools.length >= 20);
  assert.equal(lines[2].id, 3);
  assert.equal(lines[2].result.isError, undefined);
  assert.ok(lines[2].result.content[0].text.includes('レイヤー 1'));
});
