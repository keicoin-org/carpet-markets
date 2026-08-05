/**
 * `bun run walk` — the three acceptance criteria that need a real browser.
 *
 * SPEC §9.6 says each criterion is checkable in one step from a clean clone by
 * somebody who has not read the document. Six of the nine are checkable by
 * `bun run check`, because they are claims about a sentence or a ledger fact.
 * Three are not:
 *
 *   1  a first-time visitor completes one buy in five interactions or fewer
 *   5  no horizontal scroll at 360 px, and the primary action reachable
 *   6  launch, sell, buy and cancel completable by keyboard alone
 *
 * All three are claims about layout, focus and a click count, and none of them
 * survives being asserted in happy-dom: there is no layout engine there, so
 * `scrollWidth` is a fiction and a focus ring is a class name nobody drew. They
 * were once reported closed on a browser walk that was never committed, which
 * means nobody could re-run it — so this file is the walk, and its output is the
 * only evidence for those three that is worth anything.
 *
 * It starts the chain and the registry, seeds the board out of ordinary blocks,
 * starts the client, and drives Chrome over CDP. Nothing is stubbed: the wallet
 * is generated in the browser on first visit, the faucet is the demo's faucet,
 * and every block is signed by a key this script never sees.
 *
 *   bun run walk
 *   bun run walk --headed          # watch it
 *   bun run walk --api 7799 --client 3099
 *
 * Chrome is the one thing it does not install. `puppeteer-core` drives whichever
 * browser is already on the machine; set CHROME_PATH if it is somewhere unusual.
 */

import { existsSync } from 'node:fs'
import { platform } from 'node:process'
import { Kei, randomSeed } from 'kei-transaction'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

import { resolveSpawn } from '../spawn.js'
import type { LaunchQuote, MarketFacts } from '../shared/listing.js'

const root = Bun.fileURLToPath(new URL('..', import.meta.url))

const argv = Bun.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}

const API_PORT = Number(flag('api') ?? 7799)
const CLIENT_PORT = Number(flag('client') ?? 3099)
const HEADED = argv.includes('--headed')

const API = `http://127.0.0.1:${API_PORT}`
const SITE = `http://127.0.0.1:${CLIENT_PORT}`

/** A visitor arrives with what the demo's own faucet hands a new wallet. */
const FAUCET_KEI = 25

/** SPEC §9.6, criterion 1. Five, not "about five". */
const BUDGET = 5

const VIEWPORT = { width: 360, height: 800 }

// --------------------------------------------------------------- the processes

const children: number[] = []

/**
 * A background process, with its own output thrown away.
 *
 * Piped and unread is the one thing that cannot be done here: the mock node
 * writes a line per RPC and the seed makes hundreds, so a pipe nobody drains
 * fills and the chain stops answering halfway through the walk. Errors still go
 * to this process's stderr, which is where somebody debugging is looking.
 */
function start(cmd: string[], env: Record<string, string> = {}): void {
  const child = Bun.spawn({
    cmd: resolveSpawn(cmd),
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'inherit',
  })
  children.push(child.pid)
}

/**
 * Stop them, and their children.
 *
 * `bunx next dev` is a launcher that spawns the real server, and killing the
 * launcher on Windows leaves that server holding the port — so the next run of
 * this script finds :3099 occupied by the last one.
 */
function stopAll(): void {
  for (const pid of children) {
    try {
      if (platform === 'win32') Bun.spawnSync({ cmd: ['taskkill', '/PID', String(pid), '/T', '/F'], stdout: 'ignore', stderr: 'ignore' })
      else process.kill(-pid, 'SIGTERM')
    } catch {
      // Already gone, which is the outcome this wanted.
    }
  }
}

async function waits(what: string, url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    const answered = await fetch(url).then(
      (response) => response.ok,
      () => false,
    )
    if (answered) return
    if (Date.now() > deadline) throw new Error(`${what} never answered on ${url} within ${ms / 1000}s.`)
    await Bun.sleep(400)
  }
}

async function run(name: string, cmd: string[], env: Record<string, string> = {}): Promise<void> {
  const child = Bun.spawn({ cmd: resolveSpawn(cmd), cwd: root, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const code = await child.exited
  if (code !== 0) {
    throw new Error(`${name} exited ${code}: ${await new Response(child.stderr).text()}`)
  }
}

// -------------------------------------------------------------------- the board

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const answer = (await response.json()) as { error?: string } & T
  if (!response.ok) throw new Error(answer.error ?? `${path} answered ${response.status}`)
  return answer
}

/**
 * One more coin, listed in lots a fresh wallet can take, several times.
 *
 * The seeded board has exactly one lot a 25 Kei faucet grant covers, and the
 * three passes below would eat it and then each other. This is an ordinary
 * wallet paying an ordinary launch fee and writing ordinary `swap_offer` blocks
 * — the registry cannot tell it from a visitor — and it exists so the click
 * count and the keyboard loop are measuring the interface rather than racing for
 * the last affordable offer on the board.
 *
 * It is launched last, so it is the newest coin and therefore the first card
 * under the board's own "buyable now" filter. That is what makes the walk's
 * route deterministic rather than dependent on which second each coin landed in.
 */
async function stock(): Promise<string> {
  const seller = await Kei.server({ seed: randomSeed(), node: `${API}/rpc`, network: 'mock' })
  try {
    await seller.faucet(60)
    await seller.sync()
    await api('/market/watch', { address: seller.address })

    const quote = await api<LaunchQuote>('/market/launch', {
      address: seller.address,
      symbol: 'WALKED',
      name: 'Walked',
      blurb: 'Listed in small lots, so a wallet with a faucet grant can take one.',
      transfer: 'open',
    })
    await seller.pay({ to: quote.to, amount: quote.fee })

    const deadline = Date.now() + 20_000
    let asset: string | undefined
    while (!asset) {
      const facts = await api<MarketFacts>('/market/facts')
      asset = facts.listings.find((listing) => listing.symbol === 'WALKED')?.asset
      if (!asset && Date.now() > deadline) throw new Error('WALKED never appeared on the board.')
      if (!asset) await Bun.sleep(250)
    }

    await seller.sync()
    for (let lot = 0; lot < 4; lot += 1) {
      await seller.market.sell({ asset, amount: 1_000, price: 1 })
    }
    return asset
  } finally {
    seller.close()
  }
}

// ------------------------------------------------------------------ the browser

/**
 * Whichever Chrome is already here.
 *
 * `puppeteer-core` downloads nothing, which is the point: a walk that pulls a
 * hundred megabytes of browser on install is not a check anybody runs, and the
 * machines this has to run on — a laptop and a GitHub runner — both already have
 * one.
 */
function chrome(): string {
  const named = process.env.CHROME_PATH
  if (named) {
    if (!existsSync(named)) throw new Error(`CHROME_PATH points at ${named}, which does not exist.`)
    return named
  }

  const candidates =
    platform === 'win32'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        ]
      : platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
          ]

  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    throw new Error(
      `No Chrome found. Install one, or point CHROME_PATH at it. Looked at:\n    ${candidates.join('\n    ')}`,
    )
  }
  return found
}

interface Focused {
  tag: string
  /** What a screen reader would read out, as far as this page's four mechanisms go. */
  text: string
  /** Whether something with a size actually has a ring drawn on it. */
  ring: boolean
}

/**
 * The focused element, and whether a ring is drawn on something visible.
 *
 * The ring is looked for on the element and on a wrapping `<label>`, because the
 * launch screen's policy radios are `sr-only` inputs — a 1px clipped box with a
 * perfectly real outline nobody can see. The label is what carries the ring
 * there, and a check that only read the input would pass on an invisible one.
 */
async function focused(page: Page): Promise<Focused | null> {
  return page.evaluate(() => {
    const node = document.activeElement
    if (!node || node === document.body || node === document.documentElement) return null
    const drawn = (candidate: Element | null): boolean => {
      if (!candidate) return false
      const style = getComputedStyle(candidate)
      const box = candidate.getBoundingClientRect()
      return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0 && box.width > 2 && box.height > 2
    }
    // The accessible name, as far as the four mechanisms this app uses. A field
    // reached by Tab has no text content of its own, so reading `textContent`
    // and falling back to the placeholder would have the walk navigating by
    // example values — "WAGMI" rather than "Symbol".
    const named = (candidate: Element): string => {
      const label = candidate.getAttribute('aria-label')
      if (label) return label
      const by = candidate.getAttribute('aria-labelledby')
      if (by) {
        const parts = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .filter(Boolean)
        if (parts.length > 0) return parts.join(' ')
      }
      const id = candidate.getAttribute('id')
      const associated = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null
      if (associated) return associated.textContent ?? ''
      const wrapping = candidate.closest('label')
      if (wrapping) return wrapping.textContent ?? ''
      return candidate.textContent ?? ''
    }
    const text = named(node).replace(/\s+/g, ' ').trim().slice(0, 90)
    return { tag: node.tagName.toLowerCase(), text, ring: drawn(node) || drawn(node.closest('label')) }
  })
}

/** Tab until something whose name contains `want` has the focus. */
async function tabTo(page: Page, want: string, limit = 140): Promise<Focused> {
  const trail: string[] = []
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab')
    const here = await focused(page)
    if (!here) continue
    trail.push(`${here.tag}: ${here.text}`)
    if (here.text.toLowerCase().includes(want.toLowerCase())) return here
  }
  throw new Error(`Tabbed ${limit} times without reaching "${want}". Passed:\n    ${trail.join('\n    ')}`)
}

/** Type into whatever has the focus, as a keyboard would. */
async function typed(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 8 })
}

/** Click one element chosen by a selector and, optionally, its own text. */
async function click(page: Page, selector: string, wanted?: string): Promise<string> {
  for (const handle of await page.$$(selector)) {
    const named = await handle.evaluate((node) => ({
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      label: node.getAttribute('aria-label') ?? '',
    }))
    if (wanted && named.text !== wanted) continue
    await handle.click()
    return (named.label || named.text).slice(0, 90)
  }
  throw new Error(`Nothing matched ${selector}${wanted ? ` with the text "${wanted}"` : ''}.`)
}

/** The transaction tray, which is where a refused signature says so. */
const tray = (page: Page): Promise<string> =>
  page
    .evaluate(() =>
      (document.querySelector('[aria-label="Recent actions"]')?.textContent ?? 'nothing').replace(/\s+/g, ' ').trim(),
    )
    .catch(() => 'unreadable')

const text = (page: Page): Promise<string> =>
  page.evaluate(() => (document.body.innerText ?? '').replace(/\s+/g, ' ').trim())

/**
 * Wait for a sentence to be on screen.
 *
 * Case-insensitive, because half the labels on this page are uppercased in CSS
 * and `innerText` reports what is rendered rather than what the component wrote.
 * Matching the source casing would fail on exactly the chips and eyebrows the
 * walk navigates by.
 */
async function until(page: Page, contains: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  const wanted = contains.toLowerCase()
  for (;;) {
    if ((await text(page)).toLowerCase().includes(wanted)) return
    if (Date.now() > deadline) {
      throw new Error(`"${contains}" never appeared. The page says:\n    ${(await text(page)).slice(0, 600)}`)
    }
    await Bun.sleep(200)
  }
}

/**
 * Wait for the funnel's own current step.
 *
 * Not `until`, because the step indicator lists all five labels at all times —
 * "pick a quote" is on screen while the funnel is still on step one. The claim
 * being waited for is which one carries `aria-current`, which is also the claim
 * a screen reader hears.
 */
async function untilStep(page: Page, label: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  const wanted = label.toLowerCase()
  for (;;) {
    const now = await page.evaluate(() =>
      (document.querySelector('li[aria-current="step"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    )
    if (now.toLowerCase().includes(wanted)) return
    if (Date.now() > deadline) throw new Error(`The funnel never reached "${label}". It is at "${now}".`)
    await Bun.sleep(200)
  }
}

// -------------------------------------------------------------------- the report

interface Check {
  criterion: number
  claim: string
  lines: string[]
  ok: boolean
}

const checks: Check[] = []

function record(criterion: number, claim: string, lines: string[], ok: boolean): void {
  checks.push({ criterion, claim, lines, ok })
}

// ------------------------------------------------------------------- criterion 1

/**
 * A first-time visitor, a fresh wallet, and a count of the clicks.
 *
 * The route is the one the board itself signposts: narrow to what somebody is
 * actually selling, open a coin, take a row, confirm the terms. The confirmation
 * is a fourth interaction the demo did not used to have, and it is here on
 * purpose — issue #14 asks for the terms and the in-flight step to be states
 * rather than moments, and the budget is five.
 *
 * What it cannot do is choose a coin a 25 Kei wallet can afford, because the
 * card prints a per-unit ask and the book sells lots. If the first buyable coin
 * on the board is priced out of a fresh wallet, the walk fails and prints the
 * refusal — that is a true statement about the demo rather than a flaky test.
 */
async function firstBuy(browser: Browser): Promise<void> {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  const lines: string[] = []
  let clicks = 0

  try {
    await page.goto(`${SITE}/`, { waitUntil: 'networkidle2', timeout: 90_000 })
    await until(page, 'Buyable now')
    lines.push(`arrived at ${SITE}/ with a wallet this browser generated`)

    const balance = await page.evaluate(() => {
      const bar = document.querySelector('header')
      return (bar?.textContent ?? '').replace(/\s+/g, ' ').trim()
    })
    lines.push(`the bar reads: ${balance}`)

    clicks += 1
    lines.push(`${clicks}. ${await click(page, '[data-chip="buyable"]')}`)

    clicks += 1
    const card = await click(page, 'article a[href*="/coin"]')
    lines.push(`${clicks}. opened ${card.split('—')[0]?.trim()}`)
    await untilStep(page, 'pick a quote')

    // Record every step the funnel announces, in order, from here on. The
    // settling step can be brief and must still be provably on screen.
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { steps: string[] }).steps = seen
      const read = (): void => {
        const node = document.querySelector('li[aria-current="step"]')
        const label = (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (label && seen[seen.length - 1] !== label) seen.push(label)
      }
      read()
      new MutationObserver(read).observe(document.body, { subtree: true, childList: true, attributes: true })
    })

    const row = await page.evaluate(() => {
      const button = [...document.querySelectorAll('tbody button')].find(
        (node) => node.getAttribute('aria-disabled') !== 'true',
      )
      return button?.getAttribute('aria-label') ?? null
    })
    if (!row) {
      const refusal = await page.evaluate(
        () => document.querySelector('tbody button')?.getAttribute('aria-label') ?? 'no rows at all',
      )
      throw new Error(`Nothing on the first buyable coin can be taken by a ${FAUCET_KEI} Kei wallet — ${refusal}`)
    }

    clicks += 1
    lines.push(`${clicks}. ${row}`)
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('tbody button')].find(
        (node) => node.getAttribute('aria-disabled') !== 'true',
      ) as HTMLElement | undefined
      button?.click()
    })
    await until(page, 'Take this offer?')

    const terms = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('h3')].find((node) => node.textContent?.includes('Take this offer'))
      return (panel?.parentElement?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    })
    lines.push(`   terms on screen: ${terms}`)

    clicks += 1
    lines.push(`${clicks}. ${await click(page, 'button', 'Confirm the buy')}`)

    await untilStep(page, 'settled', 60_000)
    const steps = await page.evaluate(() => (window as unknown as { steps: string[] }).steps)
    lines.push(`   steps announced: ${steps.join(' → ')}`)

    const done = await page.evaluate(
      () => (document.querySelector('[role="status"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    )
    lines.push(`   ${done.slice(0, 180)}`)
    lines.push(`   ${clicks} interactions, budget ${BUDGET}`)

    const ordered =
      steps.join('|') === ['2. pick a quote', '3. confirm the terms', '4. settling', '5. settled'].join('|')
    if (!ordered) throw new Error(`The funnel did not announce its steps in order: ${steps.join(' → ')}`)

    record(1, `a first buy in ${clicks} interactions, with every funnel step announced in order`, lines, clicks <= BUDGET)
  } catch (error) {
    lines.push(`   failed: ${error instanceof Error ? error.message : String(error)}`)
    record(1, 'a first buy within five interactions', lines, false)
  } finally {
    await page.close()
  }
}

// ------------------------------------------------------------------- criterion 5

/**
 * 360 px, on every screen, with the primary action inside it.
 *
 * Two separate claims and both are measured. The page must not scroll sideways,
 * and the one control the screen exists for must be within the viewport without
 * scrolling to it — a page that fits because its button is off the right edge
 * passes the first half and fails the criterion.
 */
async function narrow(browser: Browser, coin: string): Promise<void> {
  const screens: { path: string; name: string; action: string }[] = [
    { path: '/', name: 'the board', action: 'article a[href*="/coin"]' },
    { path: `/coin?asset=${encodeURIComponent(coin)}`, name: 'a coin', action: 'tbody button, [role="tab"]' },
    { path: '/launch', name: 'launch', action: 'button.btn-gold' },
    { path: '/network', name: 'network', action: 'a[href*="/"]' },
  ]

  const lines: string[] = []
  let ok = true

  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  try {
    for (const screen of screens) {
      await page.goto(`${SITE}${screen.path}`, { waitUntil: 'networkidle2', timeout: 90_000 })
      await Bun.sleep(1_500)

      const measured = await page.evaluate((selector: string) => {
        const doc = document.documentElement
        const overflow = doc.scrollWidth - doc.clientWidth
        const wide = [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((node) => node.getBoundingClientRect().right > doc.clientWidth + 1)
          .slice(0, 3)
          .map((node) => `${node.tagName.toLowerCase()}.${node.className.toString().split(/\s+/)[0] ?? ''}`)
        const action = document.querySelector(selector)
        const box = action?.getBoundingClientRect() ?? null
        return {
          width: doc.clientWidth,
          scrollWidth: doc.scrollWidth,
          overflow,
          wide,
          action: box ? { left: Math.round(box.left), right: Math.round(box.right) } : null,
        }
      }, screen.action)

      const fits = measured.overflow <= 0
      const reachable =
        measured.action !== null && measured.action.left >= 0 && measured.action.right <= measured.width
      if (!fits || !reachable) ok = false

      lines.push(
        `${screen.name.padEnd(10)} scrollWidth ${measured.scrollWidth} vs ${measured.width} — ${
          fits ? 'no horizontal scroll' : `overflows by ${measured.overflow}px (${measured.wide.join(', ')})`
        }; primary action ${
          measured.action ? `at ${measured.action.left}–${measured.action.right}px` : 'not found'
        } ${reachable ? '(inside)' : '(NOT reachable)'}`,
      )
    }
  } finally {
    await page.close()
  }

  record(5, 'no horizontal scroll at 360 px, primary action inside the viewport', lines, ok)
}

// ------------------------------------------------------------------- criterion 6

/**
 * Launch, sell, buy, cancel — with the keyboard and nothing else.
 *
 * Every move here is Tab, an arrow, Enter or a character. The mouse is never
 * used, and the focus ring is read off the computed style at every stop rather
 * than assumed from a class name, because a ring that is styled and clipped is
 * the failure this criterion is actually about.
 */
async function byKeyboard(browser: Browser, coin: string): Promise<void> {
  const lines: string[] = []
  let ok = true
  const page = await browser.newPage()
  await page.setViewport({ width: 1_280, height: 900 })

  const at = (where: Focused, what: string): void => {
    if (!where.ring) ok = false
    lines.push(`${what.padEnd(22)} ${where.tag} "${where.text}" — focus ring ${where.ring ? 'drawn' : 'MISSING'}`)
  }

  try {
    // ---- launch
    await page.goto(`${SITE}/`, { waitUntil: 'networkidle2', timeout: 90_000 })
    await until(page, 'Buyable now')
    at(await tabTo(page, 'Launch a coin'), 'launch link')
    await page.keyboard.press('Enter')
    await until(page, 'Who may move it')

    const symbol = `W${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    at(await tabTo(page, 'Symbol'), 'symbol field')
    await typed(page, symbol)
    at(await tabTo(page, 'Name'), 'name field')
    await typed(page, 'Walked in by keyboard')

    // The policy radios are one tab stop and the arrows move the choice, which
    // is the whole reason they are radios rather than three toggles.
    at(await tabTo(page, 'Open'), 'policy radio')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    const policy = await page.evaluate(
      () => (document.querySelector('input[name="transfer"]:checked') as HTMLInputElement | null)?.value ?? null,
    )
    lines.push(`arrow keys moved the policy and came back to "${policy}"`)
    if (policy !== 'open') ok = false

    at(await tabTo(page, 'Pay the fee and launch'), 'launch button')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => location.pathname.includes('/coin'), { timeout: 90_000 })
    await untilStep(page, 'nothing for sale')
    lines.push(`launched ${symbol} and landed on its coin page`)

    // ---- sell
    // The selected tab is the strip's only tab stop, which is the ARIA pattern
    // and the reason this arrives on Buy and arrows across rather than tabbing
    // to Sell directly.
    at(await tabTo(page, 'Buy —'), 'the tab strip')
    await page.keyboard.press('ArrowRight')
    await until(page, 'Lock them into an offer')
    at(await tabTo(page, 'Amount'), 'amount field')
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await typed(page, '5000')
    at(await tabTo(page, 'Price each'), 'price field')
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await typed(page, '0.0001')
    at(await tabTo(page, 'Lock them into an offer'), 'sell button')
    await page.keyboard.press('Enter')
    await Bun.sleep(3_000)
    // Read before the wait, not after it. A failed record leaves the tray after
    // thirty seconds (`lib/tx.ts`), so a timeout that dumps the tray at sixty
    // prints an empty one and the reason with it.
    lines.push(`the tray after the sell: ${(await tray(page)).slice(0, 220)}`)
    await until(page, 'Your open orders', 20_000)
    lines.push(`wrote an ask for 5,000 ${symbol} and it is in "Your open orders"`)

    // ---- buy, on a coin somebody else is selling
    await page.goto(`${SITE}/coin?asset=${encodeURIComponent(coin)}`, { waitUntil: 'networkidle2', timeout: 90_000 })
    await untilStep(page, 'pick a quote')
    at(await tabTo(page, 'Buy 1,000'), 'a row of the book')
    await page.keyboard.press('Enter')
    await until(page, 'Take this offer?')
    const confirm = await focused(page)
    if (!confirm) throw new Error('Choosing a row left the focus nowhere.')
    at(confirm, 'confirmation')
    await page.keyboard.press('Enter')
    await untilStep(page, 'settled', 60_000)
    lines.push('confirmed the buy with Enter and it settled')

    // ---- cancel
    await page.goto(`${SITE}/coin?asset=${await assetOf(symbol)}`, { waitUntil: 'networkidle2', timeout: 90_000 })
    await until(page, 'Your open orders')
    at(await tabTo(page, 'Cancel your offer'), 'cancel button')
    await page.keyboard.press('Enter')
    await Bun.sleep(4_000)
    const gone = !(await text(page)).toLowerCase().includes('your open orders')
    lines.push(`cancelled it with Enter — the order list is ${gone ? 'gone' : 'STILL THERE'}`)
    if (!gone) ok = false
  } catch (error) {
    lines.push(`failed: ${error instanceof Error ? error.message : String(error)}`)
    lines.push(`the tray says: ${(await tray(page)).slice(0, 400)}`)
    ok = false
  } finally {
    await page.close()
  }

  record(6, 'launch, sell, buy and cancel by keyboard, with a visible ring at every step', lines, ok)
}

async function assetOf(symbol: string): Promise<string> {
  const facts = (await fetch(`${API}/market/facts`).then((response) => response.json())) as MarketFacts
  const found = facts.listings.find((listing) => listing.symbol === symbol)
  if (!found) throw new Error(`${symbol} is not on the board.`)
  return found.asset
}

// ------------------------------------------------------------------------- main

console.log(`\n  Carpet Markets — walking SPEC §9.6 criteria 1, 5 and 6 in a browser.\n`)

let browser: Browser | undefined
try {
  const path = chrome()
  console.log(`  chrome     ${path}`)

  start(['bun', 'run', 'server/main.ts'], { PORT: String(API_PORT) })
  await waits('The chain and registry', `${API}/market/facts`, 60_000)
  console.log(`  api        ${API}`)

  await run('The seed', ['bun', 'run', 'scripts/seed.ts', '--api', API])

  start(['bunx', 'next', 'dev', '--port', String(CLIENT_PORT), '--hostname', '127.0.0.1'], { CARPET_API: API })
  await waits('The client', `${SITE}/`, 180_000)
  console.log(`  client     ${SITE}\n`)

  const coin = await stock()
  console.log(`  board      six seeded coins, plus WALKED in four takeable lots\n`)

  browser = await puppeteer.launch({
    executablePath: path,
    headless: !HEADED,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  })

  await firstBuy(browser)
  await narrow(browser, coin)
  await byKeyboard(browser, coin)
} catch (error) {
  record(0, 'the walk itself', [error instanceof Error ? (error.stack ?? error.message) : String(error)], false)
} finally {
  await browser?.close().catch(() => undefined)
  stopAll()
}

console.log('')
for (const check of checks) {
  console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  criterion ${check.criterion} — ${check.claim}`)
  for (const line of check.lines) console.log(`        ${line}`)
  console.log('')
}

const failed = checks.filter((check) => !check.ok)
console.log(
  `  ${checks.length - failed.length} of ${checks.length} checked criteria hold.${
    failed.length ? ` Unmet: ${failed.map((check) => check.criterion).join(', ')}.` : ''
  }\n`,
)

process.exit(failed.length === 0 ? 0 : 1)
