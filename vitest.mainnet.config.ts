import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { CARPET_NETWORK: 'mainnet' },
        serviceBindings: {
          ASSETS: () => new Response('The asset binding is outside this runtime proof.', { status: 501 }),
        },
      },
    }),
  ],
  test: {
    include: ['test/worker-runtime/mainnet.runtime.ts'],
    testTimeout: 30_000,
  },
})
