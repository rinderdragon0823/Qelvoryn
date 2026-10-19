import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { normalizeProject, projectDuration } from '../src/core/model.js';
import { PROJECT_FILE_FORMAT } from '../src/core/persist.js';
import { TICKS_PER_SECOND } from '../src/core/time.js';

const root = new URL('../', import.meta.url);

test('demo project is valid and showcases the editor', () => {
  const raw = fs.readFileSync(new URL('demo/demo.qelvoryn.json', root), 'utf8');
  const payload = JSON.parse(raw);
  assert.equal(payload.format, PROJECT_FILE_FORMAT);
  const project = payload.project;
  const duration = projectDuration(project);
  assert.ok(duration >= 10 * TICKS_PER_SECOND, 'demo is at least ten seconds long');
  assert.ok(project.tracks.length >= 6, 'multiple layers');

  const clips = project.tracks.flatMap((t) => t.clips);
  assert.ok(clips.length >= 15, `enough clips (${clips.length})`);
  assert.ok(clips.some((c) => c.type === 'text' && c.text?.content?.includes('Qelvoryn')), 'has the title card');
  assert.ok(clips.filter((c) => c.type === 'text').length >= 6, 'has titles and subtitles');
  assert.ok(
    clips.some((c) => c.type === 'effect' && c.effects?.some((fx) => fx.type === 'cameraTransform')),
    'has a camera zoom effect',
  );
  assert.ok(
    clips.some((c) => c.type === 'shape' && (c.effects || []).length > 0),
    'has effect-driven vector shapes',
  );
  assert.ok(
    project.settings.workArea && project.settings.workArea.outTicks > project.settings.workArea.inTicks,
    'work area survives normalisation',
  );
  assert.ok(project.markers.length >= 4, 'chapter markers');

  const before = {
    tracks: project.tracks.length,
    clips: clips.length,
  };
  normalizeProject(project);
  assert.equal(project.tracks.length, before.tracks);
  assert.equal(project.tracks.flatMap((t) => t.clips).length, before.clips, 'normalising keeps every clip');
  for (const clip of project.tracks.flatMap((t) => t.clips)) {
    assert.ok(
      clip.startTicks + clip.durationTicks <= duration + 1,
      `${clip.name} fits inside the demo duration`,
    );
  }
});

test('demo video and poster are published', () => {
  const video = fs.statSync(new URL('demo/demo.mp4', root));
  assert.ok(video.size > 200 * 1024, `demo.mp4 has real video data (${video.size} bytes)`);
  const poster = fs.statSync(new URL('demo/poster.jpg', root));
  assert.ok(poster.size > 5 * 1024, 'poster.jpg exists');
});
