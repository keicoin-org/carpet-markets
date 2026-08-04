/**
 * Whether the page can tell "the market is quiet" from "we stopped reading it".
 *
 * Those render identically — every figure holds still — and only one of them is
 * a fact about the market. Before `lib/feed.ts` a failed poll was a
 * `console.warn` and nothing else, so a page whose reads had been failing for a
 * minute looked exactly like a page where nobody had traded for a minute.
 *
 * The clock is passed in, so none of this needs a timer.
 */

import { expect, test } from 'bun:test'

import { fed, FEED_OPENING, feedStatus, starved } from '../lib/feed.js'

const T0 = 1_000_000

test('a page that has never read is opening, not down', () => {
  const status = feedStatus(FEED_OPENING, T0)
  expect(status.level).toBe('opening')
  expect(status.ageMs).toBeNull()
  expect(status.sentence).toMatch(/first time/)
})

test('one good read is live, and says how old it is', () => {
  const status = feedStatus(fed(FEED_OPENING, T0), T0 + 1_500)
  expect(status.level).toBe('live')
  expect(status.ageMs).toBe(1_500)
  expect(status.label).toBe('live')
})

test('a single missed poll is lagging rather than down', () => {
  const state = starved(fed(FEED_OPENING, T0), 'the node timed out')
  const status = feedStatus(state, T0 + 2_500)
  expect(status.level).toBe('lagging')
  expect(status.sentence).toMatch(/did not come back/)
})

test('three failures in a row is down, whatever the age says', () => {
  let state = fed(FEED_OPENING, T0)
  for (let attempt = 0; attempt < 3; attempt += 1) state = starved(state, 'refused')
  const status = feedStatus(state, T0 + 500)
  expect(status.level).toBe('down')
  expect(status.label).toBe('not reading')
  expect(status.sentence).toMatch(/Last error: refused/)
})

test('a stale read is down even with no failures recorded, because a poll that never fires never fails', () => {
  const status = feedStatus(fed(FEED_OPENING, T0), T0 + 60_000)
  expect(status.level).toBe('down')
})

/**
 * The age reported is the age of what is *on screen*.
 *
 * A failed read does not move `lastGoodAt`, because the figures did not change
 * either. Reporting the age of the last attempt would say "a moment ago" about
 * numbers that are a minute old, which is the exact lie this file exists to
 * prevent.
 */
test('a failure does not refresh the age of the figures still being shown', () => {
  const good = fed(FEED_OPENING, T0)
  const bad = starved(good, 'gone')
  expect(bad.lastGoodAt).toBe(T0)
  expect(feedStatus(bad, T0 + 8_000).ageMs).toBe(8_000)
})

test('a good read after failures clears them', () => {
  const state = fed(starved(starved(fed(FEED_OPENING, T0), 'a'), 'b'), T0 + 9_000)
  expect(state.failures).toBe(0)
  expect(state.lastError).toBeNull()
  expect(feedStatus(state, T0 + 9_100).level).toBe('live')
})

test('failing before the first read ever lands is down, and says nothing was read', () => {
  let state = FEED_OPENING
  for (let attempt = 0; attempt < 3; attempt += 1) state = starved(state, 'no route to host')
  const status = feedStatus(state, T0)
  expect(status.level).toBe('down')
  expect(status.sentence).toMatch(/missing rather than zero/)
})

test('every level names itself in two or three words', () => {
  const states = [FEED_OPENING, fed(FEED_OPENING, T0), starved(fed(FEED_OPENING, T0), 'x')]
  for (const state of states) {
    const status = feedStatus(state, T0 + 2_500)
    expect(status.label.split(' ').length).toBeLessThanOrEqual(3)
    expect(status.sentence.endsWith('.')).toBe(true)
  }
})

test('the age never goes negative when a clock jumps backwards', () => {
  expect(feedStatus(fed(FEED_OPENING, T0), T0 - 5_000).ageMs).toBe(0)
})
