import { compareDecimal, parseDecimal, sampleId, type MarketDefinition, type PriceSample } from '@maya/contracts';

class JsonNumber { constructor(readonly text: string) {} }
/** A bounded JSON reader retaining numeric source lexemes before any Number conversion. */
export function parseLosslessJson(text: string): unknown {
  if (text.length > 2_000_000) throw new Error('Source JSON exceeds size bound');
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  function value(depth = 0): unknown {
    if (depth > 32) throw new Error('Source JSON too deeply nested');
    whitespace();
    const c = text[cursor];
    if (c === '"') {
      const start = cursor++;
      while (cursor < text.length) {
        if (text[cursor] === '\\') { cursor += 2; continue; }
        if (text[cursor++] === '"') return JSON.parse(text.slice(start, cursor));
      }
      throw new Error('Unterminated JSON string');
    }
    if (c === '{') {
      cursor++; const object: Record<string, unknown> = Object.create(null); whitespace();
      if (text[cursor] === '}') { cursor++; return object; }
      for (;;) {
        const key = value(depth + 1);
        if (typeof key !== 'string' || Object.hasOwn(object, key)) throw new Error('Invalid/duplicate JSON key');
        whitespace(); if (text[cursor++] !== ':') throw new Error('Missing JSON colon');
        object[key] = value(depth + 1); whitespace();
        const next = text[cursor++]; if (next === '}') return object; if (next !== ',') throw new Error('Invalid JSON object');
      }
    }
    if (c === '[') {
      cursor++; const array: unknown[] = []; whitespace();
      if (text[cursor] === ']') { cursor++; return array; }
      for (;;) { array.push(value(depth + 1)); whitespace(); const next = text[cursor++]; if (next === ']') return array; if (next !== ',') throw new Error('Invalid JSON array'); }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, cursor)) { cursor += token.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(cursor));
    if (!match || match[0].length > 100) throw new Error('Invalid/bounded JSON number');
    cursor += match[0].length; return new JsonNumber(match[0]);
  }
  const result = value(); whitespace(); if (cursor !== text.length) throw new Error('Trailing JSON content'); return result;
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof JsonNumber) throw new Error('Expected object');
  return v as Record<string, unknown>;
}
function integer(v: unknown): number {
  if (!(v instanceof JsonNumber) || !/^\d+$/.test(v.text)) throw new Error('Expected source integer');
  const n = Number(v.text); if (!Number.isSafeInteger(n)) throw new Error('Unsafe source integer'); return n;
}
export function parsePriceBuffer(text: string, market: MarketDefinition, receivedAtMs: number, sourceHash?: string): PriceSample[] {
  const data = object(parseLosslessJson(text));
  if (data.chain !== 'bsc' || integer(data.pair) !== market.pairId || typeof data.feedId !== 'string' || data.feedId.toLowerCase() !== market.feedId) throw new Error('Price buffer authority mismatch');
  if (!Array.isArray(data.prices) || data.prices.length < 2 || data.prices.length > 1000 || integer(data.count) !== data.prices.length) throw new Error('Invalid price buffer size');
  return data.prices.map((entry) => {
    const row = object(entry);
    if (!(row.p instanceof JsonNumber)) throw new Error('Source price must be a numeric lexeme');
    const price = parseDecimal(row.p.text);
    if (compareDecimal(price, { coefficient: '0', exponent: 0 }) <= 0) throw new Error('Source price must be positive');
    const sourceTimeMs = integer(row.t) * 1000;
    if (!Number.isSafeInteger(sourceTimeMs)) throw new Error('Unsafe source timestamp');
    return Object.freeze({ sampleId: sampleId(market.feedId, sourceTimeMs), marketId: market.id, pairId: market.pairId, feedId: market.feedId, sourceTimeMs, receivedAtMs, price: Object.freeze(price), ...(sourceHash ? { sourceHash } : {}) });
  }).sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
}
