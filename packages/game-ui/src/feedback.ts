import { formatCents } from '@maya/contracts';

export type FeedbackKind = 'win' | 'loss' | 'refund' | 'place' | 'reject';

export interface FeedbackEvent {
  id: string;
  kind: FeedbackKind;
  amountCents?: string;
  /** Live only: caption override (e.g. why a placement was refused). */
  label?: string;
  /** Consecutive settled winning cells, supplied by the caller; never inferred here. */
  streak?: number;
  /** Coordinates are the cell center, relative to the chart scene. */
  x: number;
  y: number;
  size: number;
}

interface ActiveEffect {
  kind: FeedbackKind;
  element: HTMLDivElement;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_EFFECTS = 32;
const LIFETIME: Record<FeedbackKind, number> = {
  win: 2_350,
  loss: 1_250,
  refund: 1_700,
  place: 500,
  reject: 900,
};

/** A decorative, chart-anchored layer. It never reads or decides a trade result. */
export class FeedbackLayer {
  private readonly layer: HTMLDivElement;
  private readonly effects = new Map<string, ActiveEffect>();
  private readonly reducedMotion: boolean;
  private readonly formatMoney: ((value: string) => string) | undefined;
  private disposed = false;

  constructor(host: HTMLElement, options: { reducedMotion: boolean; formatMoney?: (value: string) => string }) {
    this.reducedMotion = options.reducedMotion;
    this.formatMoney = options.formatMoney;
    this.layer = document.createElement('div');
    this.layer.className = 'maya-feedback';
    this.layer.dataset.reducedMotion = String(options.reducedMotion);
    // The game already announces settlements through its accessible result/toast UI.
    this.layer.setAttribute('aria-hidden', 'true');
    host.append(this.layer);
  }

  emit(event: FeedbackEvent): void {
    if (this.disposed || !event.id || !validGeometry(event.x, event.y, event.size)) return;
    const previous = this.effects.get(event.id);
    if (previous?.kind === event.kind) {
      this.reposition(event.id, event.x, event.y, event.size);
      return;
    }
    if (previous) this.remove(event.id);
    while (this.effects.size >= MAX_EFFECTS) {
      const oldest = this.effects.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }

    const effect = document.createElement('div');
    effect.className = `maya-fx maya-fx--${event.kind}`;
    effect.dataset.effectId = event.id;
    effect.dataset.kind = event.kind;
    const streak = Number.isSafeInteger(event.streak) && event.streak! > 0 ? event.streak! : 1;
    if (event.kind === 'win') {
      effect.dataset.streak = String(streak);
      effect.dataset.winVariant = streak >= 5 ? 'nova' : streak >= 3 ? 'starburst' : streak === 2 ? 'double-ring' : 'ring';
    }
    const body = document.createElement('div');
    body.className = 'maya-fx__body';
    effect.append(body);

    if (event.kind === 'win') this.buildWin(body, streak);
    else {
      const ring = document.createElement('i');
      ring.className = 'maya-fx__simple-ring';
      body.append(ring);
      if (event.kind === 'loss') {
        for (let i = 0; i < 6; i++) {
          const mote = document.createElement('i');
          mote.className = 'maya-fx__loss-mote';
          mote.style.setProperty('--mote-x', String((i - 2.5) * 0.14));
          mote.style.setProperty('--mote-delay', `${i * 28}ms`);
          body.append(mote);
        }
      }
    }

    const amount = exactAmount(event.amountCents, this.formatMoney);
    const label = event.kind === 'win' ? (amount ? `+${amount}` : 'Hit')
      : event.kind === 'loss' ? 'Missed'
      : event.kind === 'refund' ? (amount ? `${amount} returned` : 'Stake returned')
      : event.kind === 'reject' ? (event.label ?? 'Try another square') : null;
    if (label) {
      const caption = document.createElement('span');
      caption.className = 'maya-fx__caption';
      caption.textContent = label;
      effect.append(caption);
    }
    if (event.kind === 'win' && streak >= 2) {
      const badge = document.createElement('span');
      badge.className = 'maya-fx__streak';
      badge.textContent = streak === 2 ? '2 WINS' : `${streak} WIN STREAK`;
      effect.append(badge);
    }

    const timer = globalThis.setTimeout(() => this.remove(event.id), this.reducedMotion ? 1_050 : LIFETIME[event.kind]);
    this.effects.set(event.id, { kind: event.kind, element: effect, timer });
    this.reposition(event.id, event.x, event.y, event.size);
    this.layer.append(effect);
  }

  reposition(id: string, x: number, y: number, size: number): void {
    if (!validGeometry(x, y, size)) return;
    const effect = this.effects.get(id);
    if (!effect) return;
    effect.element.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    effect.element.style.setProperty('--fx-size', `${Math.min(180, Math.max(16, size)).toFixed(2)}px`);
  }

  activeIds(): string[] { return [...this.effects.keys()]; }

  clear(): void {
    for (const id of this.effects.keys()) this.remove(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.layer.remove();
  }

  private remove(id: string): void {
    const effect = this.effects.get(id);
    if (!effect) return;
    globalThis.clearTimeout(effect.timer);
    effect.element.remove();
    this.effects.delete(id);
  }

  private buildWin(body: HTMLDivElement, streak: number): void {
    const halo = document.createElement('i');
    halo.className = 'maya-fx__halo';
    body.append(halo);

    const energy = document.createElementNS(SVG_NS, 'svg');
    energy.setAttribute('viewBox', '0 0 200 200');
    energy.setAttribute('fill', 'none');
    energy.classList.add('maya-fx__energy');
    // Deterministic decorative curves: the market and settlement never depend on these.
    for (let ring = 0; ring < (streak >= 3 ? 2 : 3); ring++) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', energyLoop(ring));
      path.setAttribute('pathLength', '100');
      path.classList.add('maya-fx__energy-ring', `maya-fx__energy-ring--${ring}`);
      energy.append(path);
    }
    if (streak === 2 || streak >= 5) {
      for (let ring = 0; ring < 2; ring++) {
        const orbit = document.createElementNS(SVG_NS, 'circle');
        orbit.setAttribute('cx', '100');
        orbit.setAttribute('cy', '100');
        orbit.setAttribute('r', String((streak >= 5 ? 54 : 45) + ring * 10));
        orbit.classList.add('maya-fx__orbit', `maya-fx__orbit--${ring}`);
        energy.append(orbit);
      }
    }
    if (streak >= 3) {
      const star = document.createElementNS(SVG_NS, 'path');
      star.setAttribute('d', starLoop(streak >= 5 ? 10 : streak === 4 ? 8 : 6, streak >= 5 ? 59 : 53));
      star.classList.add('maya-fx__star');
      energy.append(star);
    }
    body.append(energy);

    const sparkCount = streak >= 5 ? 20 : streak >= 3 ? 16 : 12;
    for (let i = 0; i < sparkCount; i++) {
      const spark = document.createElement('i');
      spark.className = `maya-fx__spark${i % 3 === 0 ? ' maya-fx__spark--ray' : ''}`;
      spark.style.setProperty('--spark-angle', `${i * 360 / sparkCount + 17}deg`);
      spark.style.setProperty('--spark-delay', `${(i % 4) * 21}ms`);
      spark.style.setProperty('--spark-range', String((streak >= 5 ? .91 : .75) + (i % 3) * .16));
      body.append(spark);
    }
  }
}

function validGeometry(x: number, y: number, size: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(size) && size > 0;
}

function exactAmount(value: string | undefined, format: (value: string) => string = formatCents): string | null {
  return value !== undefined && value.length <= 256 && /^\d+$/.test(value) ? format(value) : null;
}

function energyLoop(ring: number): string {
  const points = 96;
  const phase = ring * 1.73;
  let path = '';
  for (let i = 0; i <= points; i++) {
    const angle = i / points * Math.PI * 2;
    const radius = 34 + ring * 3 + Math.sin(angle * 6 + phase) * 4.3 + Math.sin(angle * 11 - phase) * 2.9;
    const x = 100 + Math.cos(angle) * radius;
    const y = 100 + Math.sin(angle) * radius;
    path += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return `${path}Z`;
}

function starLoop(tips: number, outer: number): string {
  let path = '';
  for (let i = 0; i < tips * 2; i++) {
    const angle = i / (tips * 2) * Math.PI * 2 - Math.PI / 2;
    const radius = i % 2 === 0 ? outer : 25;
    path += `${i === 0 ? 'M' : 'L'}${(100 + Math.cos(angle) * radius).toFixed(2)} ${(100 + Math.sin(angle) * radius).toFixed(2)} `;
  }
  return `${path}Z`;
}
