import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const SIGMA = 0.15;

interface Known { hour: number; viewers: number; }
interface ForecastRow { hour: number; }
interface HourlyPoint { from: string; viewers: number | null; }
interface Comparable { name: string; day_start: string; hourly: HourlyPoint[]; }
interface Case {
  levels: number[];
  known: Known[];
  forecast: ForecastRow[];
  comparables: Comparable[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

const hourQuantiles = (p1: number, h: number): number[] =>
  Z.map((z) => round2(p1 * Math.exp(z * SIGMA * Math.sqrt(h - 1))));

const msOf = (iso: string): number => Date.parse(iso);

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j]))
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${file} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);

  // Per-comparable log ratios to its launch hour, keeping only already-live launches.
  const series: Array<{ w: number; ratios: Map<number, number> }> = [];
  for (const comp of c.comparables ?? []) {
    const ds = msOf(comp.day_start);
    const byOff = new Map<number, number>();
    for (const pt of comp.hourly ?? []) {
      if (pt.viewers === null || pt.viewers === undefined) continue;
      const off = Math.round((msOf(pt.from) - ds) / 3600000);
      byOff.set(off, pt.viewers);
    }
    const v0 = byOff.get(0);
    if (v0 === undefined || v0 <= 0) continue;
    let peak = 0;
    for (const v of byOff.values()) if (v > peak) peak = v;
    if (peak <= 0 || v0 / peak < 0.05) continue;
    const v5 = byOff.get(5);
    const v19 = byOff.get(19);
    if (v5 === undefined || v19 === undefined || v5 <= 0 || v19 <= 0) continue;
    if (Math.log(v19 / v0) - Math.log(v5 / v0) < 0.30) continue;
    const ratios = new Map<number, number>();
    for (let h = 2; h <= 24; h++) {
      const v = byOff.get(h - 1);
      if (v !== undefined && v > 0) ratios.set(h, Math.log(v / v0));
    }
    if (ratios.size === 0) continue;
    const year = new Date(comp.day_start).getUTCFullYear();
    const w = Math.pow(0.9, Math.max(0, 2026 - year));
    series.push({ w, ratios });
  }

  const hours: Array<{ hour: number; q: number[] }> = [];
  if (series.length === 0) {
    // Fallback: random-walk persistence around hour 1.
    for (const { hour } of c.forecast) hours.push({ hour, q: hourQuantiles(p1, hour) });
  } else {
    // Weighted mean / sd of the log ratios at each hour, interpolated where empty.
    const mu = new Map<number, number>();
    const sd = new Map<number, number>();
    const have: number[] = [];
    for (let h = 2; h <= 24; h++) {
      let sw = 0;
      let s = 0;
      for (const { w, ratios } of series) {
        const r = ratios.get(h);
        if (r === undefined) continue;
        sw += w;
        s += w * r;
      }
      if (sw <= 0) continue;
      const m = s / sw;
      let v = 0;
      for (const { w, ratios } of series) {
        const r = ratios.get(h);
        if (r === undefined) continue;
        const d = r - m;
        v += w * d * d;
      }
      mu.set(h, m);
      sd.set(h, Math.sqrt(Math.max(0, v / sw)));
      have.push(h);
    }
    have.sort((a, b) => a - b);
    const muAt = (h: number): number => {
      if (mu.has(h)) return mu.get(h) as number;
      let lo = -1;
      let hi = -1;
      for (const k of have) {
        if (k < h) lo = k;
        if (k > h && hi === -1) hi = k;
      }
      if (lo === -1) return mu.get(hi) as number;
      if (hi === -1) return mu.get(lo) as number;
      return ((mu.get(lo) as number) + (mu.get(hi) as number)) / 2;
    };
    const sdAt = (h: number): number => {
      if (sd.has(h)) return sd.get(h) as number;
      let lo = -1;
      let hi = -1;
      for (const k of have) {
        if (k < h) lo = k;
        if (k > h && hi === -1) hi = k;
      }
      if (lo === -1) return sd.get(hi) as number;
      if (hi === -1) return sd.get(lo) as number;
      return ((sd.get(lo) as number) + (sd.get(hi) as number)) / 2;
    };
    for (const { hour } of c.forecast) {
      const m = muAt(hour);
      // Floor every sd at 0.25, then widen the band by 1.1.
      const s = Math.max(0.25, sdAt(hour)) * 1.1;
      const q = Z.map((z) => p1 * Math.exp(m + z * s));
      hours.push({ hour, q: q.map(round2) });
    }
  }

  // Canonical row order.
  hours.sort((a, b) => a.hour - b.hour);

  // Clamp into (0, 1e9], then force non-decreasing values within each row.
  for (const row of hours) {
    for (let i = 0; i < row.q.length; i++) {
      let v = row.q[i];
      if (!Number.isFinite(v) || v <= 0) v = 0.01;
      if (v > 1e9) v = 1e9;
      row.q[i] = Math.round(v * 100) / 100;
    }
    for (let i = 1; i < row.q.length; i++) {
      if (row.q[i] < row.q[i - 1]) row.q[i] = row.q[i - 1];
    }
  }

  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
