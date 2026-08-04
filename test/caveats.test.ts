/**
 * Criterion 9, as assertions.
 *
 * *Each of the demo's known holes — the account-list-bounded book, one open
 * quote per address, off-chain replies — is stated on the screen where it bites,
 * not only in the README.*
 *
 * Two of those were in the README and on no screen at all. The registry in
 * `shared/caveats.ts` makes the set enumerable; this makes it enforced, by
 * reading the client's own source and failing when a registered hole has no
 * render site. That is a source scan rather than a render, deliberately: the
 * question is "does anywhere show this", which is a question about the whole
 * client, and rendering every screen to answer it would need a chain.
 *
 * The scan is exact — `id="…"` on the `Caveat` component — so a caveat cannot
 * pass by having its text copied somewhere, which is the drift the registry
 * exists to stop.
 */

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { CAVEATS, caveat, type CaveatId } from '../shared/caveats.js'

const ROOTS = ['app', 'components']

function sources(): { path: string; body: string }[] {
  const found: { path: string; body: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry)) found.push({ path, body: readFileSync(path, 'utf8') })
    }
  }
  for (const root of ROOTS) walk(root)
  return found
}

const CLIENT = sources()

/** Where a caveat is rendered, by the one call that renders one. */
function renderSites(id: CaveatId): string[] {
  return CLIENT.filter(
    (file) => file.body.includes(`<Caveat id="${id}"`) || file.body.includes(`caveat('${id}')`),
  ).map((file) => file.path)
}

test('every registered hole is stated on at least one screen', () => {
  const orphans = CAVEATS.filter((hole) => renderSites(hole.id).length === 0).map((hole) => hole.id)
  expect(orphans).toEqual([])
})

test('the three holes the criterion names by name are each on a screen', () => {
  // These are quoted from SPEC §9.6 criterion 9 rather than chosen, so the test
  // fails if one of them is dropped from the registry as well as if it loses its
  // render site.
  for (const id of ['account-list', 'one-quote', 'off-chain-replies'] as const) {
    expect([id, renderSites(id).length > 0]).toEqual([id, true])
  }
})

test('the launch screen carries the two holes that bite only there', () => {
  for (const id of ['one-quote', 'unmatched-payments'] as const) {
    expect([id, renderSites(id)]).toEqual([id, [join('app', 'launch', 'launch-screen.tsx')]])
  }
})

test('every caveat is a complete sentence somebody could act on', () => {
  for (const hole of CAVEATS) {
    expect([hole.id, hole.says.length > 80]).toEqual([hole.id, true])
    expect([hole.id, hole.says.trim().endsWith('.')]).toEqual([hole.id, true])
    expect([hole.id, hole.bites.length > 0]).toEqual([hole.id, true])
  }
})

test('a caveat that cites a spec section cites a real-looking one', () => {
  for (const hole of CAVEATS) {
    if (hole.spec === null) continue
    expect([hole.id, hole.spec]).toEqual([hole.id, expect.stringMatching(/^SPEC §\d+(\.\d+)*$/)])
  }
})

test('caveat ids are unique and asking for an unregistered one fails loudly', () => {
  expect(new Set(CAVEATS.map((hole) => hole.id)).size).toBe(CAVEATS.length)
  expect(() => caveat('mainnet-soon' as CaveatId)).toThrow('No caveat is registered as "mainnet-soon".')
})

/**
 * No caveat claims anything is coming.
 *
 * These are limits, and the one way to make them dishonest is to phrase one as a
 * roadmap — "not yet", "coming", "for now" all turn a settled boundary into a
 * schedule, which is the failure SPEC §9.6 spends a whole subsection refusing.
 */
test('no caveat is phrased as a schedule', () => {
  for (const hole of CAVEATS) {
    expect([hole.id, /\b(not yet|coming soon|for now|in future|planned|roadmap)\b/i.test(hole.says)]).toEqual([
      hole.id,
      false,
    ])
  }
})
