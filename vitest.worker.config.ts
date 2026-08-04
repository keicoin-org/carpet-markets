import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Production deliberately starts in the non-destructive compatibility
        // phase. Runtime tests exercise the later, explicit compaction phase.
        bindings: { CARPET_LOG_MODE: 'compact' },
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
    // The measured replay target is 60 s. This test performs three cold boots
    // plus signed traffic; slower Windows CI needs headroom around the suite.
    testTimeout: 240_000,
  },
})
