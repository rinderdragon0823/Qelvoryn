import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimestamp, parseSrt, parseVtt, parsePlainText, parseSubtitleFile, cuesToSrt,
} from '../src/auto/subtitles.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
<i>こんにちは</i>
世界

2
00:00:04,000 --> 00:00:06,000
二行目
続き
`;

test('parseTimestamp reads SRT and VTT stamps', () => {
  assert.equal(parseTimestamp('00:00:01,500'), 1500);
  assert.equal(parseTimestamp('00:00:01.500'), 1500);
  assert.equal(parseTimestamp('1:02:03.250'), 3723250);
  assert.equal(parseTimestamp(' 00:00:10,000 '), 10000);
  assert.equal(parseTimestamp('not a stamp'), null);
});

test('parseSrt reads cues, strips markup and joins wrapped lines', () => {
  const cues = parseSrt(SRT);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { startMs: 1000, endMs: 3500, text: 'こんにちは\n世界' });
  assert.deepEqual(cues[1], { startMs: 4000, endMs: 6000, text: '二行目\n続き' });
});

test('parseSrt enforces a minimum cue length and skips broken blocks', () => {
  const cues = parseSrt('1\n00:00:01,000 --> 00:00:01,000\nゼロ長\n\n2\nこわれたブロック\n');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].endMs, 1200, 'zero length cues get a 200ms floor');
});

test('parseVtt ignores the WEBVTT header', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n';
  const cues = parseVtt(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Hello');
  assert.equal(cues[0].startMs, 1000);
});

test('parsePlainText spreads lines with configurable timing and gaps', () => {
  const cues = parsePlainText('A\n\nB\nC', 2);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { startMs: 0, endMs: 2000, text: 'A' });
  assert.deepEqual(cues[1], { startMs: 3000, endMs: 5000, text: 'B' }, 'blank line adds a half-step gap');
  assert.deepEqual(cues[2], { startMs: 5000, endMs: 7000, text: 'C' });
});

test('parseSubtitleFile dispatches on extension and content', () => {
  assert.equal(parseSubtitleFile(SRT, 'movie.srt').length, 2);
  assert.equal(parseSubtitleFile('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nx', 'a.vtt').length, 1);
  assert.equal(parseSubtitleFile('1\n00:00:00,000 --> 00:00:01,000\ny', 'notes.txt').length, 1, 'SRT body without extension');
  const plain = parseSubtitleFile('ひとつ\nふたつ', 'memo.txt', { secondsPerLine: 1.5 });
  assert.equal(plain.length, 2);
  assert.equal(plain[1].startMs, 1500);
});

test('cuesToSrt round trips through parseSrt', () => {
  const cues = [
    { startMs: 0, endMs: 1500, text: 'one' },
    { startMs: 2000, endMs: 4100, text: 'two\nlines' },
  ];
  const srt = cuesToSrt(cues);
  assert.ok(srt.includes('00:00:00,000 --> 00:00:01,500'));
  assert.ok(srt.includes('00:00:02,000 --> 00:00:04,100'));
  assert.deepEqual(parseSrt(srt), cues);
});
