// Seeded benchmark on synthetic terrain with known answers. Writes BENCHMARK.md.
// Run: npm run bench
import { writeFileSync } from 'node:fs'
import { CY_PER_M3, cellsInRing, pointInRing, type Grid, type Ring, type XY } from '../src/lib/geo'
import { BUILDABLE, STEEP, classify, slopePercent } from '../src/lib/slope'
import { padEarthwork, padEarthworkOnGrid } from '../src/lib/earthwork'
import { bestLayout, packLots, rect, type ClassGrid } from '../src/lib/layout'
import { EXITS, runExit, type Assumptions, type CaseKey } from '../src/lib/proforma'

const SEED = 20261123
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(SEED)
const U = (a: number, b: number) => a + (b - a) * rand()
const pctl = (v: number[], p: number) => [...v].sort((x, y) => x - y)[Math.min(v.length - 1, Math.floor(p * v.length))]!
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
const f1 = (v: number) => v.toFixed(1)
const f2 = (v: number) => v.toFixed(2)
const n0 = (v: number) => Math.round(v).toLocaleString('en-US')

// 1. Slope on analytic surfaces: a tilted plane plus a Gaussian hill, true gradient known everywhere.
const slopeErr: number[] = []
let classMatch = 0, classTotal = 0
const SURFACES = 200, N = 120, CELL = 2
for (let s = 0; s < SURFACES; s++) {
  const gx = U(-0.4, 0.4), gy = U(-0.4, 0.4)
  const h = U(0, 30), sig = U(8, 60), hx = U(60, 180), hy = U(60, 180)
  const data = new Float32Array(N * N)
  const truth = new Float64Array(N * N)
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const x = (c + 0.5) * CELL, y = (r + 0.5) * CELL
      const e = Math.exp(-((x - hx) ** 2 + (y - hy) ** 2) / (2 * sig * sig))
      data[r * N + c] = 300 + gx * x + gy * y + h * e
      const dx = gx - (h * e * (x - hx)) / (sig * sig)
      const dy = gy - (h * e * (y - hy)) / (sig * sig)
      truth[r * N + c] = Math.hypot(dx, dy) * 100
    }
  const got = slopePercent({ width: N, height: N, data }, CELL)
  for (let r = 1; r < N - 1; r += 3)
    for (let c = 1; c < N - 1; c += 3) {
      const i = r * N + c
      slopeErr.push(Math.abs(got[i]! - truth[i]!))
      classTotal++
      if (classify(got[i]!) === classify(truth[i]!)) classMatch++
    }
}

// 2. Balanced-pad cut and fill on tilted planes vs a fine numerical integral of the same plane.
const PADS = 200
const cutErr: number[] = []
const rawErr: number[] = []
for (let k = 0; k < PADS; k++) {
  const s = U(0, 0.3), aspect = U(0, 2 * Math.PI)
  const gx = s * Math.cos(aspect), gy = s * Math.sin(aspect)
  const W = 18.3, D = 15.2, cell = 2
  const x0 = U(20, 22), y0 = U(20, 22)
  const g: Grid = { width: 40, height: 40, data: new Float32Array(1600), minX: 0, maxY: 0, px: cell, scale: 1 }
  for (let r = 0; r < 40; r++) for (let c = 0; c < 40; c++) g.data[r * 40 + c] = 200 + gx * (c + 0.5) * cell + gy * (r + 0.5) * cell
  const pad = rect(x0, y0, W, D)
  const raw = padEarthwork(cellsInRing(g, pad).map((i) => g.data[i]!), cell * cell)
  const ew = padEarthworkOnGrid(g, pad)
  // Truth: the same balanced pad (mean grade over the pad area) integrated at 0.05 m.
  const n = 400
  let sum = 0
  const z: number[] = []
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const v = 200 + gx * (x0 + ((i + 0.5) / n) * W) + gy * (y0 + ((j + 0.5) / n) * D)
      z.push(v)
      sum += v
    }
  const m = sum / z.length
  const trueCut = z.reduce((a, v) => a + Math.max(0, v - m), 0) * ((W * D) / z.length) * CY_PER_M3
  if (trueCut > 5) {
    cutErr.push(Math.abs(ew.cutCY - trueCut) / trueCut)
    rawErr.push(Math.abs(raw.cutCY - trueCut) / trueCut)
  }
}

// 3. Layout on synthetic ridges: a flat strip at a random angle inside a steeper boundary.
const RIDGES = 100
let northLots = 0, bestLots = 0, ridgesGained = 0, padsChecked = 0, padsFlat = 0, lotsOutside = 0
const params = { minLotAcres: 0.5, setbackM: 7.62, padW: 18.3, padD: 15.2, minBuildableShare: 0.9 }
let layoutMs = 0
for (let k = 0; k < RIDGES; k++) {
  const len = U(250, 450), wid = U(45, 90), ang = U(0, Math.PI)
  const c: XY = [300, 300]
  const turn = (r: Ring): Ring => r.map(([x, y]) => [(x - c[0]) * Math.cos(ang) - (y - c[1]) * Math.sin(ang) + c[0], (x - c[0]) * Math.sin(ang) + (y - c[1]) * Math.cos(ang) + c[1]])
  const strip = turn(rect(c[0] - len / 2, c[1] - wid / 2, len, wid))
  const parcel = turn(rect(c[0] - len / 2 - 30, c[1] - wid / 2 - 30, len + 60, wid + 60))
  const cell = 2, W = 300
  const classes = new Uint8Array(W * W)
  for (let r = 0; r < W; r++) for (let q = 0; q < W; q++) classes[r * W + q] = pointInRing([(q + 0.5) * cell, (r + 0.5) * cell], strip) ? BUILDABLE : STEEP
  const g: ClassGrid = { width: W, height: W, cell, classes }
  const t0 = performance.now()
  const north = packLots(parcel, g, params)
  const best = bestLayout(parcel, g, params)
  layoutMs += performance.now() - t0
  northLots += north.length
  bestLots += best.lots.length
  if (best.lots.length > north.length) ridgesGained++
  for (const l of best.lots) {
    for (const p of l.lot) if (!pointInRing(p, parcel) && Math.min(...parcel.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1]))) > 1e-6) lotsOutside++
    // Independent check at 0.5 m against the true strip geometry, not the class grid.
    const [a, b, , d] = l.pad as [XY, XY, XY, XY]
    let ok = 0, tot = 0
    for (let j = 0; j < 30; j++)
      for (let i = 0; i < 36; i++) {
        const u = (i + 0.5) / 36, v = (j + 0.5) / 30
        const p: XY = [a[0] + u * (b[0] - a[0]) + v * (d[0] - a[0]), a[1] + u * (b[1] - a[1]) + v * (d[1] - a[1])]
        tot++
        if (pointInRing(p, strip)) ok++
      }
    padsChecked++
    if (ok / tot >= 0.85) padsFlat++
  }
}

// 4. Pro forma bookkeeping on random assumption sets.
const SETS = 1000
let maxEquityGap = 0, maxSourcesGap = 0, runs = 0, shortfalls = 0
for (let k = 0; k < SETS; k++) {
  const a: Assumptions = {
    landPrice: U(20_000, 1_500_000), closingPct: U(0, 0.06), lots: Math.floor(U(1, 60)), earthworkCY: U(0, 40_000),
    asIsSalePrice: U(20_000, 2_000_000), asIsMonths: Math.floor(U(1, 36)), entitlementCost: U(0, 150_000),
    paperLotPrice: U(5_000, 80_000), paperMonths: Math.floor(U(2, 48)), siteWorkPerLot: U(5_000, 90_000),
    earthworkPerCY: U(2, 20), padLotPrice: U(20_000, 150_000), padMonths: Math.floor(U(3, 60)), homeSqft: U(900, 3500),
    buildCostPerSqft: U(90, 300), homePrice: U(120_000, 900_000), homeMonths: Math.floor(U(8, 72)), sellingPct: U(0, 0.08),
    loanToCost: U(0, 0.85), interestRate: U(0, 0.15),
  }
  for (const e of EXITS)
    for (const kase of ['downside', 'base', 'upside'] as CaseKey[]) {
      const r = runExit(a, e.key, kase)
      const uses = Object.values(r.costs).reduce((x, y) => x + y, 0) + r.interest
      maxEquityGap = Math.max(maxEquityGap, Math.abs(r.cumulative.at(-1)! - r.profit))
      maxSourcesGap = Math.max(maxSourcesGap, Math.abs(r.equity + r.loan - uses))
      runs++
      if (r.shortfall > 0) shortfalls++
    }
}

// 5. Speed of the slope pass on a 900 x 900 grid (the app's largest).
const big = new Float32Array(900 * 900).map((_, i) => 300 + (i % 900) * 0.2 + Math.floor(i / 900) * 0.1)
const t1 = performance.now()
slopePercent({ width: 900, height: 900, data: big }, 2)
const slopeMs = performance.now() - t1

const md = `# Benchmark

Written by \`npm run bench\` (\`bench/run.ts\`) on ${new Date().toISOString().slice(0, 10)}, Node ${process.version}, seed ${SEED}.
All terrain here is synthetic with a known answer. No real parcel is used.

## Slope (Horn method, 2 m cells)

${SURFACES} surfaces, each a random plane (up to 40% each way) plus a random Gaussian hill, compared with the exact gradient at ${n0(slopeErr.length)} interior cells.

| Measure | Result |
| --- | --- |
| Mean absolute error | ${f2(mean(slopeErr))} slope points |
| 99th percentile error | ${f2(pctl(slopeErr, 0.99))} slope points |
| Same class as the exact slope (under 15 / 15 to 25 / over 25) | ${f1((100 * classMatch) / classTotal)}% of ${n0(classTotal)} cells |

## Balanced-pad cut and fill (2 m cells)

${PADS} pads of 60 x 50 ft on planes up to 30% slope at random aspect. Truth is the same mean-grade pad integrated at 0.05 m. ${cutErr.length} pads with more than 5 CY of cut are scored.

| Measure | Result |
| --- | --- |
| Mean error in cut CY, area-weighted cells (what the app uses) | ${f1(100 * mean(cutErr))}% |
| 90th percentile error, area-weighted | ${f1(100 * pctl(cutErr, 0.9))}% |
| Mean error with plain 2 m x 2 m cells (before v0.2.0) | ${f1(100 * mean(rawErr))}% |

The rest of the error comes from the pad edge: on a 2 m grid the cells whose centers fall inside the pad do not trace its outline exactly.

## Lot layout on turned ridges

${RIDGES} flat strips (${'45 to 90'} m wide, 250 to 450 m long) at random angles, with 30 m of steep ground around them inside the boundary. Half-acre lots, 25 ft setback, 60 x 50 ft pads.

| Measure | Result |
| --- | --- |
| Lots, north-aligned grid only | ${n0(northLots)} |
| Lots, grid turned to the best candidate angle | ${n0(bestLots)} |
| Ridges where turning the grid added lots | ${ridgesGained} of ${RIDGES} |
| Pads at least 85% on truly flat ground (checked at 0.5 m against the strip, not the class grid) | ${padsFlat} of ${padsChecked} |
| Lot corners outside the boundary | ${lotsOutside} |
| Layout time, north plus best angle, per ridge | ${f1(layoutMs / RIDGES)} ms |

The app requires 90% flat on the 2 m class grid; the 85% check allows for cells cut by the strip edge.

## Pro forma bookkeeping

${SETS} random assumption sets x 4 exits x 3 cases = ${n0(runs)} runs.

| Measure | Result |
| --- | --- |
| Largest gap between profit and the sum of equity cash flows | $${maxEquityGap.toExponential(1)} |
| Largest gap between sources and uses | $${maxSourcesGap.toExponential(1)} |
| Runs where sales did not repay the loan (equity covers the shortfall) | ${n0(shortfalls)} |

## Speed

| Measure | Result |
| --- | --- |
| Slope pass on a 900 x 900 grid | ${n0(slopeMs)} ms |
`
writeFileSync(new URL('../BENCHMARK.md', import.meta.url), md)
console.log(md)
