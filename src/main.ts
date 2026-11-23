import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, ImageSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import mlWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import './style.css'
import { loadDem, TERRARIUM_URL } from './dem'
import { floodZones, streamsNear, FTYPE, type FloodZone, type Stream } from './facts'
import type { Grid, LngLat, Ring, XY } from './lib/geo'
import { cellSize, cellsInRing, distToSegment, fromLocal, M_PER_FT, ringArea, SQM_PER_ACRE, toLocal } from './lib/geo'
import { classAreas, LIMITS } from './lib/slope'
import { bestLayout, packLots, type Lot } from './lib/layout'
import { sitePlanSvg } from './lib/siteplan'
import { padEarthworkOnGrid, type Earthwork } from './lib/earthwork'
import { crossingDepths, profile } from './lib/section'
import { CASES, EXITS, defaultAssumptions, runExit, type Assumptions, type CaseKey, type ExitKey, type Result } from './lib/proforma'
import type { SlopeReply, SlopeRequest } from './slope.worker'
import SlopeWorker from './slope.worker?worker'

/** Invented for the demo. It is not a real parcel and carries no ownership data. */
const EXAMPLE: LngLat[] = [
  [-82.5097, 37.4719],
  [-82.5072, 37.4722],
  [-82.5059, 37.4713],
  [-82.5061, 37.4697],
  [-82.5084, 37.4694],
  [-82.5099, 37.4703],
]

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const ft = (m: number) => m / M_PER_FT
const n0 = (v: number) => Math.round(v).toLocaleString('en-US')
const n1 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
const usd = (v: number) => (v < 0 ? '-$' : '$') + n0(Math.abs(v))
const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const acres = (m2: number) => m2 / SQM_PER_ACRE

interface PadInfo {
  lot: Lot
  ew: Earthwork
}

const state = {
  parcel: EXAMPLE as LngLat[],
  isExample: true,
  grid: null as Grid | null,
  demSource: '',
  slope: null as Float32Array | null,
  classes: null as Uint8Array | null,
  rgba: null as Uint8ClampedArray | null,
  pads: [] as PadInfo[],
  section: null as [LngLat, LngLat] | null,
  streams: [] as Stream[],
  nearestStream: null as { at: LngLat; distM: number; name: string | null } | null,
  mode: 'none' as 'none' | 'parcel' | 'section',
  draft: [] as LngLat[],
  assumptions: null as Assumptions | null,
  kase: 'base' as CaseKey,
  exit: 'finishedPads' as ExitKey,
  run: 0,
  gridAngle: 0,
  slopeUrl: '',
  northLots: 0,
}

maplibregl.setWorkerUrl(mlWorkerUrl)

const map = new maplibregl.Map({
  container: 'map',
  center: [-82.5079, 37.4704],
  zoom: 16.2,
  pitch: 62,
  bearing: -20,
  maxPitch: 85,
  canvasContextAttributes: { preserveDrawingBuffer: true },
  style: {
    version: 8,
    sources: {
      imagery: {
        type: 'raster',
        tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 16,
        attribution: 'Imagery and topo: USGS The National Map',
      },
      topo: {
        type: 'raster',
        tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 16,
      },
      dem: { type: 'raster-dem', tiles: [TERRARIUM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Terrain Tiles on AWS (Mapzen/USGS 3DEP)' },
      hs: { type: 'raster-dem', tiles: [TERRARIUM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 15 },
    },
    layers: [
      { id: 'imagery', type: 'raster', source: 'imagery' },
      { id: 'topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } },
      { id: 'hillshade', type: 'hillshade', source: 'hs', paint: { 'hillshade-exaggeration': 0.3, 'hillshade-shadow-color': '#2b2118' } },
    ],
    terrain: { source: 'dem', exaggeration: 1.4 },
    sky: { 'sky-color': '#f3d9bf', 'horizon-color': '#f7e6d4', 'fog-color': '#efe2d2', 'sky-horizon-blend': 0.6 },
  },
})
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right')

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] })
const poly = (ring: LngLat[], props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
})
const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined

function addLayers() {
  for (const id of ['parcel', 'lots', 'pads', 'houses', 'streams', 'section-line', 'draft'])
    map.addSource(id, { type: 'geojson', data: empty() })
  map.addLayer({ id: 'streams', type: 'line', source: 'streams', paint: { 'line-color': '#2f8fe0', 'line-width': 3, 'line-opacity': 0.9 } })
  map.addLayer({ id: 'parcel-line', type: 'line', source: 'parcel', paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-dasharray': [2, 1] } })
  map.addLayer({ id: 'lots', type: 'line', source: 'lots', paint: { 'line-color': '#fff4e6', 'line-width': 1.2, 'line-opacity': 0.85 } })
  map.addLayer({
    id: 'pads',
    type: 'fill',
    source: 'pads',
    paint: {
      'fill-color': ['interpolate', ['linear'], ['get', 'depthFt'], 0, '#f7ecd9', 2, '#f2c98f', 6, '#d9822b', 12, '#8c3b12'],
      'fill-opacity': 0.9,
      'fill-outline-color': '#6b4a2b',
    },
  })
  map.addLayer({
    id: 'houses',
    type: 'fill-extrusion',
    source: 'houses',
    paint: { 'fill-extrusion-color': '#fbf6ee', 'fill-extrusion-height': 7, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.95 },
  })
  map.addLayer({ id: 'section-line', type: 'line', source: 'section-line', paint: { 'line-color': '#ff7a59', 'line-width': 4 } })
  map.addLayer({ id: 'draft', type: 'line', source: 'draft', paint: { 'line-color': '#ffd166', 'line-width': 3 } })
  map.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', paint: { 'circle-color': '#ffd166', 'circle-radius': 5 } })
}

// ---------- analysis pipeline ----------

function bboxOf(ring: LngLat[], padM: number): [LngLat, LngLat] {
  const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length
  const dLat = padM / 110540
  const dLon = padM / (111320 * Math.cos((lat * Math.PI) / 180))
  const lons = ring.map((p) => p[0])
  const lats = ring.map((p) => p[1])
  return [
    [Math.min(...lons) - dLon, Math.min(...lats) - dLat],
    [Math.max(...lons) + dLon, Math.max(...lats) + dLat],
  ]
}

function runWorker(req: SlopeRequest): Promise<SlopeReply> {
  return new Promise((resolve, reject) => {
    const w = new SlopeWorker()
    w.onmessage = (e: MessageEvent<SlopeReply>) => {
      resolve(e.data)
      w.terminate()
    }
    w.onerror = (e) => {
      reject(new Error(e.message))
      w.terminate()
    }
    w.postMessage(req)
  })
}

async function analyze() {
  const run = ++state.run
  setStatus('Loading LiDAR elevation for the boundary...')
  src('parcel')?.setData({ type: 'FeatureCollection', features: [poly(state.parcel)] })
  $('parcel-badge').textContent = state.isExample ? 'Example boundary, not a real parcel' : 'Your boundary'
  const [sw, ne] = bboxOf(state.parcel, 80)
  factsPending()
  void loadFacts(run)
  try {
    const { grid, source } = await loadDem(sw, ne, 2)
    if (run !== state.run) return
    state.grid = grid
    state.demSource = source
    setStatus('Computing slope in a background worker...')
    const reply = await runWorker({ width: grid.width, height: grid.height, data: grid.data.slice(), cell: cellSize(grid) })
    if (run !== state.run) return
    Object.assign(state, reply)
    drawSlope()
    relayout()
    setStatus(`Done. ${grid.width} x ${grid.height} cells analyzed.`)
    $('dem-source').textContent = `Elevation: ${source}.`
  } catch (e) {
    setStatus(`Could not load elevation: ${(e as Error).message}. Try again in a minute.`)
  }
}

function drawSlope() {
  const g = state.grid
  if (!g || !state.rgba) return
  const cv = document.createElement('canvas')
  cv.width = g.width
  cv.height = g.height
  const px = new Uint8ClampedArray(state.rgba)
  const inside = new Uint8Array(g.width * g.height)
  for (const i of cellsInRing(g, state.parcel.map((p) => toLocal(g, p)))) inside[i] = 1
  // Fade the heatmap outside the boundary so the parcel reads first.
  for (let i = 0; i < inside.length; i++) if (!inside[i]) px[i * 4 + 3] = Math.round(px[i * 4 + 3]! * 0.3)
  cv.getContext('2d')!.putImageData(new ImageData(px, g.width, g.height), 0, 0)
  const W = g.width * cellSize(g)
  const H = g.height * cellSize(g)
  const coords = [fromLocal(g, [0, 0]), fromLocal(g, [W, 0]), fromLocal(g, [W, H]), fromLocal(g, [0, H])] as [LngLat, LngLat, LngLat, LngLat]
  const url = cv.toDataURL()
  state.slopeUrl = url
  const s = map.getSource('slope') as ImageSource | undefined
  if (s) s.updateImage({ url, coordinates: coords })
  else {
    map.addSource('slope', { type: 'image', url, coordinates: coords })
    map.addLayer({ id: 'slope', type: 'raster', source: 'slope', paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 } }, 'streams')
  }
  setVis('slope', ($('t-slope') as HTMLInputElement).checked)
}

function slopeTable(local: Ring) {
  const g = state.grid!
  const cells = cellsInRing(g, local)
  const a = classAreas(state.slope!, cells, cellSize(g) ** 2)
  const total = a.buildable + a.marginal + a.steep + a.nodata
  const row = (cls: string, label: string, m2: number) =>
    `<tr><td><i class="sw ${cls}"></i>${label}</td><td class="num">${n1(acres(m2))} ac</td><td class="num">${total ? pct(m2 / total) : '-'}</td></tr>`
  $('slope-table').innerHTML = `<table>
    ${row('b', `Under ${LIMITS.buildable}% (buildable)`, a.buildable)}
    ${row('m', `${LIMITS.buildable} to ${LIMITS.marginal}% (marginal)`, a.marginal)}
    ${row('s', `Over ${LIMITS.marginal}% (steep)`, a.steep)}
    ${a.nodata ? row('n', 'No elevation data', a.nodata) : ''}
    <tr class="tot"><td>Boundary area</td><td class="num">${n1(acres(ringArea(local)))} ac</td><td class="num">avg slope ${n1(a.meanSlope)}%</td></tr>
  </table>`
  const zs = cells.map((i) => g.data[i]!).filter((z) => z > -1000)
  return { meanSlope: a.meanSlope, minZ: Math.min(...zs), maxZ: Math.max(...zs), buildable: a.buildable }
}

let siteStats: ReturnType<typeof slopeTable> | null = null

function relayout() {
  const g = state.grid
  if (!g || !state.classes) return
  const local = state.parcel.map((p) => toLocal(g, p))
  siteStats = slopeTable(local)
  const num = (id: string) => Number(($(id) as HTMLInputElement).value)
  const cg = { width: g.width, height: g.height, cell: cellSize(g), classes: state.classes }
  const params = {
    minLotAcres: Math.max(0.05, num('i-lot')),
    setbackM: num('i-setback') * M_PER_FT,
    padW: num('i-padw') * M_PER_FT,
    padD: num('i-padd') * M_PER_FT,
    minBuildableShare: 0.9,
  }
  const fit = ($('i-fit') as HTMLInputElement).checked
  const northCount = fit ? packLots(local, cg, params).length : 0
  const chosen = fit ? bestLayout(local, cg, params) : { angle: 0, lots: packLots(local, cg, params) }
  const lots = chosen.lots
  state.gridAngle = chosen.angle
  state.northLots = fit ? northCount : lots.length
  state.pads = lots.map((lot) => ({ lot, ew: padEarthworkOnGrid(g, lot.pad) }))
  const ll = (r: Ring) => r.map((p) => fromLocal(g, p))
  src('lots')?.setData({ type: 'FeatureCollection', features: lots.map((l) => poly(ll(l.lot), { id: l.id })) })
  src('pads')?.setData({
    type: 'FeatureCollection',
    features: state.pads.map(({ lot, ew }) =>
      poly(ll(lot.pad), { id: lot.id, depthFt: ft(Math.max(ew.maxCut, ew.maxFill)), net: ew.fillCY - ew.cutCY }),
    ),
  })
  src('houses')?.setData({ type: 'FeatureCollection', features: lots.map((l) => poly(ll(l.house), { id: l.id })) })
  layoutTable()
  if (!state.section || state.isExample) state.section = defaultSection()
  drawSection()
  const earthCY = state.pads.reduce((s, p) => s + Math.max(p.ew.cutCY, p.ew.fillCY), 0)
  const ac = acres(ringArea(local))
  if (!state.assumptions) state.assumptions = defaultAssumptions(lots.length, earthCY, ac)
  else Object.assign(state.assumptions, { lots: lots.length, earthworkCY: Math.round(earthCY) })
  buildSliders()
  renderMoney()
  renderFacts()
}

function layoutTable() {
  const rows = state.pads
  const cut = rows.reduce((s, p) => s + p.ew.cutCY, 0)
  const fill = rows.reduce((s, p) => s + p.ew.fillCY, 0)
  $('layout-summary').innerHTML = rows.length
    ? `<div class="tiles">
        <div class="tile"><span>Lots</span><b class="num">${rows.length}</b></div>
        <div class="tile"><span>Cut</span><b class="num">${n0(cut)} CY</b></div>
        <div class="tile"><span>Fill</span><b class="num">${n0(fill)} CY</b></div>
      </div>
      <p class="fine">Grid turned ${n0((state.gridAngle * 180) / Math.PI)} degrees from north${
        state.northLots !== rows.length ? ` (a north-aligned grid fits ${state.northLots} lots)` : ''
      }. Pad color: deepest cut or fill under the pad, light under 2 ft, dark over 6 ft.</p>`
    : '<p class="warnline">No lot fits on buildable ground with these inputs. Try a smaller lot, smaller pad or smaller setback.</p>'
  $('lot-table').innerHTML = rows.length
    ? `<thead><tr><th>Lot</th><th>Pad grade (ft)</th><th>Cut CY</th><th>Fill CY</th><th>Deepest cut / fill (ft)</th><th>Flat share</th></tr></thead><tbody>${rows
        .map(
          (p) =>
            `<tr><td>${p.lot.id}</td><td class="num">${n1(ft(p.ew.padElev))}</td><td class="num">${n0(p.ew.cutCY)}</td><td class="num">${n0(p.ew.fillCY)}</td><td class="num">${n1(ft(p.ew.maxCut))} / ${n1(ft(p.ew.maxFill))}</td><td class="num">${pct(p.lot.buildableShare)}</td></tr>`,
        )
        .join('')}</tbody>`
    : ''
}

// ---------- cross-section ----------

function defaultSection(): [LngLat, LngLat] {
  const g = state.grid!
  const local = state.parcel.map((p) => toLocal(g, p))
  // Run the line along the lot rows (or across them, whichever way the boundary is longer)
  // through the row that holds the most pads.
  const a = state.gridAngle
  const dirs: XY[] = [
    [Math.cos(a), Math.sin(a)],
    [-Math.sin(a), Math.cos(a)],
  ]
  const span = (d: XY) => {
    const v = local.map((p) => p[0] * d[0] + p[1] * d[1])
    return [Math.min(...v), Math.max(...v)] as const
  }
  const [d, n] = span(dirs[0]!)[1] - span(dirs[0]!)[0] >= span(dirs[1]!)[1] - span(dirs[1]!)[0] ? [dirs[0]!, dirs[1]!] : [dirs[1]!, dirs[0]!]
  const pads = state.pads.map((p) => p.lot.center)
  const across = pads.map((p) => p[0] * n[0] + p[1] * n[1])
  let off = (span(n)[0] + span(n)[1]) / 2
  if (pads.length) {
    const rows = new Map<number, number[]>()
    for (const v of across) {
      const k = Math.round(v / 10)
      rows.set(k, [...(rows.get(k) ?? []), v])
    }
    const best = [...rows.values()].sort((x, y) => y.length - x.length)[0]!
    off = best.reduce((s, v) => s + v, 0) / best.length
  }
  const [lo, hi] = span(d)
  const at = (t: number): XY => [d[0] * t + n[0] * off, d[1] * t + n[1] * off]
  return [fromLocal(g, at(lo - 20)), fromLocal(g, at(hi + 20))]
}

function drawSection() {
  const g = state.grid
  const s = state.section
  if (!g || !s) return
  src('section-line')?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: s } }] })
  const a = toLocal(g, s[0])
  const b = toLocal(g, s[1])
  const pads = state.pads.map((p) => ({ id: p.lot.id, ring: p.lot.pad, elev: p.ew.padElev }))
  const pts = profile(g, a, b, 400, pads).filter((p) => Number.isFinite(p.ground))
  if (pts.length < 2) {
    $('section-chart').innerHTML = '<p class="fine">Section line is outside the elevation grid.</p>'
    return
  }
  const W = 900, H = 190, L = 54, R = 12, T = 14, B = 28
  const zs = pts.flatMap((p) => (p.pad === null ? [p.ground] : [p.ground, p.pad])).map(ft)
  const zmin = Math.floor(Math.min(...zs) / 10) * 10 - 10
  const zmax = Math.ceil(Math.max(...zs) / 10) * 10 + 10
  const dmax = ft(pts.at(-1)!.d)
  const X = (dM: number) => L + (ft(dM) / dmax) * (W - L - R)
  const Y = (zM: number) => T + (1 - (ft(zM) - zmin) / (zmax - zmin)) * (H - T - B)
  const ground = pts.map((p) => `${X(p.d).toFixed(1)},${Y(p.ground).toFixed(1)}`).join(' ')
  const area = `${X(pts[0]!.d)},${H - B} ${ground} ${X(pts.at(-1)!.d)},${H - B}`
  const padSegs: string[] = []
  let cur: typeof pts = []
  const flush = () => {
    if (cur.length > 1) {
      const fills = cur.map((p) => `${X(p.d)},${Y(p.pad!)}`).join(' ')
      const back = [...cur].reverse().map((p) => `${X(p.d)},${Y(p.ground)}`).join(' ')
      padSegs.push(`<polygon class="cf" points="${fills} ${back}"/><line class="pad" x1="${X(cur[0]!.d)}" x2="${X(cur.at(-1)!.d)}" y1="${Y(cur[0]!.pad!)}" y2="${Y(cur[0]!.pad!)}"/>`)
    }
    cur = []
  }
  for (const p of pts) {
    if (p.padId !== null && (!cur.length || cur[0]!.padId === p.padId)) cur.push(p)
    else {
      flush()
      if (p.padId !== null) cur.push(p)
    }
  }
  flush()
  let lastX = -Infinity
  const labels = [...crossingDepths(pts)].sort((p, q) => p[1].d - q[1].d).map(([id, c], k) => {
    const pad = state.pads.find((p) => p.lot.id === id)!
    const dft = ft(c.depth)
    const txt = `Lot ${id}: ${dft >= 0 ? '+' : ''}${n1(dft)} ft ${dft >= 0 ? 'fill' : 'cut'}`
    if (X(c.d) - lastX < 110) return ''
    lastX = X(c.d)
    return `<text class="lbl" x="${X(c.d)}" y="${Y(pad.ew.padElev) - 8 - (k % 2) * 13}" text-anchor="middle">${txt}</text>`
  })
  const ticks: string[] = []
  for (let z = zmin; z <= zmax; z += Math.max(10, Math.round((zmax - zmin) / 50) * 10)) {
    const y = T + (1 - (z - zmin) / (zmax - zmin)) * (H - T - B)
    ticks.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="ax" x="${L - 6}" y="${y + 4}" text-anchor="end">${z}</text>`)
  }
  for (let i = 0; i <= 5; i++) {
    const d = (dmax * i) / 5
    ticks.push(`<text class="ax" x="${L + (d / dmax) * (W - L - R)}" y="${H - 8}" text-anchor="middle">${n0(d)} ft</text>`)
  }
  $('section-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cross-section of ground and pad grade">
    ${ticks.join('')}<polygon class="earth" points="${area}"/><polyline class="ground" points="${ground}"/>${padSegs.join('')}${labels.join('')}
    <text class="ax" x="${L}" y="${T - 2}">elev ft</text></svg>`
  const zr = zs.length ? `${n0(Math.min(...pts.map((p) => ft(p.ground))))} to ${n0(Math.max(...pts.map((p) => ft(p.ground))))} ft ground` : ''
  $('section-note').textContent = `${n0(dmax)} ft line, ${zr}. Shaded band = cut or fill to reach pad grade.`
}

// ---------- site facts ----------

let flood: FloodZone[] | null | 'error' = null

function factsPending() {
  flood = null
  state.streams = []
  state.nearestStream = null
  src('streams')?.setData(empty())
  renderFacts()
}

async function loadFacts(run: number) {
  const [sw, ne] = bboxOf(state.parcel, 600)
  const [fz, st] = await Promise.allSettled([floodZones(state.parcel), streamsNear(sw, ne)])
  if (run !== state.run) return
  flood = fz.status === 'fulfilled' ? fz.value : 'error'
  if (st.status === 'fulfilled') {
    state.streams = st.value
    src('streams')?.setData({
      type: 'FeatureCollection',
      features: st.value.map((s) => ({ type: 'Feature', properties: { name: s.name }, geometry: { type: 'MultiLineString', coordinates: s.coords } })),
    })
  }
  renderFacts(st.status === 'rejected')
}

function nearestStream(): { at: LngLat; distM: number; name: string | null; type: string } | null {
  const g = state.grid
  if (!g || !state.streams.length) return null
  const ring = state.parcel.map((p) => toLocal(g, p))
  let best: { at: LngLat; distM: number; name: string | null; type: string } | null = null
  for (const s of state.streams)
    for (const path of s.coords)
      for (const v of path) {
        const p = toLocal(g, v)
        let d = Infinity
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, distToSegment(p, ring[j]!, ring[i]!))
        if (!best || d < best.distM) best = { at: v, distM: d, name: s.name, type: FTYPE[s.ftype] ?? `type ${s.ftype}` }
      }
  return best
}

function renderFacts(streamErr = false) {
  const near = nearestStream()
  state.nearestStream = near
  let floodHtml = '<span class="fine">Asking FEMA...</span>'
  if (flood === 'error') floodHtml = '<span class="warnline">FEMA NFHL did not answer. Check the FIRM panel at msc.fema.gov.</span>'
  else if (flood && !flood.length)
    floodHtml = 'No NFHL flood polygon touches this boundary. That can mean an unmapped area, not a safe one. Check the FIRM panel.'
  else if (flood) {
    const sfha = flood.some((z) => z.sfha)
    floodHtml = `${sfha ? '<b class="bad">Part of the boundary touches a Special Flood Hazard Area.</b> ' : '<b class="good">No Special Flood Hazard Area touches the boundary.</b> '}Zones: ${flood
      .map((z) => esc(z.zone + (z.subtype ? ` (${z.subtype.toLowerCase()})` : '')))
      .join(', ')}.`
  }
  let streamHtml = '<span class="fine">Asking USGS NHD...</span>'
  if (streamErr) streamHtml = '<span class="warnline">USGS NHD did not answer.</span>'
  else if (state.grid && flood !== null) {
    streamHtml = near
      ? `${state.streams.length} mapped flowline${state.streams.length === 1 ? '' : 's'} within about 2,000 ft. Nearest: ${esc(near.name ?? 'unnamed')} (${esc(near.type)}), about ${n0(ft(near.distM))} ft from the boundary${near.distM < 1 ? ', crossing it' : ''}.`
      : 'No mapped NHD flowline within about 2,000 ft.'
  }
  const s = siteStats
  const terrain = s
    ? `Ground runs ${n0(ft(s.minZ))} to ${n0(ft(s.maxZ))} ft above sea level (${n0(ft(s.maxZ - s.minZ))} ft of relief). Average slope ${n1(s.meanSlope)}%. ${n1(acres(s.buildable))} acres under ${LIMITS.buildable}%.`
    : 'Waiting for elevation...'
  const totalCut = state.pads.reduce((a, p) => a + p.ew.cutCY, 0)
  const check = (t: string, d: string) => `<li><b>${t}</b><span>${d}</span></li>`
  $('facts').innerHTML = `
    <h3>From public data (queried live)</h3>
    <ul class="facts">
      ${check('Flood zone (FEMA NFHL)', floodHtml)}
      ${check('Streams (USGS NHD)', streamHtml)}
      ${check('Terrain (USGS 3DEP)', terrain)}
      ${check('Earthwork (this layout)', state.pads.length ? `${state.pads.length} pads, about ${n0(totalCut)} CY of cut balanced on site. No rock, no haul-off, no retaining walls counted.` : 'No pads placed.')}
    </ul>
    <h3>Not in public data: check with the county</h3>
    <ul class="facts todo">
      ${check('Zoning and allowed use', 'Check with county planning. Not guessed here.')}
      ${check('Setbacks and minimum lot size', 'The layout uses the numbers on the Layout tab. Confirm them with the county.')}
      ${check('Road frontage and right of way', 'Check with the county road department or KYTC for access and any right of way.')}
      ${check('Water, sewer, power', 'Ask the water district and power company for distance to the nearest line and tap fees.')}
      ${check('Septic', 'Without sewer, each lot needs a passing soil test from the county health department.')}
      ${check('Mineral rights and past mining', 'Check deed records at the county clerk and state mine maps. Common on Eastern Kentucky ridges.')}
      ${check('Survey and title', 'A licensed surveyor and a title search. This boundary is drawn on a map, not surveyed.')}
    </ul>
    <h3>Gates before any offer</h3>
    <ol class="gates">
      <li>Zoning allows the planned use and lot size.</li>
      <li>Legal road access confirmed.</li>
      <li>Water and power can reach the site at a known cost.</li>
      <li>Soils pass for septic, or sewer is available.</li>
      <li>No floodway or stream crossing under the pads.</li>
      <li>A local site contractor has priced the grading and road.</li>
    </ol>`
}

// ---------- pro forma ----------

type Fmt = 'usd' | 'pct' | 'n' | 'mo'
const SLIDERS: [keyof Assumptions, string, number, number, number, Fmt][] = [
  ['landPrice', 'Land price', 0, 2_000_000, 5000, 'usd'],
  ['closingPct', 'Closing costs (share of land)', 0, 0.1, 0.005, 'pct'],
  ['lots', 'Lot count (from the layout)', 0, 60, 1, 'n'],
  ['earthworkCY', 'Earthwork (CY, from the layout)', 0, 100_000, 100, 'n'],
  ['earthworkPerCY', 'Cut and fill cost per CY', 0, 30, 0.5, 'usd'],
  ['asIsSalePrice', 'Sell as is: sale price', 0, 2_000_000, 5000, 'usd'],
  ['asIsMonths', 'Sell as is: months', 1, 36, 1, 'mo'],
  ['entitlementCost', 'Plat, survey, engineering', 0, 200_000, 1000, 'usd'],
  ['paperLotPrice', 'Paper lot price', 0, 100_000, 500, 'usd'],
  ['paperMonths', 'Paper lots: months', 1, 48, 1, 'mo'],
  ['siteWorkPerLot', 'Site work per lot (road, utilities)', 0, 120_000, 1000, 'usd'],
  ['padLotPrice', 'Finished pad lot price', 0, 200_000, 1000, 'usd'],
  ['padMonths', 'Finished pads: months', 1, 60, 1, 'mo'],
  ['homeSqft', 'Home size (sq ft)', 600, 4000, 50, 'n'],
  ['buildCostPerSqft', 'Build cost per sq ft', 50, 400, 5, 'usd'],
  ['homePrice', 'Home sale price', 50_000, 1_000_000, 5000, 'usd'],
  ['homeMonths', 'Build homes: months', 6, 72, 1, 'mo'],
  ['sellingPct', 'Selling costs (share of price)', 0, 0.1, 0.005, 'pct'],
  ['loanToCost', 'Loan to cost', 0, 0.9, 0.05, 'pct'],
  ['interestRate', 'Interest rate (annual)', 0, 0.2, 0.0025, 'pct'],
]
const fmt = (v: number, f: Fmt) => (f === 'usd' ? (Math.abs(v) < 100 && v % 1 ? `$${v.toFixed(2)}` : usd(v)) : f === 'pct' ? pct(v) : f === 'mo' ? `${v} mo` : n0(v))

function buildSliders() {
  const a = state.assumptions!
  $('sliders').innerHTML = SLIDERS.map(([k, label, min, max, step, f]) => {
    const hi = Math.max(max, a[k] * 1.5)
    return `<label class="slider"><span>${label}<b class="num" id="v-${k}">${fmt(a[k], f)}</b></span>
      <input type="range" data-k="${k}" min="${min}" max="${hi}" step="${step}" value="${a[k]}" /></label>`
  }).join('')
}

function renderMoney() {
  const a = state.assumptions
  if (!a) return
  const adj = CASES[state.kase]
  $('case-note').textContent =
    state.kase === 'base'
      ? 'Base case uses the assumptions as entered.'
      : `${state.kase[0]!.toUpperCase() + state.kase.slice(1)}: sale prices x${adj.price}, costs other than land x${adj.cost}, months x${adj.time}.`
  const results = EXITS.map((e) => runExit(a, e.key, state.kase))
  const rows: [string, (r: Result) => string][] = [
    ['Revenue', (r) => usd(r.revenue)],
    ['Total cost incl. interest', (r) => usd(Object.values(r.costs).reduce((x, y) => x + y, 0) + r.interest + r.sellingCosts)],
    ['Profit', (r) => `<b class="${r.profit >= 0 ? 'good' : 'bad'}">${usd(r.profit)}</b>`],
    ['Margin on revenue', (r) => pct(r.margin)],
    ['Peak cash in', (r) => usd(r.peakCash)],
    ['Profit / peak cash', (r) => pct(r.returnOnPeak)],
    ['Months', (r) => String(r.months)],
  ]
  $('exits').innerHTML = `<thead><tr><th></th>${EXITS.map(
    (e) => `<th><button class="exit ${e.key === state.exit ? 'on' : ''}" data-exit="${e.key}" title="${esc(e.note)}">${e.label}</button></th>`,
  ).join('')}</tr></thead><tbody>${rows
    .map(([l, f]) => `<tr><td>${l}</td>${results.map((r) => `<td class="num ${r.exit === state.exit ? 'sel' : ''}">${f(r)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`
  const r = results.find((x) => x.exit === state.exit)!
  const e = EXITS.find((x) => x.key === state.exit)!
  const uses: [string, number][] = [
    ['Land', r.costs.land],
    ['Closing', r.costs.closing],
    ['Plat, survey, engineering', r.costs.entitlement],
    ['Site work', r.costs.siteWork],
    ['Cut and fill', r.costs.earthwork],
    ['Construction', r.costs.construction],
    ['Interest', r.interest],
  ].filter(([, v]) => (v as number) > 0) as [string, number][]
  const usesTotal = uses.reduce((s, [, v]) => s + v, 0)
  const per = a.lots
    ? state.exit === 'buildHomes'
      ? `<h4>Per home</h4><table>
          <tr><td>Sale price</td><td class="num">${usd(a.homePrice * CASES[state.kase].price)}</td></tr>
          <tr><td>Build cost (${n0(a.homeSqft)} sq ft)</td><td class="num">${usd(a.homeSqft * a.buildCostPerSqft * CASES[state.kase].cost)}</td></tr>
          <tr><td>Land, lot and site cost</td><td class="num">${usd((r.costs.land + r.costs.closing + r.costs.entitlement + r.costs.siteWork + r.costs.earthwork) / a.lots)}</td></tr>
          <tr><td>Interest and selling</td><td class="num">${usd((r.interest + r.sellingCosts) / a.lots)}</td></tr>
          <tr class="tot"><td>Profit per home</td><td class="num">${usd(r.profit / a.lots)}</td></tr></table>`
      : state.exit !== 'asIs'
        ? `<h4>Per lot</h4><table><tr><td>Revenue per lot</td><td class="num">${usd(r.revenue / a.lots)}</td></tr><tr><td>All-in cost per lot</td><td class="num">${usd((usesTotal + r.sellingCosts) / a.lots)}</td></tr><tr class="tot"><td>Profit per lot</td><td class="num">${usd(r.profit / a.lots)}</td></tr></table>`
        : ''
    : ''
  $('exit-detail').innerHTML = `
    <h3>${e.label}: ${esc(e.note)}</h3>
    ${cashChart(r)}
    <div class="two">
      <div><h4>Uses</h4><table>${uses.map(([k, v]) => `<tr><td>${k}</td><td class="num">${usd(v)}</td></tr>`).join('')}
        <tr class="tot"><td>Total</td><td class="num">${usd(usesTotal)}</td></tr></table></div>
      <div><h4>Sources</h4><table><tr><td>Equity (cash in)</td><td class="num">${usd(r.equity)}</td></tr><tr><td>Loan incl. interest</td><td class="num">${usd(r.loan)}</td></tr>
        <tr class="tot"><td>Total</td><td class="num">${usd(r.equity + r.loan)}</td></tr></table>
        ${r.shortfall > 0 ? `<p class="fine bad">Sales do not repay the loan: equity pays another ${usd(r.shortfall)} at the end.</p>` : ''}
        <p class="fine">Selling costs of ${usd(r.sellingCosts)} come out of sale proceeds.</p></div>
    </div>
    ${per}`
}

function cashChart(r: Result) {
  const W = 400, H = 150, L = 74, B = 18, T = 10
  const v = r.cumulative
  const lo = Math.min(0, ...v)
  const hi = Math.max(0, ...v)
  const span = hi - lo || 1
  const bw = (W - L - 4) / v.length
  const Y = (x: number) => T + ((hi - x) / span) * (H - T - B)
  const bars = v
    .map((x, i) => `<rect class="${x < 0 ? 'neg' : 'pos'}" x="${L + i * bw + 0.5}" y="${Math.min(Y(x), Y(0))}" width="${Math.max(1, bw - 1)}" height="${Math.abs(Y(x) - Y(0)) || 0.5}"><title>Month ${i}: ${usd(x)}</title></rect>`)
    .join('')
  return `<svg class="cash" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative cash position by month">
    <line class="grid" x1="${L}" x2="${W}" y1="${Y(0)}" y2="${Y(0)}"/>
    <text class="ax" x="${L - 4}" y="${Y(hi) + 8}" text-anchor="end">${usd(hi)}</text>
    <text class="ax" x="${L - 4}" y="${Y(lo)}" text-anchor="end">${usd(lo)}</text>
    <text class="ax" x="${L - 4}" y="${Y(0) + 4}" text-anchor="end">$0</text>
    ${bars}<text class="ax" x="${L}" y="${H - 3}">month 0</text><text class="ax" x="${W - 2}" y="${H - 3}" text-anchor="end">month ${v.length - 1}</text></svg>
    <p class="fine">Cumulative cash in and out for the investor. Red = cash still at risk. The lowest point is peak cash.</p>`
}

// ---------- site plan export ----------

function planSvg(): string | null {
  const g = state.grid
  if (!g || !siteStats) return null
  const local = state.parcel.map((p) => toLocal(g, p))
  return sitePlanSvg({
    title: state.isExample ? 'Example ridge site' : 'Site study',
    boundaryNote: state.isExample ? 'Example boundary, not a real parcel' : 'Boundary drawn on a map, not surveyed',
    parcel: local,
    lots: state.pads.map(({ lot, ew }) => ({
      id: lot.id,
      lot: lot.lot,
      pad: lot.pad,
      house: lot.house,
      padElevFt: ft(ew.padElev),
      cutCY: ew.cutCY,
      fillCY: ew.fillCY,
      depthFt: ft(Math.max(ew.maxCut, ew.maxFill)),
    })),
    section: state.section ? [toLocal(g, state.section[0]), toLocal(g, state.section[1])] : null,
    slopeImage: state.slopeUrl ? { href: state.slopeUrl, x: 0, y: 0, w: g.width * cellSize(g), h: g.height * cellSize(g) } : null,
    stats: {
      acres: acres(ringArea(local)),
      buildableAcres: acres(siteStats.buildable),
      meanSlope: siteStats.meanSlope,
      cutCY: state.pads.reduce((s, p) => s + p.ew.cutCY, 0),
      fillCY: state.pads.reduce((s, p) => s + p.ew.fillCY, 0),
      gridAngleDeg: (state.gridAngle * 180) / Math.PI,
      demSource: state.demSource,
      date: new Date().toISOString().slice(0, 10),
    },
  })
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

async function exportPlan(kind: 'svg' | 'png' | 'pdf') {
  const svg = planSvg()
  if (!svg) return setStatus('Wait for the analysis to finish first.')
  if (kind === 'svg') return download(new Blob([svg], { type: 'image/svg+xml' }), 'site-plan.svg')
  if (kind === 'pdf') {
    const w = window.open('', '_blank')
    if (!w) return setStatus('The browser blocked the print window. Allow pop-ups for this page.')
    w.document.write(
      `<!doctype html><title>Site plan</title><style>@page{size:landscape;margin:10mm}body{margin:0}svg{width:100%;height:auto}</style>${svg}`,
    )
    w.document.close()
    w.addEventListener('load', () => w.print())
    setTimeout(() => w.print(), 600)
    return
  }
  const img = new Image()
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  await img.decode()
  const cv = document.createElement('canvas')
  cv.width = img.width * 2
  cv.height = img.height * 2
  const ctx = cv.getContext('2d')!
  ctx.scale(2, 2)
  ctx.drawImage(img, 0, 0)
  URL.revokeObjectURL(img.src)
  cv.toBlob((b) => b && download(b, 'site-plan.png'), 'image/png')
}

// ---------- drawing and inputs ----------

function setStatus(t: string) {
  $('status').textContent = t
}

function setVis(layer: string, on: boolean) {
  if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none')
}

function setMode(m: typeof state.mode) {
  state.mode = m
  state.draft = []
  src('draft')?.setData(empty())
  $('finish').hidden = m !== 'parcel'
  $('draw-hint').hidden = m !== 'parcel'
  $('draw').textContent = m === 'parcel' ? 'Cancel' : 'Draw boundary'
  $('draw-section').textContent = m === 'section' ? 'Click two points...' : 'Draw section line'
  map.getCanvas().style.cursor = m === 'none' ? '' : 'crosshair'
  if (m === 'none') map.doubleClickZoom.enable()
  else map.doubleClickZoom.disable()
}

function drawDraft() {
  const d = state.draft
  src('draft')?.setData({
    type: 'FeatureCollection',
    features: [
      ...(d.length > 1 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: d } }] : []),
      ...d.map((c) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: c } })),
    ],
  })
}

function setParcel(ring: LngLat[], example: boolean) {
  state.parcel = ring
  state.isExample = example
  state.section = null
  state.assumptions = null
  const [sw, ne] = bboxOf(ring, 40)
  const narrow = window.innerWidth < 820
  const padding = narrow ? { top: 120, bottom: window.innerHeight * 0.5 + 40, left: 20, right: 20 } : { top: 90, bottom: 250, left: 490, right: 70 }
  map.fitBounds([sw, ne], { padding, pitch: 60, bearing: -20, duration: 1200 })
  void analyze()
}

function finishParcel() {
  if (state.draft.length < 3) return setStatus('A boundary needs at least three corners.')
  const ring = state.draft.slice()
  setMode('none')
  setParcel(ring, false)
}

function ringFromGeoJSON(j: unknown): LngLat[] | null {
  const o = j as { type?: string; features?: unknown[]; geometry?: unknown; coordinates?: unknown }
  if (o?.type === 'FeatureCollection') {
    for (const f of o.features ?? []) {
      const r = ringFromGeoJSON(f)
      if (r) return r
    }
    return null
  }
  if (o?.type === 'Feature') return ringFromGeoJSON(o.geometry)
  const c = o?.coordinates as number[][][] | number[][][][] | undefined
  const outer = o?.type === 'Polygon' ? (c as number[][][])[0] : o?.type === 'MultiPolygon' ? (c as number[][][][])[0]?.[0] : null
  if (!outer || outer.length < 4) return null
  const ring = outer.map((p) => [p[0]!, p[1]!] as LngLat)
  const [f, l] = [ring[0]!, ring.at(-1)!]
  if (f[0] === l[0] && f[1] === l[1]) ring.pop()
  return ring
}

const VIEWS: Record<string, () => void> = {
  overview: () => map.easeTo({ pitch: 62, bearing: -20, duration: 900 }),
  top: () => map.easeTo({ pitch: 0, bearing: 0, duration: 900 }),
  low: () => map.easeTo({ pitch: 80, duration: 900 }),
  section: () => {
    const s = state.section
    if (!s) return
    const brg = (Math.atan2(s[1][0] - s[0][0], s[1][1] - s[0][1]) * 180) / Math.PI
    const mid: LngLat = [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2]
    map.easeTo({ center: mid, bearing: brg + 90, pitch: 78, duration: 1100 })
  },
  creek: () => {
    const n = state.nearestStream
    if (!n) return setStatus('No mapped stream found nearby yet.')
    map.easeTo({ center: n.at, pitch: 65, zoom: Math.max(map.getZoom(), 15.5), duration: 1100 })
  },
}

function wire() {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b))
      document.querySelectorAll<HTMLElement>('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab))
    }),
  )
  document.querySelectorAll<HTMLButtonElement>('.views button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.views button').forEach((x) => x.classList.toggle('on', x === b))
      VIEWS[b.dataset.view!]?.()
    }),
  )
  $('draw').addEventListener('click', () => setMode(state.mode === 'parcel' ? 'none' : 'parcel'))
  $('finish').addEventListener('click', finishParcel)
  $('reset').addEventListener('click', () => setParcel(EXAMPLE, true))
  $('plan-svg').addEventListener('click', () => void exportPlan('svg'))
  $('plan-png').addEventListener('click', () => void exportPlan('png'))
  $('plan-pdf').addEventListener('click', () => void exportPlan('pdf'))
  $('draw-section').addEventListener('click', () => setMode(state.mode === 'section' ? 'none' : 'section'))
  $('hide-section').addEventListener('click', () => {
    $('section').hidden = true
    $('show-section').hidden = false
  })
  $('show-section').addEventListener('click', () => {
    $('section').hidden = false
    $('show-section').hidden = true
  })
  $('geojson').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (!f) return
    try {
      const ring = ringFromGeoJSON(JSON.parse(await f.text()))
      if (!ring) throw new Error('no polygon found')
      setParcel(ring, false)
    } catch (err) {
      setStatus(`Could not read that file: ${(err as Error).message}.`)
    }
  })
  for (const [id, layers] of [
    ['t-slope', ['slope']],
    ['t-lots', ['lots', 'pads']],
    ['t-houses', ['houses']],
    ['t-streams', ['streams']],
  ] as const)
    $(id).addEventListener('change', (e) => layers.forEach((l) => setVis(l, (e.target as HTMLInputElement).checked)))
  $('t-topo').addEventListener('change', (e) => {
    const topo = (e.target as HTMLInputElement).checked
    setVis('topo', topo)
    setVis('imagery', !topo)
  })
  for (const id of ['i-lot', 'i-setback', 'i-padw', 'i-padd', 'i-fit']) $(id).addEventListener('change', relayout)
  $('sliders').addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement
    const k = t.dataset.k as keyof Assumptions | undefined
    if (!k || !state.assumptions) return
    state.assumptions[k] = Number(t.value)
    const f = SLIDERS.find((s) => s[0] === k)![5]
    $(`v-${k}`).textContent = fmt(state.assumptions[k], f)
    renderMoney()
  })
  document.querySelector('.cases')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-case]')
    if (!b) return
    state.kase = b.dataset.case as CaseKey
    document.querySelectorAll('.cases button').forEach((x) => x.classList.toggle('on', x === b))
    renderMoney()
  })
  $('exits').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-exit]')
    if (!b) return
    state.exit = b.dataset.exit as ExitKey
    renderMoney()
  })
  map.on('click', (e) => {
    const p: LngLat = [e.lngLat.lng, e.lngLat.lat]
    if (state.mode === 'parcel') {
      state.draft.push(p)
      drawDraft()
    } else if (state.mode === 'section') {
      state.draft.push(p)
      drawDraft()
      if (state.draft.length === 2) {
        state.section = [state.draft[0]!, state.draft[1]!]
        setMode('none')
        $('section').hidden = false
        $('show-section').hidden = true
        drawSection()
      }
    }
  })
  map.on('dblclick', () => {
    if (state.mode === 'parcel') finishParcel()
  })
}

wire()
map.on('load', () => {
  addLayers()
  setParcel(EXAMPLE, true)
})

// Exposed for screenshots and debugging only.
;(window as unknown as { lf: unknown }).lf = { map, state, VIEWS, planSvg }
