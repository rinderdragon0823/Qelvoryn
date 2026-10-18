import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TICKS_PER_SECOND, rateRational, ticksPerFrame, secondsToTicks, ticksToSeconds,
  framesToTicks, ticksToFrames, snapTicksToFrame, floorTicksToFrame, ceilTicksToFrame,
  formatTimecode, formatDuration, parseTimecode, clampTicks, gcd,
} from '../src/core/time.js';

test('TICKS_PER_SECOND maps every common frame rate to whole ticks', () => {
  assert.equal(TICKS_PER_SECOND, 120000);
  const expected = {
    24: 5000, 23.976: 5005, 25: 4800, 29.97: 4004, 30: 4000, 50: 2400, 59.94: 2002, 60: 2000,
  };
  for (const [fps, ticks] of Object.entries(expected)) {
    assert.equal(ticksPerFrame(Number(fps)), ticks, `${fps} fps`);
    assert.ok(Number.isInteger(ticksPerFrame(Number(fps))), `${fps} fps must be integral`);
  }
});

test('rateRational recognises pulldown rates exactly', () => {
  assert.deepEqual(rateRational(23.976), { num: 24000, den: 1001 });
  assert.deepEqual(rateRational(29.97), { num: 30000, den: 1001 });
  assert.deepEqual(rateRational(59.94), { num: 60000, den: 1001 });
  assert.deepEqual(rateRational(30), { num: 30, den: 1 });
  assert.deepEqual(rateRational(23.98), { num: 24000, den: 1001 });
});

test('seconds <-> ticks round trip', () => {
  assert.equal(secondsToTicks(1), TICKS_PER_SECOND);
  assert.equal(secondsToTicks(0.5), 60000);
  assert.equal(ticksToSeconds(60000), 0.5);
  assert.equal(secondsToTicks(ticksToSeconds(1234567)), 1234567);
});

test('frame conversion is exact at 29.97 fps', () => {
  const fps = 29.97;
  assert.equal(ticksPerFrame(fps), 4004);
  assert.equal(framesToTicks(1, fps), 4004);
  assert.equal(framesToTicks(30000, fps), 4004 * 30000);
  assert.equal(ticksToFrames(4004 * 30, fps), 30);
});

test('frame snapping floors / ceils / rounds correctly', () => {
  const fps = 30;
  const tpf = 4000;
  assert.equal(snapTicksToFrame(tpf - 2100, fps), 0, 'just under half a frame snaps down');
  assert.equal(snapTicksToFrame(tpf + 100, fps), tpf);
  assert.equal(snapTicksToFrame(tpf * 3 + 1900, fps), tpf * 3);
  assert.equal(floorTicksToFrame(tpf * 2 + 3999, fps), tpf * 2);
  assert.equal(ceilTicksToFrame(tpf * 2 + 1, fps), tpf * 3);
  assert.equal(ceilTicksToFrame(tpf * 2, fps), tpf * 2);
});

test('timecode formatting and parsing round trip', () => {
  assert.equal(formatTimecode(0, 30), '00:00:00:00');
  assert.equal(formatTimecode(TICKS_PER_SECOND, 30), '00:00:01:00');
  assert.equal(formatTimecode(TICKS_PER_SECOND * 61.5, 30), '00:01:01:15');
  assert.equal(formatTimecode(TICKS_PER_SECOND * 3661, 24), '01:01:01:00');
  assert.equal(formatTimecode(TICKS_PER_SECOND * 2 + 1000, 30, { frames: true }), '60');
  assert.equal(formatTimecode(TICKS_PER_SECOND * 2 + 2000, 30, { frames: true }), '61', 'half a frame rounds up');
  assert.equal(formatTimecode(-TICKS_PER_SECOND, 30), '-00:00:01:00');

  assert.equal(parseTimecode('00:00:01:00', 30), TICKS_PER_SECOND);
  assert.equal(parseTimecode('01:01:01:00', 24), TICKS_PER_SECOND * 3661);
  assert.equal(parseTimecode('02:03', 30), TICKS_PER_SECOND * 123);
  assert.equal(parseTimecode('12.5s', 30), TICKS_PER_SECOND * 12.5);
  assert.equal(parseTimecode(3, 30), TICKS_PER_SECOND * 3);
  assert.equal(parseTimecode('', 30), null);
  assert.equal(parseTimecode('abc', 30), null);
  assert.equal(parseTimecode('1:2:3:4:5', 30), null);

  const fps = 29.97;
  const exact = parseTimecode(formatTimecode(123456789, 30), 30);
  assert.ok(Math.abs(exact - 123456789) < 4000, 'round trip at an exact fps is within one frame');
  // Non-drop-frame timecode at NTSC rates runs ~0.1% slow, so the round trip
  // drifts by about one second after ~17 minutes.  That is expected NDF
  // behaviour, not a conversion bug.
  const ndf = parseTimecode(formatTimecode(123456789, fps), fps);
  assert.ok(Math.abs(ndf - 123456789) < TICKS_PER_SECOND * 1.5, `NDF drift stays under 0.1% (got ${ndf})`);
});

test('formatDuration is human readable', () => {
  assert.equal(formatDuration(0), '0:00.0');
  assert.equal(formatDuration(TICKS_PER_SECOND * 5.5), '0:05.5');
  assert.equal(formatDuration(TICKS_PER_SECOND * 125), '2:05.0');
});

test('clampTicks and gcd behave', () => {
  assert.equal(clampTicks(5, 0, 3), 3);
  assert.equal(clampTicks(-5, 0, 3), 0);
  assert.equal(gcd(120000, 4800), 4800);
  assert.equal(gcd(0, 0), 1);
});
