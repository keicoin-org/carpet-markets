'use client'

/**
 * What it has actually traded for, against time.
 *
 * Every point is a settled `swap_accept` — two people who agreed on a number.
 * There is no model here and nothing is interpolated, which is why a coin with
 * one trade draws one flat line and a coin with none draws nothing at all. A
 * price nobody has paid is not a price.
 *
 * It is a canvas rather than one of the charting libraries a launchpad usually
 * ships, because those want a datafeed with candles and this has a list of
 * agreements. Bucketing eleven trades into OHLC to satisfy an API would be
 * inventing three numbers out of one.
 */

import { useEffect, useRef } from 'react'
import type { Trade } from 'kei-transaction'

import { formatPrice } from '../shared/format'
import { unitPrice } from '../shared/listing'

export function PriceChart({ trades, asset }: { trades: readonly Trade[]; asset: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Kei per unit, both directions. A trade that settled a *bid* has its legs the
  // other way up, so `trade.price` on it is units per Kei — plotted raw, one
  // filled bid puts a spike of several thousand into a chart of fractions and
  // flattens every real price to the floor.
  const points = trades.map((trade) => unitPrice(trade, asset))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = (): void => {
      const context = canvas.getContext('2d')
      const parent = canvas.parentElement
      if (!context || !parent) return

      // Backing store in device pixels, drawing in CSS pixels. Without this the
      // line is soft on every laptop made in the last decade.
      const ratio = window.devicePixelRatio || 1
      const width = parent.clientWidth
      const height = canvas.clientHeight
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)

      const plotted = [...points]
      const first = plotted[0]
      if (first === undefined) return
      if (plotted.length === 1) plotted.push(first)

      const top = Math.max(...plotted)
      const bottom = Math.min(...plotted)
      const padding = 10
      const stepX = width / (plotted.length - 1 || 1)

      // Every trade at the same price is a real flat line, and it is drawn down
      // the middle rather than along the floor. Scaling a zero range puts it at
      // whichever edge the arithmetic falls out on, which reads as a chart that
      // failed to load rather than as a price that has not moved.
      const flat = top === bottom
      const span = top - bottom
      const y = (value: number): number =>
        flat ? height / 2 : height - padding - ((value - bottom) / span) * (height - padding * 2)

      const last = plotted[plotted.length - 1] ?? first
      const line = last < first ? '#ff6b6b' : '#6ee787'

      // A faint rule at the opening price, so "up" and "down" are visible rather
      // than asserted by the colour.
      context.strokeStyle = 'rgba(139,151,163,0.22)'
      context.setLineDash([2, 4])
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(0, y(first))
      context.lineTo(width, y(first))
      context.stroke()
      context.setLineDash([])

      const path = new Path2D()
      plotted.forEach((value, index) => {
        const x = index * stepX
        if (index === 0) path.moveTo(x, y(value))
        else path.lineTo(x, y(value))
      })

      const fill = new Path2D(path)
      fill.lineTo(width, height)
      fill.lineTo(0, height)
      fill.closePath()

      const gradient = context.createLinearGradient(0, 0, 0, height)
      gradient.addColorStop(0, `${line}38`)
      gradient.addColorStop(1, `${line}00`)
      context.fillStyle = gradient
      context.fill(fill)

      context.strokeStyle = line
      context.lineWidth = 1.75
      context.lineJoin = 'round'
      context.stroke(path)

      // The last trade, marked, because it is the number in the header above.
      context.fillStyle = line
      context.beginPath()
      context.arc((plotted.length - 1) * stepX - 1.5, y(last), 2.75, 0, Math.PI * 2)
      context.fill()
    }

    draw()
    const observer = new ResizeObserver(draw)
    if (canvas.parentElement) observer.observe(canvas.parentElement)
    return () => observer.disconnect()
    // `points` rather than `trades`: the array identity changes on every poll,
    // and redrawing the same numbers is cheap but redrawing them sixty times a
    // second while a canvas resizes is not.
  }, [points.join(',')])

  const opened = points[0]
  const closed = points[points.length - 1]
  const high = points.length > 0 ? Math.max(...points) : null
  const low = points.length > 0 ? Math.min(...points) : null
  const rose = opened !== undefined && closed !== undefined && closed >= opened

  return (
    <div className="relative h-52 w-full overflow-hidden rounded-md border border-line bg-floor">
      <canvas ref={canvasRef} className="block h-52 w-full" />

      {trades.length === 0 ? (
        <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-fainter">
          Never traded. There is nothing to plot until two people agree on a number.
        </p>
      ) : (
        <>
          {/* The scale, in the corners rather than on an axis. Four points of
              history do not earn gridlines, and drawing them would imply a
              continuous series where there is a list of agreements. */}
          <div className="pointer-events-none absolute left-2.5 top-2 flex items-baseline gap-2 font-mono text-[10px] tabular">
            <span className="text-fainter">
              {trades.length} settled swap{trades.length === 1 ? '' : 's'}
            </span>
            <span className={rose ? 'text-up' : 'text-down'}>
              {formatPrice(opened!)} → {formatPrice(closed!)} Kei
            </span>
          </div>
          {high !== null && low !== null && high !== low && (
            <>
              <span className="pointer-events-none absolute right-2.5 top-2 font-mono text-[10px] text-fainter tabular">
                high {formatPrice(high)}
              </span>
              <span className="pointer-events-none absolute bottom-2 right-2.5 font-mono text-[10px] text-fainter tabular">
                low {formatPrice(low)}
              </span>
            </>
          )}
        </>
      )}
    </div>
  )
}
