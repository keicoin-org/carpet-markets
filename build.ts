/**
 * Builds the deployable copy: `dist/examples/carpet-markets/`.
 *
 * Next exports into `out/`, flat, with every URL already prefixed by the
 * `basePath` in `next.config.mjs`. Cloudflare serves `dist/` at the site root,
 * so the export is moved to the directory that matches those URLs — the
 * directory shape has to equal the URL shape or every asset is a 404 that looks
 * like a bug in the game.
 *
 * `bun run dev` uses none of this. It runs `next dev`, which serves from source.
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const root = Bun.fileURLToPath(new URL('.', import.meta.url))
const out = join(root, 'dist', 'examples', 'carpet-markets')

const next = Bun.spawnSync({
  cmd: ['bunx', 'next', 'build'],
  cwd: root,
  env: { ...process.env, NEXT_EXPORT: '1' },
  stdout: 'inherit',
  stderr: 'inherit',
})
if (next.exitCode !== 0) process.exit(next.exitCode ?? 1)

await mkdir(out, { recursive: true })
for (const entry of await readdir(out)) {
  await rm(join(out, entry), { recursive: true, force: true }).catch(() => undefined)
}

await cp(join(root, 'out'), out, { recursive: true })

// The page asks for ./favicon.ico, which at /examples/carpet-markets/ is this
// one and not the site's — same coin, served by whichever Worker owns the path.
await cp(join(root, 'public'), out, { recursive: true })

const weight = await directorySize(out)
console.log(`\n  dist/examples/carpet-markets — ${(weight / 1024 / 1024).toFixed(2)} MB\n`)

async function directorySize(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    total += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size
  }
  return total
}
