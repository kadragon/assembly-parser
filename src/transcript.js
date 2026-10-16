/**
 * Turn a finalized AI subtitle message into a transcript line, or null.
 *
 * The server streams interim results per segment (final=false), then a final
 * one, then often a second final with scd=true where speaker turns are split
 * and new turns are prefixed with "-". Later finals overwrite earlier ones.
 */
export function toLine(msg) {
  if (msg?.segment === undefined || !msg.final) return null;
  const text =
    Array.isArray(msg.transcripts) && msg.transcripts.length
      ? msg.transcripts
          .map(([, t]) => String(t).trim())
          .filter(Boolean)
          .join('\n')
      : String(msg.transcript ?? '').trim();
  if (!text) return null;
  return {
    // segment ids restart when the STT server restarts; the audio offset disambiguates
    key: `${msg.segment}:${msg['segment-offset']}`,
    ts: Date.parse(msg['send-timestamp']),
    text,
  };
}

/** Ordered, de-duplicated transcript keyed by segment. */
export class Transcript {
  #lines = new Map();

  upsert(line) {
    const prev = this.#lines.get(line.key);
    // keep the first-seen timestamp so a segment never jumps windows
    this.#lines.set(line.key, prev ? { ...line, ts: prev.ts } : line);
  }

  lines() {
    return [...this.#lines.values()].sort((a, b) => a.ts - b.ts);
  }

  between(start, end) {
    return this.lines().filter((l) => l.ts >= start && l.ts < end);
  }
}

/** True if any line mentions a keyword; spaces are ignored because STT spacing is unreliable. */
export function mentions(lines, keywords) {
  const squash = (s) => s.replace(/\s+/g, '');
  const keys = keywords.map(squash).filter(Boolean);
  return lines.some((l) => keys.some((k) => squash(l.text).includes(k)));
}

export function windowStart(ts, windowMs) {
  return Math.floor(ts / windowMs) * windowMs;
}

/**
 * Starts of windows with lines that closed at least graceMs ago, oldest first.
 * Lines are stamped with the server's send time but land in the file seconds later,
 * so a window processed right at its boundary would miss its last captions.
 */
export function closedWindows(lines, windowMs, now, graceMs) {
  return [...new Set(lines.map((l) => windowStart(l.ts, windowMs)))]
    .filter((s) => s + windowMs + graceMs <= now)
    .sort((a, b) => a - b);
}
