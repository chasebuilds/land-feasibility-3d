import { describe, expect, it } from 'vitest'
import type { Ring, XY } from './geo'
import { pointInRing, distToRing, ringArea } from './geo'
import { BUILDABLE, STEEP } from './slope'
import { HOUSE_SCALE, bestLayout, candidateAngles, packLots, rect, type ClassGrid } from './layout'
import { esc, niceLength, padColor, sitePlanSvg, type PlanInput } from './siteplan'

const deg = (d: number) => (d * Math.PI) / 180
const rotate = (r: Ring, a: number, [cx, cy]: XY): Ring =>
  r.map(([x, y]) => [(x - cx) * Math.cos(a) - (y - cy) * Math.sin(a) + cx, (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a) + cy])

function gridFrom(w: number, h: number, cell: number, buildable: (x: number, y: number) => boolean): ClassGrid {
  const classes = new Uint8Array(w * h)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) classes[r * w + c] = buildable((c + 0.5) * cell, (r + 0.5) * cell) ? BUILDABLE : STEEP
  return { width: w, height: h, cell, classes }
}

const params = { minLotAcres: 0.5, setbackM: 7.62, padW: 18.3, padD: 15.2, minBuildableShare: 0.9 }

describe('rotated lot grid', () => {
  // A 300 x 46 m flat strip (one row of half-acre lots fits) turned 35 degrees, steep everywhere else.
  const center: XY = [250, 250]
  const strip = rotate(rect(100, 227, 300, 46), deg(35), center)
  const g = gridFrom(250, 250, 2, (x, y) => pointInRing([x, y], strip))

  it('lists north, the edge directions and 15 degree steps, without duplicates', () => {
    const a = candidateAngles(strip).map((v) => Math.round((v * 180) / Math.PI))
    expect(a[0]).toBe(0)
    expect(a).toContain(35)
    expect(a).not.toContain(-55)
    expect(new Set(a).size).toBe(a.length)
    for (const v of a) expect(Math.abs(v)).toBeLessThanOrEqual(45)
  })

  it('fits more lots on a turned ridge than a north grid does', () => {
    const north = packLots(strip, g, params)
    const best = bestLayout(strip, g, params)
    expect(Math.round((best.angle * 180) / Math.PI)).toBe(35)
    expect(best.lots.length).toBe(6)
    expect(north.length).toBeLessThan(best.lots.length)
  })

  it('keeps every turned lot inside the boundary and every pad on flat ground', () => {
    const { lots } = bestLayout(strip, g, params)
    for (const l of lots) {
      for (const p of l.lot) expect(pointInRing(p, strip) || distToRing(p, strip) < 1e-6).toBe(true)
      for (const p of l.pad) expect(pointInRing(p, l.lot)).toBe(true)
      expect(l.buildableShare).toBeGreaterThanOrEqual(0.9)
      expect(ringArea(l.house)).toBeCloseTo(ringArea(l.pad) * HOUSE_SCALE * HOUSE_SCALE, 6)
      expect(ringArea(l.lot)).toBeCloseTo(0.5 * 4046.8564224, 4)
    }
  })

  it('angle 0 gives the same layout as before', () => {
    const sq = rect(0, 0, 200, 200)
    const flat = gridFrom(100, 100, 2, () => true)
    const a = packLots(sq, flat, { ...params, minLotAcres: 1 })
    const b = bestLayout(sq, flat, { ...params, minLotAcres: 1 })
    expect(b.angle).toBe(0)
    expect(b.lots.map((l) => l.lot)).toEqual(a.map((l) => l.lot))
    expect(a.length).toBe(9)
  })
})

describe('site plan', () => {
  const lot = rect(10, 10, 45, 45)
  const input: PlanInput = {
    title: 'Ridge <test> & co',
    boundaryNote: 'Example boundary, not a real parcel',
    parcel: rect(0, 0, 120, 70),
    lots: [
      { id: 1, lot, pad: rect(20, 20, 18, 15), house: rect(23, 23, 11, 9), padElevFt: 1250.4, cutCY: 120, fillCY: 118, depthFt: 1.2 },
      { id: 2, lot: rect(60, 10, 45, 45), pad: rect(70, 20, 18, 15), house: rect(73, 23, 11, 9), padElevFt: 1262.1, cutCY: 410, fillCY: 405, depthFt: 7.5 },
    ],
    section: [[0, 35], [120, 35]],
    slopeImage: { href: 'data:image/png;base64,AAAA', x: -10, y: -10, w: 140, h: 90 },
    stats: { acres: 2.08, buildableAcres: 1.5, meanSlope: 12.3, cutCY: 530, fillCY: 523, gridAngleDeg: 0, demSource: 'USGS 3DEP, 2.0 m cells', date: '2026-11-23' },
  }
  const svg = sitePlanSvg(input)

  it('draws every lot, pad and house with a north arrow, scale bar and section marks', () => {
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.match(/class="lot"/g)?.length).toBe(2)
    expect(svg.match(/class="pad"/g)?.length).toBe(2)
    expect(svg.match(/class="house"/g)?.length).toBe(2)
    expect(svg).toContain('class="north"')
    expect(svg).toContain('class="scale"')
    expect(svg).toContain(">A'<")
    expect(svg).toContain('Example boundary, not a real parcel')
    expect(svg).toContain('clip-path="url(#parcel)"')
    expect(svg).not.toContain('NaN')
  })

  it('escapes text and colors pads by depth', () => {
    expect(svg).toContain('Ridge &lt;test&gt; &amp; co')
    expect(svg).not.toContain('<test>')
    expect(svg).toContain(`fill="${padColor(7.5)}"`)
    expect(esc(`"'`)).toBe('&quot;&#39;')
    expect([padColor(0), padColor(3), padColor(8), padColor(20)]).toEqual(['#f7ecd9', '#f2c98f', '#d9822b', '#8c3b12'])
  })

  it('keeps the map to scale: the scale bar matches the drawn length', () => {
    const m = svg.match(/<g class="scale"><rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[\s\S]*?>([\d,]+) ft</)!
    const barPx = Number(m[2])
    const barFt = Number(m[3]!.replace(/,/g, ''))
    const lotPts = svg.match(/class="lot" points="([^"]+)"/)![1]!.split(' ').map((p) => p.split(',').map(Number))
    const lotPx = lotPts[1]![0]! - lotPts[0]![0]!
    expect(lotPx / 45).toBeCloseTo(barPx / (barFt * 0.3048), 1)
  })

  it('picks 1, 2 or 5 times a power of ten for the scale bar', () => {
    expect(niceLength(130)).toBe(100)
    expect(niceLength(260)).toBe(200)
    expect(niceLength(740)).toBe(500)
    expect(niceLength(0.03)).toBeCloseTo(0.02)
    expect(niceLength(0)).toBe(0)
  })

  it('works with no lots and no section', () => {
    const s = sitePlanSvg({ ...input, lots: [], section: null, slopeImage: null })
    expect(s).not.toContain('class="lot"')
    expect(s).not.toContain('NaN')
    expect(s).not.toContain('clip-path')
  })
})
