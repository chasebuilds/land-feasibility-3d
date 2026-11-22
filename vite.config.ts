import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: '/land-feasibility-3d/',
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1600 },
  test: { include: ['src/**/*.test.ts'] },
})
