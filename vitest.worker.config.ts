import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // The persistence proof only exercises the API/DO path. Replacing the
        // static asset binding keeps the test independent of a prior site build.
        serviceBindings: {
          ASSETS: () => new Response('The asset binding is outside this runtime proof.', { status: 501 }),
        },
      },
    }),
  ],
  test: {
    include: ['test/worker-runtime/floor.runtime.ts'],
    testTimeout: 120_000,
  },
})
