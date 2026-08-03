/**
 * Elements and a chart. No framework, because the state here is one object and a
 * poll, and a framework would be the largest thing on the page by an order of
 * magnitude.
 */

import type { Trade } from 'kei-transaction'

import { formatCoins, formatPrice } from '../shared/format.js'
import type { Book, Listing } from '../shared/listing.js'

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

// ------------------------------------------------------------------- the chart

/**
 * What it has actually traded for, against time.
 *
 * Every point is a settled `swap_accept` — two people who agreed on a number.
 * There is no model here and nothing is interpolated, which is why a coin with
 * one trade draws one flat line and a coin with none draws nothing at all. A
 * price a nobody has paid is not a price.
 */
export function chart(canvas: HTMLCanvasElement, trades: readonly Trade[]): void {
  const context = canvas.getContext('2d')
  if (!context) return

  const width = canvas.width
  const height = canvas.height
  context.clearRect(0, 0, width, height)

  const points = trades.map((trade) => trade.price)
  const first = points[0]
  if (first === undefined) return
  if (points.length === 1) points.push(first)

  const top = Math.max(...points)
  const bottom = Math.min(...points)
  const span = top - bottom || top || 1
  const stepX = width / (points.length - 1 || 1)
  const y = (value: number): number => height - 6 - ((value - bottom) / span) * (height - 12)

  const last = points[points.length - 1] ?? first
  const line = last < first ? '#ff5c5c' : '#7ee787'

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
 * It says what the *chain* will permit, not what the site promises. All three
 * are honest and only one of them is safe, and the unsafe one is unsafe in the
 * ordinary way markets are: whoever is holding the most of something can sell
 * it, whenever they like, in whatever size they like, to you.
 */
export function policyBadge(listing: Listing): HTMLElement {
  const [label, kind, title] =
    listing.transfer === 'open'
      ? [
          'OPEN',
          'carpet',
          'transfer: open. Anybody can send this coin to anybody, so a real order book exists — and so does the creator, who was minted the entire supply and can sell it into that book at any pace they choose. Consensus permits that. Nothing here will stop it.',
        ]
      : listing.transfer === 'issuer-only'
        ? [
            'ISSUER ONLY',
            'closed',
            'transfer: issuer-only, immutably, from issuance. Units move only to or from the issuing account, so no offer between two holders is a valid block. There is no player-to-player market for this coin and there cannot be one.',
          ]
        : [
            'SOULBOUND',
            'safe',
            'transfer: none, immutably, from issuance. These units cannot move at all, so they cannot be locked into an offer and cannot be sold. Nobody can dump this on you, including whoever made it.',
          ]

  return el('span', { class: `badge badge-${kind}`, title }, label)
}

/** One line under a coin's name: what it has done, if anything. */
export function summarise(listing: Listing, book: Book | undefined): string {
  const supply = `${formatCoins(listing.supply)} supply`
  if (!book) return supply
  if (!book.price) return `${supply} · never traded`
  return `${supply} · last ${formatPrice(book.price.last)} Kei · ${book.price.trades} trades`
}
