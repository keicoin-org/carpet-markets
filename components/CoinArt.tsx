/**
 * A coin's picture, woven rather than uploaded.
 *
 * pump.fun-shaped launchpads get their density from an image per coin, which
 * means an upload, which means somewhere to put it — Pinata, IPFS, a bucket, a
 * moderation problem, and a second backend this example does not have and is not
 * about. So the art is derived instead: the asset id is the seed, and the same
 * coin draws the same rug on every machine forever without anything being
 * stored anywhere.
 *
 * It is a kilim because the site is called Carpet Markets, and because a
 * mirrored motif reads as *woven* at 64 pixels where a random-squares identicon
 * reads as noise. The palette is dusty and deliberately unsaturated so that a
 * wall of these never competes with the two colours on this page that carry
 * meaning: the gold on the action, and the green and red on direction.
 */

/** FNV-1a. Not cryptographic and does not need to be — this picks colours. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** A deterministic stream from one seed, so every draw is repeatable. */
function stream(seed: number): () => number {
  let state = seed || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

const GRID = 7
/** Half the grid plus the centre column; the rest is a mirror. */
const HALF = Math.ceil(GRID / 2)

export function CoinArt({ asset, symbol, size = 64 }: { asset: string; symbol: string; size?: number }) {
  const next = stream(seedOf(asset))

  // Dusty and mid-lightness on purpose. Fully saturated wool does not exist and
  // fully saturated pixels next to the gold would be a fight.
  const hue = Math.floor(next() * 360)
  const ground = `hsl(${hue} 24% 16%)`
  const warp = `hsl(${(hue + 28) % 360} 38% 52%)`
  const weft = `hsl(${(hue + 190) % 360} 30% 62%)`
  const edge = `hsl(${(hue + 28) % 360} 30% 34%)`

  const cells: { x: number; y: number; fill: string }[] = []
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < HALF; x++) {
      const roll = next()
      if (roll < 0.42) continue
      const fill = roll < 0.74 ? warp : weft
      cells.push({ x, y, fill })
      // The mirror is what makes it read as a motif rather than as static.
      const mirrored = GRID - 1 - x
      if (mirrored !== x) cells.push({ x: mirrored, y, fill })
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${GRID + 2} ${GRID + 2}`}
      role="img"
      aria-label={`Woven mark for ${symbol}`}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-[3px]"
    >
      <rect width={GRID + 2} height={GRID + 2} fill={ground} />
      {/* The selvedge. Every rug on the board has one, so they read as a set. */}
      <rect x={0.5} y={0.5} width={GRID + 1} height={GRID + 1} fill="none" stroke={edge} strokeWidth={1} />
      {cells.map((cell) => (
        <rect key={`${cell.x}-${cell.y}`} x={cell.x + 1} y={cell.y + 1} width={1} height={1} fill={cell.fill} />
      ))}
    </svg>
  )
}
