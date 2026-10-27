import { parentPort } from 'node:worker_threads';
import { runRefitJob, type RefitJobInput } from './runner.js';

parentPort?.once('message', (job: RefitJobInput) => {
  try {
    const r = runRefitJob(job);
    parentPort!.postMessage(r.ok ? { ok: true, json: r.json, rows: r.rows, observations: r.observations } : { ok: false, reason: r.reason, detail: r.detail });
  } catch (error) {
    parentPort!.postMessage({ ok: false, reason: 'worker-exception', detail: error instanceof Error ? error.message : String(error) });
  }
});
