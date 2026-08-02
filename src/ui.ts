/**
 * Elements and a chart. No framework, because the state here is one object and a
 * poll, and a framework would be the largest thing on the page by an order of
 * magnitude.
 */

import { SLOPE_RAW, BASE_RAW, CURVE_SUPPLY, formatCoins, formatKei } from '../shared/curve.js'
import type { Listing, Tick } from '../shared/listing.js'

type Child = Node | string | null | undefined | false
type Attrs = Record<string, string | number | boolean | EventListener | undefined>

/** `el('button.buy', { onclick }, 'Buy')` — tag, classes, attributes, children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split('.')
  const node = document.createElement(tag as K)
  if (classes.length > 0) node.className = classes.join(' ')

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (typeof value === 'function') node.addEventListener(key.replace(/^on/, ''), value as EventListener)
    else if (key === 'value' && node instanceof HTMLInputElement) node.value = String(value)
    else node.setAttribute(key, String(value))
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

// ------------------------------------------------------------------ the numbers

/** A price in Kei, short enough to sit in a table cell. */
export function price(raw: bigint): string {
  const text = formatKei(raw, 12)
  return text.length > 12 ? `${text.slice(0, 12)}…` : text
}

/** How far up the curve a coin is, as a percentage of the supply that can be sold. */
export function progress(sold: bigint): number {
  return Number((sold * 1000n) / CURVE_SUPPLY) / 10
}

/** Price now against the price of the first coin, which is the number people quote. */
export function multiple(sold: bigint): string {
  const now = BASE_RAW + SLOPE_RAW * sold
  const times = Number((now * 100n) / BASE_RAW) / 100
  return times >= 100 ? `${Math.round(times)}×` : `${times.toFixed(1)}×`
}

// ------------------------------------------------------------------- the chart

/**
 * Price against time, drawn from the tick log.
 *
 * Ticks record supply rather than price, because supply is the state and price
 * is a function of it — storing both would let them disagree, and a chart that
 * disagrees with the order book is worse than no chart.
 */
export function chart(canvas: HTMLCanvasElement, history: readonly Tick[], state: Listing['state']): void {
  const context = canvas.getContext('2d')
  if (!context) return

  const width = canvas.width
  const height = canvas.height
  context.clearRect(0, 0, width, height)

  const points = history.map((tick) => Number(BASE_RAW + SLOPE_RAW * BigInt(tick.sold)))
  const first = points[0]
  if (first === undefined) return
  // A single tick is a flat line rather than nothing: a coin that has just been
  // launched has a price, and an empty box would suggest it does not.
  if (points.length === 1) points.push(first)

  const top = Math.max(...points)
  const bottom = Math.min(...points)
  const span = top - bottom || top || 1
  const stepX = width / (points.length - 1 || 1)
  const y = (value: number): number => height - 6 - ((value - bottom) / span) * (height - 12)

  const line = state === 'rugged' ? '#ff5c5c' : state === 'graduated' ? '#7ee787' : '#e3b341'

  const path = new Path2D()
  points.forEach((value, index) => {
    const x = index * stepX
    if (index === 0) path.moveTo(x, y(value))
    else path.lineTo(x, y(value))
  })

  const fill = new Path2D(path)
  fill.lineTo(width, height)
  fill.lineTo(0, height)
  fill.closePath()

  const gradient = context.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, `${line}44`)
  gradient.addColorStop(1, `${line}00`)
  context.fillStyle = gradient
  context.fill(fill)

  context.strokeStyle = line
  context.lineWidth = 2
  context.lineJoin = 'round'
  context.stroke(path)
}

// -------------------------------------------------------------------- the badge

/**
 * The one thing on the page a player has to read before they buy.
 *
 * It says which guarantee it is: the chain's, or the market's. Everything else
 * in this game is a joke about people not reading it.
 */
export function lockBadge(listing: Listing): HTMLElement {
  const carpet = listing.lock === 'carpet'
  return el(
    'span',
    {
      class: `badge ${carpet ? 'badge-carpet' : 'badge-safe'}`,
      title: carpet
        ? 'The deed to this coin is transferable, so whoever holds it can send it back to the market and take the entire reserve. Consensus permits that. Nothing here will stop it.'
        : 'The deed to this coin is soulbound: transfer is set to none, immutably, at issuance. There is no message anybody can sign that moves the reserve out.',
    },
    carpet ? 'CARPET' : 'NAILED DOWN',
  )
}

export function stateBadge(listing: Listing): HTMLElement | null {
  if (listing.state === 'trading') return null
  return el(
    'span',
    { class: `badge badge-${listing.state}` },
    listing.state === 'rugged' ? 'RUGGED' : 'GRADUATED',
  )
}

export function summarise(listing: Listing): string {
  const sold = BigInt(listing.sold)
  return `${formatCoins(sold)} sold · ${formatKei(BigInt(listing.reserve), 4)} Kei in reserve`
}
