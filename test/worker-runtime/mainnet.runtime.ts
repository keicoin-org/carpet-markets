import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'

import type { Floor } from '../../worker/index.js'
import { call } from './helpers.js'

test('mainnet is refused before the configured FLOOR writes any durable state', async () => {
  expect(env.CARPET_NETWORK).toBe('mainnet')
  const stub = env.FLOOR.get(env.FLOOR.idFromName('carpet-markets'))

  const response = await call(stub, '/market/facts')
  expect(response.status).toBe(503)
  expect((await response.json<{ error: string }>()).error).toMatch(/refuses to run against mainnet/i)

  await runInDurableObject<Floor, void>(stub, async (_instance, state) => {
    expect(await state.storage.list()).toEqual(new Map())
  })
})
