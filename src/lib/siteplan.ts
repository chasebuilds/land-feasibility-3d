import type { Ring, XY } from './geo'
import { M_PER_FT } from './geo'

export interface PlanLot {
  id: number
  lot: Ring
  pad: Ring
  house: Ring
  padElevFt: number
  cutCY: number
  fillCY: number
  depthFt: number
}

export interface PlanInput {
  title: string
  boundaryNote: string
  parcel: Ring
  lots: PlanLot[]
  section?: [XY, XY] | null
  slopeImage?: { href: string; x: number; y: number; w: number; h: number } | null
  stats: {
    acres: number
    buildableAcres: number
    meanSlope: number
    cutCY: number
    fillCY: number
    gridAngleDeg: number
    demSource: string
    date: string
  }
}

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Largest 1, 2 or 5 times a power of ten that is not above `x`. */
export function niceLength(x: number): number {
  if (!(x > 0)) return 0
  const p = 10 ** Math.floor(Math.log10(x))
  const m = x / p
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p
}

export function padColor(depthFt: number): string {
  if (depthFt < 2) return '#f7ecd9'
  if (depthFt < 6) return '#f2c98f'
  if (depthFt < 12) return '#d9822b'
  return '#8c3b12'
}

const fmt = (v: number, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

/** A printable first-pass site plan as one standalone SVG string. North is up. */
export function sitePlanSvg(inp: PlanInput, W = 1100, H = 850): string {
  const mapW = W * 0.66
  const pad = 36
  const all = [...inp.parcel, ...inp.lots.flatMap((l) => l.lot)]
  const xs = all.map((p) => p[0])
  const ys = all.map((p) => p[1])
  const minX = Math.min(...xs) - 15, maxX = Math.max(...xs) + 15
  const minY = Math.min(...ys) - 15, maxY = Math.max(...ys) + 15
  const k = Math.min((mapW - 2 * pad) / (maxX - minX), (H - 2 * pad - 60) / (maxY - minY))
  const ox = pad + (mapW - 2 * pad - k * (maxX - minX)) / 2
  const oy = pad + 30
  const P = ([x, y]: XY) => `${(ox + (x - minX) * k).toFixed(1)},${(oy + (y - minY) * k).toFixed(1)}`
  const pts = (r: Ring) => r.map(P).join(' ')
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">`)
  out.push(`<rect width="${W}" height="${H}" fill="#fffdf8"/>`)
  out.push(`<defs><clipPath id="parcel"><polygon points="${pts(inp.parcel)}"/></clipPath></defs>`)
  out.push(`<rect x="12" y="12" width="${mapW - 12}" height="${H - 24}" fill="none" stroke="#c9b9a6"/>`)
  if (inp.slopeImage) {
    const s = inp.slopeImage
    out.push(
      `<image href="${esc(s.href)}" x="${(ox + (s.x - minX) * k).toFixed(1)}" y="${(oy + (s.y - minY) * k).toFixed(1)}" width="${(s.w * k).toFixed(1)}" height="${(s.h * k).toFixed(1)}" preserveAspectRatio="none" opacity="0.75" clip-path="url(#parcel)"/>`,
    )
  }
  out.push(`<polygon class="boundary" points="${pts(inp.parcel)}" fill="none" stroke="#2a211a" stroke-width="2.5" stroke-dasharray="10 5"/>`)
  for (const l of inp.lots) out.push(`<polygon class="lot" points="${pts(l.lot)}" fill="none" stroke="#6a5848" stroke-width="1"/>`)
  for (const l of inp.lots) {
    out.push(`<polygon class="pad" points="${pts(l.pad)}" fill="${padColor(l.depthFt)}" stroke="#6b4a2b" stroke-width="1"/>`)
    out.push(`<polygon class="house" points="${pts(l.house)}" fill="#ffffff" stroke="#2a211a" stroke-width="1"/>`)
    const c = l.pad.reduce((a, p) => [a[0] + p[0] / l.pad.length, a[1] + p[1] / l.pad.length], [0, 0]) as XY
    const [cx, cy] = P(c).split(',').map(Number)
    out.push(`<text x="${cx}" y="${cy! + 4}" font-size="11" font-weight="700" text-anchor="middle" fill="#2a211a">${l.id}</text>`)
  }
  if (inp.section) {
    const [a, b] = inp.section
    const [ax, ay] = P(a).split(',').map(Number)
    const [bx, by] = P(b).split(',').map(Number)
    out.push(`<line class="section" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#e8663f" stroke-width="2.5"/>`)
    out.push(`<text x="${ax}" y="${ay! - 6}" font-size="13" font-weight="700" fill="#e8663f" text-anchor="middle">A</text>`)
    out.push(`<text x="${bx}" y="${by! - 6}" font-size="13" font-weight="700" fill="#e8663f" text-anchor="middle">A'</text>`)
  }
  // North arrow and scale bar.
  const nx = mapW - 50
  out.push(`<g class="north"><polygon points="${nx},40 ${nx - 9},64 ${nx},58 ${nx + 9},64" fill="#2a211a"/><text x="${nx}" y="80" font-size="12" text-anchor="middle">N</text></g>`)
  const barFt = niceLength(((mapW - 2 * pad) / 4 / k) / M_PER_FT)
  const barPx = barFt * M_PER_FT * k
  const by0 = H - 40
  out.push(
    `<g class="scale"><rect x="${pad}" y="${by0}" width="${barPx.toFixed(1)}" height="6" fill="#2a211a"/><rect x="${pad}" y="${by0}" width="${(barPx / 2).toFixed(1)}" height="6" fill="#fffdf8" stroke="#2a211a"/><text x="${pad}" y="${by0 - 6}" font-size="11">0</text><text x="${(pad + barPx).toFixed(1)}" y="${by0 - 6}" font-size="11" text-anchor="end">${fmt(barFt)} ft</text></g>`,
  )
  out.push(`<text x="${pad}" y="34" font-size="13" font-weight="700" fill="#8a5a00">${esc(inp.boundaryNote)}</text>`)

  // Right column.
  const rx = mapW + 20
  let y = 44
  const line = (txt: string, size = 12, weight = 400, color = '#2a211a') => {
    out.push(`<text x="${rx}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(txt)}</text>`)
    y += size + 7
  }
  line(inp.title, 20, 700)
  line(`First-pass site plan, ${inp.stats.date}`, 12, 400, '#6a5848')
  y += 8
  const s = inp.stats
  const rows: [string, string][] = [
    ['Boundary area', `${fmt(s.acres, 1)} ac`],
    ['Under 15% slope', `${fmt(s.buildableAcres, 1)} ac`],
    ['Average slope', `${fmt(s.meanSlope, 1)}%`],
    ['Lots with pads', fmt(inp.lots.length)],
    ['Pad cut / fill', `${fmt(s.cutCY)} / ${fmt(s.fillCY)} CY`],
    ['Lot grid angle', `${fmt(s.gridAngleDeg)} deg from north`],
  ]
  for (const [a, b] of rows) {
    out.push(`<text x="${rx}" y="${y}" font-size="12" fill="#6a5848">${esc(a)}</text><text x="${W - 24}" y="${y}" font-size="12" font-weight="700" text-anchor="end">${esc(b)}</text>`)
    y += 19
  }
  y += 8
  line('Pad color = deepest cut or fill', 12, 700)
  for (const [d, label] of [[0, 'under 2 ft'], [2, '2 to 6 ft'], [6, '6 to 12 ft'], [12, 'over 12 ft']] as [number, string][]) {
    out.push(`<rect x="${rx}" y="${y - 10}" width="14" height="12" fill="${padColor(d)}" stroke="#6b4a2b"/><text x="${rx + 22}" y="${y}" font-size="12">${label}</text>`)
    y += 18
  }
  if (inp.slopeImage) {
    y += 4
    line('Shading = slope class', 12, 700)
    for (const [c, label] of [['#28a745', 'under 15%'], ['#f0b914', '15 to 25%'], ['#dc352d', 'over 25%']]) {
      out.push(`<rect x="${rx}" y="${y - 10}" width="14" height="12" fill="${c}" opacity="0.75"/><text x="${rx + 22}" y="${y}" font-size="12">${label}</text>`)
      y += 18
    }
  }
  y += 8
  out.push(`<text x="${rx}" y="${y}" font-size="11" font-weight="700" font-family="Menlo, Consolas, monospace" xml:space="preserve" style="white-space:pre">Lot  pad grade ft   cut CY  fill CY</text>`)
  y += 18
  const maxRows = Math.max(0, Math.floor((H - 130 - y) / 15))
  for (const l of inp.lots.slice(0, maxRows)) {
    out.push(
      `<text x="${rx}" y="${y}" font-size="11" font-family="Menlo, Consolas, monospace" xml:space="preserve" style="white-space:pre">${esc(
        `${String(l.id).padStart(3)}  ${fmt(l.padElevFt, 1).padStart(12)}  ${fmt(l.cutCY).padStart(7)}  ${fmt(l.fillCY).padStart(7)}`,
      )}</text>`,
    )
    y += 15
  }
  if (inp.lots.length > maxRows) line(`...and ${inp.lots.length - maxRows} more lots`, 11, 400, '#6a5848')
  const notes = [
    'Screening only. Not a survey, engineering or plat.',
    `Elevation: ${s.demSource}.`,
    'All lots, pads and quantities are estimates.',
    'Zoning, utilities, access and soils: check with county.',
  ]
  let ny = H - 30 - notes.length * 15
  for (const n of notes) {
    out.push(`<text x="${rx}" y="${ny}" font-size="10.5" fill="#6a5848">${esc(n)}</text>`)
    ny += 15
  }
  out.push('</svg>')
  return out.join('\n')
}
