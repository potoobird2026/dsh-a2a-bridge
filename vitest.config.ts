import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Layered layout. `live` is env-gated (see tests/live/README.md) and
    // skipped by default because it needs a real remote machine.
    exclude: ['tests/live/**'],
  },
})
