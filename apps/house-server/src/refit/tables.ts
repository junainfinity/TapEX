import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MarketId } from '@maya/contracts';
import { loadCalibratedTable, type CalibratedTable, type CalibratedTableJSON } from '@maya/house';

/** Path of the published `maya-calibrated-v3-<market>.json` shipped with @maya/house. */
export function publishedTablePath(market: MarketId): string {
  return fileURLToPath(import.meta.resolve(`@maya/house/data/maya-calibrated-v3-${market}.json`));
}

export function loadPublishedTable(market: MarketId): CalibratedTable {
  return loadCalibratedTable(JSON.parse(readFileSync(publishedTablePath(market), 'utf8')) as unknown);
}

/**
 * Tables by id. Published tables are always available; refit tables are written to
 * `<dataDir>/tables/<id>.json` when published so a journal rebuild can reload them by id.
 */
export class TableRegistry {
  private readonly byId = new Map<string, CalibratedTable>();
  private readonly published = new Map<MarketId, CalibratedTable>();

  constructor(private readonly dataDir?: string) {}

  loadPublished(markets: readonly MarketId[]): void {
    for (const market of markets) { const table = loadPublishedTable(market); this.published.set(market, table); this.byId.set(table.id, table); }
  }
  publishedFor(market: MarketId): CalibratedTable | undefined { return this.published.get(market); }
  register(table: CalibratedTable): void { this.byId.set(table.id, table); }
  get(id: string): CalibratedTable | undefined { return this.byId.get(id); }

  /** Persist a refit table; returns the file name relative to `<dataDir>/tables` (undefined without a data dir). */
  persist(table: CalibratedTable, json: CalibratedTableJSON): string | undefined {
    this.register(table);
    if (!this.dataDir) return undefined;
    const dir = join(this.dataDir, 'tables');
    mkdirSync(dir, { recursive: true });
    const file = `${table.id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
    const full = join(dir, file);
    if (!existsSync(full)) writeFileSync(full, JSON.stringify(json));
    return file;
  }

  /** Resolve a journaled table: cache, then the data dir. */
  resolve(id: string, file?: string): CalibratedTable | undefined {
    const cached = this.byId.get(id);
    if (cached) return cached;
    if (!this.dataDir || !file || !/^[A-Za-z0-9._-]+\.json$/.test(file)) return undefined;
    const full = join(this.dataDir, 'tables', file);
    if (!existsSync(full)) return undefined;
    const table = loadCalibratedTable(JSON.parse(readFileSync(full, 'utf8')) as unknown);
    if (table.id !== id) return undefined;
    this.byId.set(id, table);
    return table;
  }
}
