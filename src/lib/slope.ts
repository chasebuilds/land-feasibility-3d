export const BUILDABLE = 0
export const MARGINAL = 1
export const STEEP = 2
export const NODATA = 255
export const LIMITS = { buildable: 15, marginal: 25 }

const valid = (z: number) => Number.isFinite(z) && z > -1000

/** Percent slope per cell with the Horn 3x3 method; edge cells reuse their nearest neighbors. */
export function slopePercent(g: { width: number; height: number; data: Float32Array }, cell: number): Float32Array {
  const { width: w, height: h, data } = g
  const out = new Float32Array(w * h)
  const at = (r: number, c: number) => data[Math.min(h - 1, Math.max(0, r)) * w + Math.min(w - 1, Math.max(0, c))]!
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const a = at(r - 1, c - 1), b = at(r - 1, c), cc = at(r - 1, c + 1)
      const d = at(r, c - 1), f = at(r, c + 1)
      const gg = at(r + 1, c - 1), hh = at(r + 1, c), i = at(r + 1, c + 1)
      if (![a, b, cc, d, f, gg, hh, i, data[r * w + c]!].every(valid)) {
        out[r * w + c] = NaN
        continue
      }
      // On an edge the clamped neighbor duplicates the center, so the real span is one cell shorter.
      const spanX = (Math.min(w - 1, c + 1) - Math.max(0, c - 1)) * cell
      const spanY = (Math.min(h - 1, r + 1) - Math.max(0, r - 1)) * cell
      const dzdx = spanX ? (cc + 2 * f + i - (a + 2 * d + gg)) / (4 * spanX) : 0
      const dzdy = spanY ? (gg + 2 * hh + i - (a + 2 * b + cc)) / (4 * spanY) : 0
      out[r * w + c] = Math.hypot(dzdx, dzdy) * 100
    }
  }
  return out
}

export function classify(s: number): number {
  if (!Number.isFinite(s)) return NODATA
  if (s < LIMITS.buildable) return BUILDABLE
  return s <= LIMITS.marginal ? MARGINAL : STEEP
}

export const classifyAll = (s: Float32Array) => Uint8Array.from(s, classify)

export interface ClassAreas {
  buildable: number
  marginal: number
  steep: number
  nodata: number
  meanSlope: number
}

/** Square meters per class over the given cell indices, plus the mean slope there. */
export function classAreas(slope: Float32Array, cells: number[], cellArea: number): ClassAreas {
  const out = { buildable: 0, marginal: 0, steep: 0, nodata: 0, meanSlope: 0 }
  let n = 0
  for (const i of cells) {
    const s = slope[i]!
    const k = classify(s)
    if (k === BUILDABLE) out.buildable += cellArea
    else if (k === MARGINAL) out.marginal += cellArea
    else if (k === STEEP) out.steep += cellArea
    else out.nodata += cellArea
    if (k !== NODATA) {
      out.meanSlope += s
      n++
    }
  }
  out.meanSlope = n ? out.meanSlope / n : NaN
  return out
}

const COLORS: Record<number, [number, number, number, number]> = {
  [BUILDABLE]: [40, 167, 69, 140],
  [MARGINAL]: [240, 185, 20, 160],
  [STEEP]: [220, 53, 45, 160],
  [NODATA]: [0, 0, 0, 0],
}

export function colorize(classes: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(classes.length * 4)
  classes.forEach((k, i) => out.set(COLORS[k] ?? COLORS[NODATA]!, i * 4))
  return out
}
