import { classifyAll, colorize, slopePercent } from './lib/slope'

export interface SlopeRequest {
  width: number
  height: number
  data: Float32Array
  cell: number
}

export interface SlopeReply {
  slope: Float32Array
  classes: Uint8Array
  rgba: Uint8ClampedArray
}

self.onmessage = (e: MessageEvent<SlopeRequest>) => {
  const { width, height, data, cell } = e.data
  const slope = slopePercent({ width, height, data }, cell)
  const classes = classifyAll(slope)
  const rgba = colorize(classes)
  const reply: SlopeReply = { slope, classes, rgba }
  ;(self as unknown as Worker).postMessage(reply, [slope.buffer, classes.buffer, rgba.buffer])
}
