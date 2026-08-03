/**
 * `bun run dev` — the client and the backend, one command.
 *
 * They are two processes because they are two different things: `next dev` owns
 * the client and its hot reload, and `server/main.ts` owns the mock chain and
 * the registry. Next proxies `/rpc` and `/market/*` back to it (see
 * `next.config.mjs`), so from the browser there is one origin and no CORS.
 *
 * Ctrl-C has to reach both, or the next run finds :7788 still held.
 */

import { resolveSpawn } from './spawn.js'

const root = Bun.fileURLToPath(new URL('.', import.meta.url))

// Both of these are spawned by name, and a name is not a thing Windows can
// start — `spawn.ts` is the whole explanation.
const api = Bun.spawn({
  cmd: resolveSpawn(['bun', 'run', 'server/main.ts']),
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})

const client = Bun.spawn({
  cmd: resolveSpawn(['bunx', 'next', 'dev']),
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})

const stop = (): void => {
  api.kill()
  client.kill()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  stop()
  process.exit(0)
})

// If either half dies the other is useless, so the whole command goes down with
// it rather than leaving a client talking to nothing.
await Promise.race([api.exited, client.exited])
stop()
