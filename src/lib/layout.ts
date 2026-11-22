import type { Ring, XY } from './geo'
import { distToRing, pointInRing, SQM_PER_ACRE } from './geo'
import { BUILDABLE } from './slope'

export interface ClassGrid {
  width: number
  height: number
  cell: number
  classes: Uint8Array
}

export interface LayoutParams {
  minLotAcres: number
  setbackM: number
  padW: number
  padD: number
  /** Share of pad cells that must be under the buildable slope limit. */
  minBuildableShare: number
}

export interface Lot {
  id: number
  lot: Ring
  pad: Ring
  center: XY
  buildableShare: number
}

export const rect = (x: number, y: number, w: number, h: number): Ring => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
]

export function buildableShare(g: ClassGrid, pad: Ring): number {
  const [[x0, y0], , [x1, y1]] = pad as [XY, XY, XY, XY]
  let n = 0, ok = 0
  for (let r = Math.floor(y0 / g.cell); r <= Math.floor((y1 - 1e-9) / g.cell); r++)
    for (let c = Math.floor(x0 / g.cell); c <= Math.floor((x1 - 1e-9) / g.cell); c++) {
      n++
      if (r >= 0 && c >= 0 && r < g.height && c < g.width && g.classes[r * g.width + c] === BUILDABLE) ok++
    }
  return n ? ok / n : 0
}

const insideParcel = (ring: Ring, parcel: Ring) =>
  ring.every((p) => pointInRing(p, parcel) || distToRing(p, parcel) < 1e-6)

/**
 * Square lots of the minimum size on an axis-aligned grid. Sixteen grid offsets
 * are tried and the one with the most lots wins. Inside each lot the pad slides
 * to the most buildable of nine spots that keep the setback from every lot line.
 */
export function packLots(parcel: Ring, g: ClassGrid, p: LayoutParams): Lot[] {
  const side = Math.sqrt(p.minLotAcres * SQM_PER_ACRE)
  const roomX = side - p.padW - 2 * p.setbackM
  const roomY = side - p.padD - 2 * p.setbackM
  if (roomX < 0 || roomY < 0 || parcel.length < 3) return []
  const xs = parcel.map((q) => q[0])
  const ys = parcel.map((q) => q[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  let best: Lot[] = []
  let bestScore = -1
  const steps = [0, 0.25, 0.5, 0.75]
  for (const oy of steps)
    for (const ox of steps) {
      const lots: Lot[] = []
      let shareSum = 0
      for (let y = minY + oy * side; y + side <= maxY + 1e-9; y += side)
        for (let x = minX + ox * side; x + side <= maxX + 1e-9; x += side) {
          const lot = rect(x, y, side, side)
          if (!insideParcel(lot, parcel)) continue
          let top: { pad: Ring; share: number } | null = null
          for (const fy of [0.5, 0, 1])
            for (const fx of [0.5, 0, 1]) {
              const pad = rect(x + p.setbackM + fx * roomX, y + p.setbackM + fy * roomY, p.padW, p.padD)
              const share = buildableShare(g, pad)
              if (!top || share > top.share) top = { pad, share }
            }
          if (top && top.share >= p.minBuildableShare) {
            const [px, py] = top.pad[0]!
            lots.push({ id: 0, lot, pad: top.pad, center: [px + p.padW / 2, py + p.padD / 2], buildableShare: top.share })
            shareSum += top.share
          }
        }
      const score = lots.length + shareSum / 1000
      if (score > bestScore) {
        bestScore = score
        best = lots
      }
    }
  return best.map((l, i) => ({ ...l, id: i + 1 }))
}
