import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { dirname, join } from 'node:path';

export const SEGMENT_MS = 5 * 60 * 60 * 1000;
const SEGMENT_FILE = /-(\d{8}T\d{4}Z)\.(csv|jsonl)$/;
export const segmentStart = (nowMs) => Math.floor(nowMs / SEGMENT_MS) * SEGMENT_MS;
/** 2026-09-21T10:00:00.000Z -> 20260921T1000Z */
export const segmentLabel = (startMs) => new Date(startMs).toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z';

/**
 * Append-only text files cut into five-hour segments. The open segment is plain
 * text; a closed segment is gzipped once and never touched again, so a Git
 * commit of closed segments only ever adds new files.
 */
export class SegmentWriter {
  constructor({ root, headers = {}, now = Date.now, onError = (error) => console.error('Maya recorder segment error', error) }) {
    this.root = root; this.headers = headers; this.now = now; this.onError = onError;
    this.current = segmentStart(now());
    this.streams = new Map();
    this.compressing = Promise.resolve();
    mkdirSync(root, { recursive: true });
  }
  label() { return segmentLabel(this.current); }
  file(stream, startMs = this.current) {
    const label = segmentLabel(startMs), extension = stream.startsWith('meta') ? 'jsonl' : 'csv';
    return join(this.root, `${label.slice(0, 4)}-${label.slice(4, 6)}`, `${stream}-${label}.${extension}`);
  }
  /** Returns true when this call opened a new segment. */
  roll() {
    const start = segmentStart(this.now());
    if (start === this.current) return false;
    const closing = [...this.streams.values()].map((out) => new Promise((resolve) => out.end(resolve)));
    this.streams.clear(); this.current = start;
    this.compressing = this.compressing.then(() => Promise.all(closing)).then(() => this.compressClosed()).catch(this.onError);
    return true;
  }
  append(stream, line) {
    this.roll();
    let out = this.streams.get(stream);
    if (!out) {
      const file = this.file(stream);
      mkdirSync(dirname(file), { recursive: true });
      const fresh = !existsSync(file) || statSync(file).size === 0;
      out = createWriteStream(file, { flags: 'a' }); out.on('error', this.onError);
      this.streams.set(stream, out);
      if (fresh && this.headers[stream]) out.write(this.headers[stream] + '\n');
    }
    out.write(line + '\n');
  }
  /** Last complete line already on disk for the open segment, used to resume without repeating rows. */
  lastLine(stream) {
    const file = this.file(stream);
    if (!existsSync(file)) return undefined;
    const size = statSync(file).size, length = Math.min(size, 8192);
    if (!length) return undefined;
    const buffer = Buffer.alloc(length), handle = openSync(file, 'r');
    try { readSync(handle, buffer, 0, length, size - length); } finally { closeSync(handle); }
    return buffer.toString('utf8').split('\n').filter(Boolean).at(-1);
  }
  async compressClosed() {
    const open = this.label();
    for (const month of readdirSync(this.root, { withFileTypes: true })) {
      if (!month.isDirectory() || !/^\d{4}-\d{2}$/.test(month.name)) continue;
      for (const name of readdirSync(join(this.root, month.name))) {
        const match = SEGMENT_FILE.exec(name);
        if (!match || match[1] === open) continue;
        const file = join(this.root, month.name, name);
        await pipeline(createReadStream(file), createGzip({ level: 9 }), createWriteStream(file + '.gz.tmp'));
        renameSync(file + '.gz.tmp', file + '.gz'); unlinkSync(file);
      }
    }
  }
  async close() {
    await Promise.all([...this.streams.values()].map((out) => new Promise((resolve) => out.end(resolve))));
    this.streams.clear(); await this.compressing;
  }
}
