/**
 * Subtitle import: SRT / WebVTT / plain text.
 *
 * Qelvoryn does not invent subtitles - candidates come from a real transcript
 * file the user provides (or from text the user pastes), and every generated
 * line becomes a normal, fully editable text clip.
 */

export function parseTimestamp(text) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(String(text).trim());
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = parseInt(m[2], 10);
  const seconds = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

/** @returns {{startMs:number, endMs:number, text:string}[]} */
export function parseSrt(content) {
  const blocks = String(content).replace(/\r/g, '').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex < 0) continue;
    const [from, to] = lines[timeLineIndex].split('-->');
    const startMs = parseTimestamp(from);
    const endMs = parseTimestamp(to);
    if (startMs == null || endMs == null) continue;
    const text = lines.slice(timeLineIndex + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    cues.push({ startMs, endMs: Math.max(endMs, startMs + 200), text });
  }
  return cues;
}

export function parseVtt(content) {
  const body = String(content).replace(/\r/g, '').replace(/^WEBVTT.*?\n\n/s, '');
  return parseSrt(body);
}

/**
 * Plain text: split into lines, each line gets `secondsPerLine`.
 * Empty lines are preserved as timing gaps.
 */
export function parsePlainText(content, secondsPerLine = 2.5) {
  const lines = String(content).replace(/\r/g, '').split('\n');
  const cues = [];
  let t = 0;
  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      t += secondsPerLine * 0.5;
      continue;
    }
    cues.push({ startMs: Math.round(t * 1000), endMs: Math.round((t + secondsPerLine) * 1000), text });
    t += secondsPerLine;
  }
  return cues;
}

export function parseSubtitleFile(content, filename = '', opts = {}) {
  const name = filename.toLowerCase();
  if (name.endsWith('.vtt') || /^WEBVTT/i.test(content)) return parseVtt(content);
  if (name.endsWith('.srt') || content.includes('-->')) return parseSrt(content);
  return parsePlainText(content, opts.secondsPerLine || 2.5);
}

export function cuesToSrt(cues) {
  const stamp = (ms) => {
    const total = Math.max(0, Math.round(ms));
    const h = String(Math.floor(total / 3600000)).padStart(2, '0');
    const m = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
    const cs = String(total % 1000).padStart(3, '0');
    return `${h}:${m}:${s},${cs}`;
  };
  return cues.map((cue, i) => `${i + 1}\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${cue.text}\n`).join('\n');
}
