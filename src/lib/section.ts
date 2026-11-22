import type { Grid, Ring, XY } from './geo'
import { pointInRing, sampleAt } from './geo'

export interface SectionPoint {
  d: number
  ground: number
  pad: number | null
  padId: number | null
}

/** Ground profile along a line, with the pad grade wherever the line crosses a pad. */
export function profile(
  g: Grid,
  a: XY,
  b: XY,
  n: number,
  pads: { id: number; ring: Ring; elev: number }[],
): SectionPoint[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const out: SectionPoint[] = []
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1)
    const p: XY = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
    const hit = pads.find((q) => pointInRing(p, q.ring))
    out.push({ d: t * len, ground: sampleAt(g, p), pad: hit ? hit.elev : null, padId: hit ? hit.id : null })
  }
  return out
}

/** Mean fill (positive) or cut (negative) depth where the line crosses each pad, keyed by pad id. */
export function crossingDepths(pts: SectionPoint[]): Map<number, { d: number; depth: number }> {
  const acc = new Map<number, { dSum: number; depthSum: number; n: number }>()
  for (const p of pts) {
    if (p.padId === null || p.pad === null || !Number.isFinite(p.ground)) continue
    const a = acc.get(p.padId) ?? { dSum: 0, depthSum: 0, n: 0 }
    a.dSum += p.d
    a.depthSum += p.pad - p.ground
    a.n++
    acc.set(p.padId, a)
  }
  return new Map([...acc].map(([k, v]) => [k, { d: v.dSum / v.n, depth: v.depthSum / v.n }]))
}
