import { CY_PER_M3 } from './geo'

export interface Earthwork {
  padElev: number
  cutM3: number
  fillM3: number
  cutCY: number
  fillCY: number
  maxCut: number
  maxFill: number
}

/**
 * Balanced pad: set at the mean ground elevation of the cells under it, so cut
 * about equals fill. No shrink or swell, no side slopes past the pad edge.
 */
export function padEarthwork(elevs: number[], cellArea: number, padElev?: number): Earthwork {
  const z = elevs.filter(Number.isFinite)
  const pe = padElev ?? (z.length ? z.reduce((a, b) => a + b, 0) / z.length : NaN)
  let cut = 0, fill = 0, maxCut = 0, maxFill = 0
  for (const e of z) {
    const d = e - pe
    if (d > 0) {
      cut += d * cellArea
      maxCut = Math.max(maxCut, d)
    } else {
      fill -= d * cellArea
      maxFill = Math.max(maxFill, -d)
    }
  }
  return { padElev: pe, cutM3: cut, fillM3: fill, cutCY: cut * CY_PER_M3, fillCY: fill * CY_PER_M3, maxCut, maxFill }
}
