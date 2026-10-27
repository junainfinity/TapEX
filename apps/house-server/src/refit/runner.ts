import { Worker } from 'node:worker_threads';
import type { MarketId } from '@maya/contracts';
import { parseCalibratedTable, refitTable, type CalibratedTable, type CalibratedTableJSON, type TablePricing } from '@maya/house';

export interface RefitJobInput {
  readonly market: MarketId;
  /** Interleaved (t, price) pairs of the recorded first-seen path. */
  readonly points: Float64Array;
  readonly now: number;
  readonly trainHours: number;
  readonly minRows: number;
  readonly pricing?: TablePricing;
}
export type RefitJobResult =
  | { readonly ok: true; readonly market: MarketId; readonly table: CalibratedTable; readonly json: CalibratedTableJSON; readonly rows: number; readonly observations: number }
  | { readonly ok: false; readonly market: MarketId; readonly reason: string; readonly detail: string };

export interface RefitRunner { run(job: RefitJobInput): Promise<RefitJobResult> }

/** Path points within the training window (plus the h10 look-back), as transferable interleaved pairs. */
export function pathPoints(values: ReadonlyMap<number, number>, now: number, trainHours: number): Float64Array {
  const from = now - Math.round(trainHours * 3600) - 700;
  const pairs: number[] = [];
  for (const [t, p] of values) if (t > from && t <= now) pairs.push(t, p);
  return Float64Array.from(pairs);
}

function* pairs(points: Float64Array): Generator<[number, number]> {
  for (let i = 0; i + 1 < points.length; i += 2) yield [points[i]!, points[i + 1]!];
}

export function runRefitJob(job: RefitJobInput): RefitJobResult {
  const r = refitTable(pairs(job.points), { market: job.market, now: job.now, trainHours: job.trainHours, minRows: job.minRows, ...(job.pricing ? { pricing: job.pricing } : {}) });
  return r.ok ? { ok: true, market: job.market, table: r.table, json: r.json, rows: r.rows, observations: r.observations } : { ok: false, market: job.market, reason: r.reason, detail: r.detail };
}

/** Synchronous refit (tests and deterministic max-speed simulations). */
export class InlineRefitRunner implements RefitRunner {
  async run(job: RefitJobInput): Promise<RefitJobResult> { return runRefitJob(job); }
}

/**
 * Refit on a worker thread so the ~1 s of CPU per market never stalls quoting. The worker returns the
 * table JSON, which is re-validated (golden rows included) on the main thread.
 */
export class WorkerRefitRunner implements RefitRunner {
  constructor(private readonly workerUrl: URL = new URL('./refit-worker.js', import.meta.url)) {}
  run(job: RefitJobInput): Promise<RefitJobResult> {
    return new Promise(resolve => {
      const worker = new Worker(this.workerUrl);
      const done = (r: RefitJobResult) => { void worker.terminate(); resolve(r); };
      worker.once('message', (msg: { ok: true; json: CalibratedTableJSON; rows: number; observations: number } | { ok: false; reason: string; detail: string }) => {
        if (!msg.ok) { done({ ok: false, market: job.market, reason: msg.reason, detail: msg.detail }); return; }
        const parsed = parseCalibratedTable(msg.json);
        done(parsed.ok ? { ok: true, market: job.market, table: parsed.table, json: msg.json, rows: msg.rows, observations: msg.observations } : { ok: false, market: job.market, reason: 'table-rejected', detail: parsed.detail });
      });
      worker.once('error', (error: Error) => done({ ok: false, market: job.market, reason: 'worker-error', detail: error.message }));
      worker.postMessage({ ...job, points: job.points }, [job.points.buffer as ArrayBuffer]);
    });
  }
}
