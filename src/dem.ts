import { fromArrayBuffer } from 'geotiff'
import type { Grid, LngLat } from './lib/geo'
import { toMerc } from './lib/geo'

export const DEP_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

export interface DemResult {
  grid: Grid
  source: string
}

const HALF = Math.PI * 6378137

/** Grid frame for a lon/lat box at about `cellM` meters per cell on the ground, capped at `maxPx` per side. */
export function frame(sw: LngLat, ne: LngLat, cellM: number, maxPx = 900) {
  const [x0, y0] = toMerc(sw)
  const [x1, y1] = toMerc(ne)
  const scale = Math.cos((((sw[1] + ne[1]) / 2) * Math.PI) / 180)
  const width = Math.min(maxPx, Math.max(8, Math.ceil(((x1 - x0) * scale) / cellM)))
  const px = (x1 - x0) / width
  const height = Math.min(maxPx, Math.max(8, Math.ceil((y1 - y0) / px)))
  return { width, height, px, scale, minX: x0, maxY: y0 + height * px }
}

async function from3dep(f: ReturnType<typeof frame>): Promise<Float32Array> {
  const bbox = [f.minX, f.maxY - f.height * f.px, f.minX + f.width * f.px, f.maxY].join(',')
  const q = new URLSearchParams({
    bbox,
    bboxSR: '3857',
    imageSR: '3857',
    size: `${f.width},${f.height}`,
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  })
  const res = await fetch(`${DEP_URL}?${q}`)
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('tiff')) throw new Error(`3DEP returned ${res.status}`)
  const tiff = await fromArrayBuffer(await res.arrayBuffer())
  const img = await tiff.getImage()
  const ras = (await img.readRasters({ interleave: true })) as unknown as ArrayLike<number>
  const out = Float32Array.from(ras)
  if (out.length !== f.width * f.height) throw new Error('3DEP size mismatch')
  const good = out.filter((z) => z > -1000 && z < 9000).length
  if (good < out.length * 0.9) throw new Error('3DEP has no data here')
  return out
}

async function fromTerrarium(f: ReturnType<typeof frame>, z = 15): Promise<Float32Array> {
  const world = 256 * 2 ** z
  const toPx = (mx: number) => ((mx + HALF) / (2 * HALF)) * world
  const toPy = (my: number) => ((HALF - my) / (2 * HALF)) * world
  const gx0 = toPx(f.minX), gx1 = toPx(f.minX + f.width * f.px)
  const gy0 = toPy(f.maxY), gy1 = toPy(f.maxY - f.height * f.px)
  const tx0 = Math.floor(gx0 / 256), tx1 = Math.floor(gx1 / 256)
  const ty0 = Math.floor(gy0 / 256), ty1 = Math.floor(gy1 / 256)
  const tw = tx1 - tx0 + 1
  const th = ty1 - ty0 + 1
  const mosaic = new Float32Array(tw * 256 * th * 256)
  const jobs: Promise<void>[] = []
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      jobs.push(
        (async () => {
          const url = TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty))
          const res = await fetch(url)
          if (!res.ok) throw new Error(`terrain tile ${res.status}`)
          const bmp = await createImageBitmap(await res.blob())
          const cv = new OffscreenCanvas(256, 256)
          const ctx = cv.getContext('2d')!
          ctx.drawImage(bmp, 0, 0)
          const d = ctx.getImageData(0, 0, 256, 256).data
          for (let r = 0; r < 256; r++)
            for (let c = 0; c < 256; c++) {
              const i = (r * 256 + c) * 4
              mosaic[((ty - ty0) * 256 + r) * tw * 256 + (tx - tx0) * 256 + c] = d[i]! * 256 + d[i + 1]! + d[i + 2]! / 256 - 32768
            }
        })(),
      )
  await Promise.all(jobs)
  const W = tw * 256
  const out = new Float32Array(f.width * f.height)
  for (let r = 0; r < f.height; r++)
    for (let c = 0; c < f.width; c++) {
      const x = toPx(f.minX + (c + 0.5) * f.px) - tx0 * 256 - 0.5
      const y = toPy(f.maxY - (r + 0.5) * f.px) - ty0 * 256 - 0.5
      const c0 = Math.max(0, Math.min(W - 2, Math.floor(x)))
      const r0 = Math.max(0, Math.min(th * 256 - 2, Math.floor(y)))
      const fx = x - c0, fy = y - r0
      const v = (rr: number, cc: number) => mosaic[rr * W + cc]!
      out[r * f.width + c] =
        v(r0, c0) * (1 - fx) * (1 - fy) + v(r0, c0 + 1) * fx * (1 - fy) + v(r0 + 1, c0) * (1 - fx) * fy + v(r0 + 1, c0 + 1) * fx * fy
    }
  return out
}

/** USGS 3DEP first (LiDAR-derived where flown), AWS Terrain Tiles if 3DEP fails twice. */
export async function loadDem(sw: LngLat, ne: LngLat, cellM = 3): Promise<DemResult> {
  const f = frame(sw, ne, cellM)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await from3dep(f)
      return { grid: { ...f, data }, source: `USGS 3DEP, ${(f.px * f.scale).toFixed(1)} m cells` }
    } catch (e) {
      console.warn('3DEP attempt failed', e)
    }
  }
  const data = await fromTerrarium(f)
  return { grid: { ...f, data }, source: `AWS Terrain Tiles (3DEP was unavailable), resampled to ${(f.px * f.scale).toFixed(1)} m` }
}
