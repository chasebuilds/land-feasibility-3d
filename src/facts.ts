import type { LngLat } from './lib/geo'

export const FEMA_URL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query'
export const NHD_URL = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query'

export interface FloodZone {
  zone: string
  subtype: string | null
  sfha: boolean
}

export async function floodZones(ring: LngLat[]): Promise<FloodZone[]> {
  const q = new URLSearchParams({
    geometry: JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF',
    returnGeometry: 'false',
    f: 'json',
  })
  const res = await fetch(`${FEMA_URL}?${q}`)
  const j = (await res.json()) as { features?: { attributes: Record<string, string | null> }[]; error?: unknown }
  if (!res.ok || j.error || !j.features) throw new Error('FEMA NFHL query failed')
  const seen = new Map<string, FloodZone>()
  for (const f of j.features) {
    const z = { zone: f.attributes.FLD_ZONE ?? '?', subtype: f.attributes.ZONE_SUBTY ?? null, sfha: f.attributes.SFHA_TF === 'T' }
    seen.set(`${z.zone}|${z.subtype}`, z)
  }
  return [...seen.values()]
}

export interface Stream {
  name: string | null
  ftype: number
  coords: LngLat[][]
}

export async function streamsNear(sw: LngLat, ne: LngLat): Promise<Stream[]> {
  const q = new URLSearchParams({
    geometry: [sw[0], sw[1], ne[0], ne[1]].join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'GNIS_NAME,FTYPE',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  })
  const res = await fetch(`${NHD_URL}?${q}`)
  const j = (await res.json()) as {
    features?: { attributes: { gnis_name?: string | null; ftype?: number }; geometry?: { paths: LngLat[][] } }[]
  }
  if (!res.ok || !j.features) throw new Error('USGS NHD query failed')
  return j.features
    .filter((f) => f.geometry)
    .map((f) => ({ name: f.attributes.gnis_name ?? null, ftype: f.attributes.ftype ?? 0, coords: f.geometry!.paths }))
}

export const FTYPE: Record<number, string> = {
  460: 'stream or river',
  558: 'artificial path (river centerline)',
  336: 'canal or ditch',
  428: 'pipeline',
  566: 'coastline',
  334: 'connector',
}
