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
  house: Ring
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

/** Share of buildable cells under a pad given in a rotated frame, sampled about once per cell. */
function sampledShare(g: ClassGrid, pad: Ring, fromFrame: (q: XY) => XY): number {
  const [[x0, y0], , [x1, y1]] = pad as [XY, XY, XY, XY]
  const nx = Math.max(2, Math.ceil((x1 - x0) / g.cell))
  const ny = Math.max(2, Math.ceil((y1 - y0) / g.cell))
  let ok = 0
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const [x, y] = fromFrame([x0 + ((i + 0.5) / nx) * (x1 - x0), y0 + ((j + 0.5) / ny) * (y1 - y0)])
      const c = Math.floor(x / g.cell)
      const r = Math.floor(y / g.cell)
      if (r >= 0 && c >= 0 && r < g.height && c < g.width && g.classes[r * g.width + c] === BUILDABLE) ok++
    }
  return ok / (nx * ny)
}

/** House footprint share of the pad, used for the 3D boxes and the site plan. */
export const HOUSE_SCALE = 0.6

/**
 * Square lots of the minimum size on a grid turned by `angle` radians about the
 * boundary centroid. Sixteen grid offsets are tried and the one with the most
 * lots wins. Inside each lot the pad slides to the most buildable of nine spots
 * that keep the setback from every lot line.
 */
export function packLots(parcel: Ring, g: ClassGrid, p: LayoutParams, angle = 0): Lot[] {
  const side = Math.sqrt(p.minLotAcres * SQM_PER_ACRE)
  const roomX = side - p.padW - 2 * p.setbackM
  const roomY = side - p.padD - 2 * p.setbackM
  if (roomX < 0 || roomY < 0 || parcel.length < 3) return []
  const cx = parcel.reduce((s, q) => s + q[0], 0) / parcel.length
  const cy = parcel.reduce((s, q) => s + q[1], 0) / parcel.length
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const toFrame = ([x, y]: XY): XY => [(x - cx) * cos + (y - cy) * sin + cx, -(x - cx) * sin + (y - cy) * cos + cy]
  const fromFrame = ([x, y]: XY): XY => [(x - cx) * cos - (y - cy) * sin + cx, (x - cx) * sin + (y - cy) * cos + cy]
  const share = (pad: Ring) => (angle === 0 ? buildableShare(g, pad) : sampledShare(g, pad, fromFrame))
  const frameParcel = angle === 0 ? parcel : parcel.map(toFrame)
  const xs = frameParcel.map((q) => q[0])
  const ys = frameParcel.map((q) => q[1])
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
          if (!insideParcel(lot, frameParcel)) continue
          let top: { pad: Ring; share: number } | null = null
          for (const fy of [0.5, 0, 1])
            for (const fx of [0.5, 0, 1]) {
              const pad = rect(x + p.setbackM + fx * roomX, y + p.setbackM + fy * roomY, p.padW, p.padD)
              const s = share(pad)
              if (!top || s > top.share) top = { pad, share: s }
            }
          if (top && top.share >= p.minBuildableShare) {
            const [px, py] = top.pad[0]!
            const hw = p.padW * HOUSE_SCALE
            const hd = p.padD * HOUSE_SCALE
            const center: XY = [px + p.padW / 2, py + p.padD / 2]
            const house = rect(center[0] - hw / 2, center[1] - hd / 2, hw, hd)
            const back = (r: Ring) => (angle === 0 ? r : r.map(fromFrame))
            lots.push({
              id: 0,
              lot: back(lot),
              pad: back(top.pad),
              house: back(house),
              center: angle === 0 ? center : fromFrame(center),
              buildableShare: top.share,
            })
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

/** Candidate grid angles: north, each boundary edge direction, and every 15 degrees. */
export function candidateAngles(parcel: Ring): number[] {
  const q = Math.PI / 2
  const raw = [0]
  for (let i = 0; i < parcel.length; i++) {
    const [ax, ay] = parcel[i]!
    const [bx, by] = parcel[(i + 1) % parcel.length]!
    raw.push(((Math.atan2(by - ay, bx - ax) % q) + q) % q)
  }
  for (let d = 15; d < 90; d += 15) raw.push((d * Math.PI) / 180)
  const out: number[] = []
  for (const a of raw.map((v) => (v > q / 2 ? v - q : v)))
    if (!out.some((b) => Math.abs(a - b) < Math.PI / 180)) out.push(a)
  return out
}

/** Tries every candidate angle and keeps the layout with the most lots; ties go to the earlier angle (north first). */
export function bestLayout(parcel: Ring, g: ClassGrid, p: LayoutParams): { angle: number; lots: Lot[] } {
  let best = { angle: 0, lots: [] as Lot[], score: -1 }
  for (const angle of candidateAngles(parcel)) {
    const lots = packLots(parcel, g, p, angle)
    const score = lots.length + lots.reduce((s, l) => s + l.buildableShare, 0) / 1000
    if (score > best.score + 1e-9) best = { angle, lots, score }
  }
  return { angle: best.angle, lots: best.lots }
}
