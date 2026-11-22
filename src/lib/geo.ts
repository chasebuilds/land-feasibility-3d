export type LngLat = [number, number]
export type XY = [number, number]
export type Ring = XY[]

const R = 6378137

export function toMerc([lon, lat]: LngLat): XY {
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R
  return [(lon * Math.PI * R) / 180, y]
}

export function fromMerc([x, y]: XY): LngLat {
  return [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)]
}

/**
 * A DEM on a regular grid in Web Mercator. Ground distance is mercator distance
 * times `scale` (cos of the latitude), accurate to well under 1% across a parcel.
 */
export interface Grid {
  width: number
  height: number
  data: Float32Array
  minX: number
  maxY: number
  px: number
  scale: number
}

export const cellSize = (g: Pick<Grid, 'px' | 'scale'>) => g.px * g.scale

/** Lon/lat to local ground meters: x east and y south from the top-left corner of the grid. */
export function toLocal(g: Grid, p: LngLat): XY {
  const [mx, my] = toMerc(p)
  return [(mx - g.minX) * g.scale, (g.maxY - my) * g.scale]
}

export function fromLocal(g: Grid, [x, y]: XY): LngLat {
  return fromMerc([g.minX + x / g.scale, g.maxY - y / g.scale])
}

export function pointInRing([x, y]: XY, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function ringArea(ring: Ring): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1])
  }
  return Math.abs(a / 2)
}

export function distToSegment([px, py]: XY, [ax, ay]: XY, [bx, by]: XY): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

export function distToRing(p: XY, ring: Ring): number {
  let d = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, distToSegment(p, ring[j]!, ring[i]!))
  return d
}

/** Bilinear elevation at local meters; NaN outside the grid. */
export function sampleAt(g: Grid, [x, y]: XY): number {
  const cs = cellSize(g)
  const c = x / cs - 0.5
  const r = y / cs - 0.5
  const c0 = Math.floor(c)
  const r0 = Math.floor(r)
  if (c0 < 0 || r0 < 0 || c0 + 1 >= g.width || r0 + 1 >= g.height) return NaN
  const fx = c - c0
  const fy = r - r0
  const z = (rr: number, cc: number) => g.data[rr * g.width + cc]!
  return (
    z(r0, c0) * (1 - fx) * (1 - fy) +
    z(r0, c0 + 1) * fx * (1 - fy) +
    z(r0 + 1, c0) * (1 - fx) * fy +
    z(r0 + 1, c0 + 1) * fx * fy
  )
}

/** Indices of grid cells whose centers fall inside the ring. */
export function cellsInRing(g: Pick<Grid, 'width' | 'height' | 'px' | 'scale'>, ring: Ring): number[] {
  const cs = cellSize(g)
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  const c0 = Math.max(0, Math.floor(Math.min(...xs) / cs))
  const c1 = Math.min(g.width - 1, Math.ceil(Math.max(...xs) / cs))
  const r0 = Math.max(0, Math.floor(Math.min(...ys) / cs))
  const r1 = Math.min(g.height - 1, Math.ceil(Math.max(...ys) / cs))
  const out: number[] = []
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) if (pointInRing([(c + 0.5) * cs, (r + 0.5) * cs], ring)) out.push(r * g.width + c)
  return out
}

export const SQM_PER_ACRE = 4046.8564224
export const M_PER_FT = 0.3048
export const CY_PER_M3 = 1.307950619
