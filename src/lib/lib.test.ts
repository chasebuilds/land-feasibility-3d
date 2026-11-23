import { describe, expect, it } from 'vitest'
import { CY_PER_M3, cellsInRing, distToRing, fromLocal, pointInRing, ringArea, sampleAt, toLocal, type Grid } from './geo'
import { BUILDABLE, MARGINAL, NODATA, STEEP, classAreas, classify, classifyAll, slopePercent } from './slope'
import { padEarthwork, padEarthworkOnGrid } from './earthwork'
import { buildableShare, packLots, rect, type ClassGrid } from './layout'
import { crossingDepths, profile } from './section'
import { CASES, EXITS, defaultAssumptions, runExit, type Assumptions } from './proforma'

type Quad = [[number, number], [number, number], [number, number], [number, number]]
const plane = (w: number, h: number, cell: number, sx: number, sy: number) => {
  const data = new Float32Array(w * h)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) data[r * w + c] = 100 + sx * c * cell + sy * r * cell
  return { width: w, height: h, data }
}

describe('slope', () => {
  it('reads the exact percent slope of a tilted plane, edges included', () => {
    const s = slopePercent(plane(10, 8, 2, 0.1, 0), 2)
    for (const v of s) expect(v).toBeCloseTo(10, 3)
    const d = slopePercent(plane(6, 6, 1, 0.3, 0.4), 1)
    for (const v of d) expect(v).toBeCloseTo(50, 3)
  })

  it('marks cells next to nodata as nodata', () => {
    const g = plane(5, 5, 1, 0.1, 0)
    g.data[12] = -3.4e38
    const s = slopePercent(g, 1)
    expect(Number.isNaN(s[12])).toBe(true)
    expect(Number.isNaN(s[6])).toBe(true)
    expect(s[0]).toBeCloseTo(10, 3)
  })

  it('classifies at the 15 and 25 percent limits', () => {
    expect(classify(0)).toBe(BUILDABLE)
    expect(classify(14.99)).toBe(BUILDABLE)
    expect(classify(15)).toBe(MARGINAL)
    expect(classify(25)).toBe(MARGINAL)
    expect(classify(25.01)).toBe(STEEP)
    expect(classify(NaN)).toBe(NODATA)
  })

  it('sums area per class and the mean slope', () => {
    const s = Float32Array.from([5, 20, 30, 40, NaN])
    const a = classAreas(s, [0, 1, 2, 3, 4], 4)
    expect(a).toMatchObject({ buildable: 4, marginal: 4, steep: 8, nodata: 4 })
    expect(a.meanSlope).toBeCloseTo(23.75)
  })
})

describe('geo', () => {
  const g: Grid = { width: 100, height: 100, data: new Float32Array(10000), minX: -9186000, maxY: 4505000, px: 2.5, scale: 0.8 }

  it('round-trips lon/lat through local meters', () => {
    const p: [number, number] = [-82.51, 37.47]
    const [lon, lat] = fromLocal(g, toLocal(g, p))
    expect(lon).toBeCloseTo(p[0], 9)
    expect(lat).toBeCloseTo(p[1], 9)
  })

  it('measures polygons and points', () => {
    const sq = rect(0, 0, 10, 20)
    expect(ringArea(sq)).toBe(200)
    expect(pointInRing([5, 5], sq)).toBe(true)
    expect(pointInRing([11, 5], sq)).toBe(false)
    expect(distToRing([5, 5], sq)).toBe(5)
  })

  it('finds cells inside a ring and samples a plane bilinearly', () => {
    const p = plane(20, 20, 2, 0.1, 0.05)
    const grid: Grid = { ...p, minX: 0, maxY: 0, px: 2, scale: 1 }
    expect(cellsInRing(grid, rect(0, 0, 10, 10)).length).toBe(25)
    expect(sampleAt(grid, [11, 7])).toBeCloseTo(100 + 0.1 * 10 + 0.05 * 6, 4)
    expect(Number.isNaN(sampleAt(grid, [-5, 5]))).toBe(true)
  })
})

describe('earthwork', () => {
  it('sets a balanced pad at mean grade and converts to cubic yards', () => {
    const e = padEarthwork([1, 2, 3], 1)
    expect(e.padElev).toBe(2)
    expect(e.cutM3).toBe(1)
    expect(e.fillM3).toBe(1)
    expect(e.cutCY).toBeCloseTo(CY_PER_M3)
    expect(e.maxCut).toBe(1)
    expect(e.maxFill).toBe(1)
  })

  it('uses a fixed pad grade when given and skips nodata', () => {
    const e = padEarthwork([10, 10, NaN, 12], 2, 10)
    expect(e.cutM3).toBe(4)
    expect(e.fillM3).toBe(0)
  })

  it('weights grid cells by pad area so a tilted pad matches the exact volume closely', () => {
    const p = plane(40, 40, 2, 0.2, 0)
    const g: Grid = { ...p, minX: 0, maxY: 0, px: 2, scale: 1 }
    const pad = rect(20.7, 21.3, 18.3, 15.2)
    // exact: balanced pad on a 20% plane, cut = depth * slope * width^2 / 8
    const exact = (15.2 * 0.2 * 18.3 ** 2) / 8
    const e = padEarthworkOnGrid(g, pad)
    expect(Math.abs(e.cutM3 - exact) / exact).toBeLessThan(0.12)
    expect(e.cutM3).toBeCloseTo(e.fillM3, 6)
  })

  it('a flat pad moves no dirt', () => {
    expect(padEarthwork([5, 5, 5, 5], 9).cutM3 + padEarthwork([5, 5, 5, 5], 9).fillM3).toBe(0)
  })
})

describe('layout', () => {
  const grid = (w: number, h: number, cell: number, steepFromCol = Infinity): ClassGrid => {
    const classes = new Uint8Array(w * h)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) classes[r * w + c] = c >= steepFromCol ? STEEP : BUILDABLE
    return { width: w, height: h, cell, classes }
  }
  const params = { minLotAcres: 1, setbackM: 7.62, padW: 18, padD: 15, minBuildableShare: 0.9 }

  it('packs nine one-acre lots into a flat 200 m square', () => {
    const lots = packLots(rect(0, 0, 200, 200), grid(100, 100, 2), params)
    expect(lots.length).toBe(9)
    expect(lots.map((l) => l.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (const l of lots) {
      const [[x0, y0], , [x1, y1]] = l.lot as Quad
      const [[px0, py0], , [px1, py1]] = l.pad as Quad
      expect(px0! - x0!).toBeGreaterThanOrEqual(params.setbackM - 1e-9)
      expect(py0! - y0!).toBeGreaterThanOrEqual(params.setbackM - 1e-9)
      expect(x1! - px1!).toBeGreaterThanOrEqual(params.setbackM - 1e-9)
      expect(y1! - py1!).toBeGreaterThanOrEqual(params.setbackM - 1e-9)
    }
  })

  it('keeps pads off steep ground', () => {
    const g = grid(100, 100, 2, 50)
    const lots = packLots(rect(0, 0, 200, 200), g, params)
    expect(lots.length).toBeGreaterThan(0)
    for (const l of lots) {
      expect(buildableShare(g, l.pad)).toBeGreaterThanOrEqual(0.9)
      expect(l.pad[1]![0]).toBeLessThanOrEqual(100 + 2)
    }
    expect(lots.length).toBeLessThan(9)
  })

  it('returns no lots when the pad and setbacks do not fit the lot', () => {
    expect(packLots(rect(0, 0, 200, 200), grid(100, 100, 2), { ...params, minLotAcres: 0.05 })).toEqual([])
  })

  it('never places a lot outside a triangular parcel', () => {
    const tri: [number, number][] = [[0, 0], [200, 0], [0, 200]]
    const lots = packLots(tri, grid(100, 100, 2), params)
    for (const l of lots) for (const p of l.lot) expect(p[0] + p[1]).toBeLessThanOrEqual(200 + 1e-6)
    expect(lots.length).toBeGreaterThanOrEqual(3)
  })
})

describe('section', () => {
  it('profiles ground and reports pad fill depth', () => {
    const p = plane(50, 50, 2, 0.1, 0)
    const g: Grid = { ...p, minX: 0, maxY: 0, px: 2, scale: 1 }
    const pts = profile(g, [10, 50], [90, 50], 81, [{ id: 1, ring: rect(40, 40, 20, 20), elev: 110 }])
    expect(pts[0]!.ground).toBeCloseTo(100 + 0.1 * 9, 4)
    expect(pts.filter((q) => q.padId === 1).length).toBeGreaterThan(15)
    const depth = crossingDepths(pts).get(1)!
    // ground under the pad runs 103.9 to 105.9, so a pad at 110 is about 5 m of fill
    expect(depth.depth).toBeCloseTo(110 - 104.9, 0)
    expect(Math.abs(depth.d - 40)).toBeLessThan(1)
  })
})

describe('pro forma', () => {
  const a: Assumptions = { ...defaultAssumptions(10, 2000, 20), loanToCost: 0, interestRate: 0 }

  it('sell as is with no debt: profit is sale less selling costs, land and closing', () => {
    const r = runExit(a, 'asIs')
    expect(r.profit).toBeCloseTo(a.asIsSalePrice * (1 - a.sellingPct) - a.landPrice * (1 + a.closingPct), 6)
    expect(r.peakCash).toBeCloseTo(a.landPrice * (1 + a.closingPct), 6)
    expect(r.months).toBe(a.asIsMonths)
  })

  it('profit always equals the sum of equity cash flows, with debt', () => {
    const d = { ...a, loanToCost: 0.7, interestRate: 0.1 }
    for (const e of EXITS)
      for (const k of ['downside', 'base', 'upside'] as const) {
        const r = runExit(d, e.key, k)
        expect(r.cumulative.at(-1)!).toBeCloseTo(r.profit, 4)
        const uses = Object.values(r.costs).reduce((x, y) => x + y, 0) + r.interest
        expect(r.equity + r.loan).toBeCloseTo(uses, 4)
        expect(r.interest).toBeGreaterThan(0)
      }
  })

  it('a losing deal: equity pays the loan shortfall and sources still equal uses', () => {
    const bad = { ...a, homePrice: 50000, loanToCost: 0.8, interestRate: 0.1 }
    const r = runExit(bad, 'buildHomes')
    expect(r.profit).toBeLessThan(0)
    expect(r.shortfall).toBeGreaterThan(0)
    const uses = Object.values(r.costs).reduce((x, y) => x + y, 0) + r.interest
    expect(r.equity + r.loan).toBeCloseTo(uses, 4)
    expect(r.cumulative.at(-1)!).toBeCloseTo(r.profit, 4)
    expect(r.peakCash).toBeGreaterThanOrEqual(r.equity)
  })

  it('downside is worse than base, base worse than upside', () => {
    for (const e of EXITS) {
      const lo = runExit(a, e.key, 'downside').profit
      const mid = runExit(a, e.key, 'base').profit
      const hi = runExit(a, e.key, 'upside').profit
      expect(lo).toBeLessThan(mid)
      expect(mid).toBeLessThan(hi)
    }
    expect(CASES.base).toEqual({ price: 1, cost: 1, time: 1 })
  })

  it('build homes counts every cost line', () => {
    const r = runExit(a, 'buildHomes')
    expect(r.costs.construction).toBeCloseTo(a.lots * a.homeSqft * a.buildCostPerSqft, 6)
    expect(r.costs.earthwork).toBeCloseTo(a.earthworkCY * a.earthworkPerCY, 6)
    expect(r.costs.siteWork).toBeCloseTo(a.lots * a.siteWorkPerLot, 6)
    expect(r.revenue).toBeCloseTo(a.lots * a.homePrice, 6)
    expect(r.margin).toBeCloseTo(r.profit / r.revenue, 9)
  })

  it('debt lowers peak cash and adds interest', () => {
    const cash = runExit(a, 'finishedPads')
    const lev = runExit({ ...a, loanToCost: 0.65, interestRate: 0.09 }, 'finishedPads')
    expect(lev.peakCash).toBeLessThan(cash.peakCash)
    expect(lev.profit).toBeLessThan(cash.profit)
  })
})

it('classifyAll maps a whole slope grid', () => {
  expect([...classifyAll(Float32Array.from([1, 20, 30, NaN]))]).toEqual([0, 1, 2, 255])
})
