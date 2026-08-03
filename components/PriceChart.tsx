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

export function PriceChart({ trades }: { trades: readonly Trade[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

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

      const points = trades.map((trade) => trade.price)
      const first = points[0]
      if (first === undefined) return
      if (points.length === 1) points.push(first)

      const top = Math.max(...points)
      const bottom = Math.min(...points)
      const padding = 10
      const stepX = width / (points.length - 1 || 1)

      // Every trade at the same price is a real flat line, and it is drawn down
      // the middle rather than along the floor. Scaling a zero range puts it at
      // whichever edge the arithmetic falls out on, which reads as a chart that
      // failed to load rather than as a price that has not moved.
      const flat = top === bottom
      const span = top - bottom
      const y = (value: number): number =>
        flat ? height / 2 : height - padding - ((value - bottom) / span) * (height - padding * 2)

      const last = points[points.length - 1] ?? first
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
      context.arc((points.length - 1) * stepX - 1.5, y(last), 2.75, 0, Math.PI * 2)
      context.fill()
    }

    draw()
    const observer = new ResizeObserver(draw)
    if (canvas.parentElement) observer.observe(canvas.parentElement)
    return () => observer.disconnect()
  }, [trades])

  const last = trades[trades.length - 1]
  const first = trades[0]

  return (
    <div className="relative h-44 w-full overflow-hidden rounded-md border border-line bg-floor">
      <canvas ref={canvasRef} className="block h-44 w-full" />
      {trades.length === 0 && (
        <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-fainter">
          Never traded. There is nothing to plot until two people agree on a number.
        </p>
      )}
      {last && first && (
        <div className="pointer-events-none absolute left-2.5 top-2 font-mono text-[10px] text-fainter tabular">
          {formatPrice(first.price)} → {formatPrice(last.price)} Kei
        </div>
      )}
    </div>
  )
}
