import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Journal records are plain JSON (amounts as decimal strings); `seq` is dense from 1. */
export interface JournalRecord { readonly type: string; readonly seq: number; readonly atMs: number }

export interface JournalSink {
  /**
   * Buffer one record. `durable` marks a record something outside the process will rely on (a money move, or
   * anything acknowledged to a player, the operator or the chain): the next `flush()` must not return before
   * it is on stable storage.
   */
  append(record: JournalRecord, durable?: boolean): void;
  /** Write appended records; durable ones (and everything before them) reach stable storage before this returns. */
  flush(): void;
  close(): void;
  readonly kind: 'file' | 'memory' | 'null';
}

/**
 * Append-only JSONL journal. Appends are buffered and written with one synchronous write per flush; the engine
 * flushes before any response or acknowledgement leaves the process. A flush that carries a durable record
 * fsyncs before it returns (an acknowledged voucher, bet or treasury move must survive an OS crash or power
 * loss, not just a process crash). Other records (feed samples, simulated flow) are fsynced at most every
 * `fsyncEveryMs`: after an OS crash they are the only tail that can be lost, and every durable record is
 * preceded by an fsync covering all earlier ones.
 */
export class FileJournal implements JournalSink {
  readonly kind = 'file' as const;
  private fd: number | undefined;
  private buffer: string[] = [];
  private lastSync = 0;
  private durablePending = false;
  constructor(readonly path: string, private readonly fsyncEveryMs = 1000) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'a');
  }
  append(record: JournalRecord, durable = false): void {
    if (this.fd === undefined) throw new Error('Journal is closed');
    this.buffer.push(JSON.stringify(record) + '\n');
    if (durable) this.durablePending = true;
  }
  flush(): void {
    if (this.fd === undefined || !this.buffer.length) return;
    const text = this.buffer.join(''); this.buffer = [];
    writeSync(this.fd, text);
    const now = Date.now();
    if (this.durablePending || now - this.lastSync >= this.fsyncEveryMs) { fsyncSync(this.fd); this.lastSync = now; this.durablePending = false; }
  }
  close(): void {
    if (this.fd === undefined) return;
    this.flush(); fsyncSync(this.fd); closeSync(this.fd); this.fd = undefined;
  }
}

/** In-memory journal holding the exact serialized lines (rebuild tests read them back). */
export class MemoryJournal implements JournalSink {
  readonly kind = 'memory' as const;
  readonly lines: string[] = [];
  append(record: JournalRecord): void { this.lines.push(JSON.stringify(record)); }
  flush(): void { /* in memory */ }
  close(): void { /* in memory */ }
  records<T extends JournalRecord = JournalRecord>(): T[] { return this.lines.map(line => JSON.parse(line) as T); }
}

export class NullJournal implements JournalSink {
  readonly kind = 'null' as const;
  append(): void { /* disabled */ }
  flush(): void { /* disabled */ }
  close(): void { /* disabled */ }
}

export interface JournalRead<T> { readonly records: T[]; readonly truncatedTail: boolean }

/**
 * Read a journal for rebuild. A torn final line (crash mid-write) is dropped and reported; any
 * other malformed line, or a gap in `seq`, is corruption and throws.
 */
export function readJournal<T extends JournalRecord = JournalRecord>(path: string): JournalRead<T> {
  if (!existsSync(path)) return { records: [], truncatedTail: false };
  return parseJournal<T>(readFileSync(path, 'utf8'));
}
export function parseJournal<T extends JournalRecord = JournalRecord>(text: string): JournalRead<T> {
  const lines = text.split('\n');
  const records: T[] = [];
  let truncatedTail = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let record: T;
    try { record = JSON.parse(line) as T; } catch (error) {
      if (i >= lines.length - 2 && !text.endsWith('\n')) { truncatedTail = true; break; }
      throw new Error(`Journal line ${i + 1} is malformed: ${(error as Error).message}`);
    }
    if (!record || typeof record.type !== 'string' || record.seq !== records.length + 1) throw new Error(`Journal line ${i + 1} breaks the sequence (seq ${String(record?.seq)}, expected ${records.length + 1})`);
    records.push(record);
  }
  return { records, truncatedTail };
}

/** Drop a torn final line so appends continue on a clean record boundary. Returns bytes removed. */
export function repairJournalTail(path: string): number {
  if (!existsSync(path)) return 0;
  const bytes = readFileSync(path);
  if (!bytes.length || bytes[bytes.length - 1] === 0x0a) return 0;
  const keep = bytes.lastIndexOf(0x0a) + 1;
  truncateSync(path, keep);
  return bytes.length - keep;
}
