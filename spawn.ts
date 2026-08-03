/**
 * Running a command by name, on an operating system that disagrees about what a
 * command is.
 *
 * `Bun.spawn` does not go through a shell, so a bare `bunx` is resolved by
 * libuv's own PATH walk rather than by cmd.exe. That walk does not apply
 * `PATHEXT`, which means it looks for a file called exactly `bunx` — and an npm
 * global install puts one there: a POSIX shell script, sitting beside the
 * `bunx.cmd` that is the part Windows can actually run. libuv finds the script,
 * cannot execute it, and the build dies with `uv_spawn 'bunx' ENOENT` while
 * `bunx next build` typed at the same prompt works perfectly.
 *
 * The fix is to stop asking PATH about the one thing we already hold a path to.
 * `process.execPath` is the Bun binary running this script, and `bunx` is an
 * alias for `bun x`, so every bun-flavoured command here becomes an absolute
 * executable plus an argument list and no lookup happens at all. Anything else
 * is searched across PATH the way the shell would have searched it.
 */

import { statSync } from 'node:fs'

/** Windows' default when `PATHEXT` is somehow unset. Order is the shell's own. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** Extensions Windows cannot hand to CreateProcess without a shell to read them. */
const SCRIPTS = new Set(['.CMD', '.BAT'])

export class CommandNotFound extends Error {}

export interface Lookup {
  /** Defaults to the host. Injectable so the tests can be run anywhere. */
  platform?: string
  env?: Record<string, string | undefined>
  /** The Bun binary to use for `bun` and `bunx`. Defaults to the running one. */
  execPath?: string
  /** Whether a path names a file that exists. Defaults to a real `stat`. */
  isFile?: (path: string) => boolean
}

/**
 * A command as an executable this platform can start, plus its arguments.
 *
 * `bun` and `bunx` never reach the search below, because the answer is already
 * in this process. Everything else is looked up once, here, so that a failure
 * says which command was missing instead of arriving as an errno from libuv.
 */
export function resolveSpawn(cmd: readonly string[], lookup: Lookup = {}): string[] {
  const [name, ...rest] = cmd
  if (!name) throw new CommandNotFound('A command needs a name to run.')

  const bun = lookup.execPath ?? process.execPath
  if (name === 'bun') return [bun, ...rest]
  if (name === 'bunx') return [bun, 'x', ...rest]

  return which(name, lookup, rest)
}

/**
 * Where a command lives, as something startable.
 *
 * The extension order is `PATHEXT`'s, which puts real executables ahead of the
 * shims: on a machine where both `bunx` and `bunx.cmd` exist, taking the bare
 * name first is exactly the bug this file is about. The bare name is tried last
 * and only as a fallback, for the Unix case where it is the whole answer.
 */
function which(name: string, lookup: Lookup, args: readonly string[]): string[] {
  const platform = lookup.platform ?? process.platform
  const env = lookup.env ?? process.env
  const exists = lookup.isFile ?? isFile
  const windows = platform === 'win32'

  const extensions = windows ? [...pathExt(env), ''] : ['']
  const directories = named(name, windows)
    ? ['']
    : (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':').filter(Boolean)

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = (directory ? join(directory, name, windows) : name) + extension
      if (exists(candidate)) return start(candidate, args, env, windows)
    }
  }

  throw new CommandNotFound(
    `Could not find "${name}" to run. It is not on PATH as anything ${platform} can start.`,
  )
}

/**
 * A `.cmd` or `.bat` is a script, not an image, so CreateProcess refuses it —
 * the same refusal in a different costume. Hand those to the command
 * interpreter, which is what typing the name at a prompt does.
 */
function start(file: string, args: readonly string[], env: Lookup['env'], windows: boolean): string[] {
  const dot = file.lastIndexOf('.')
  const extension = dot === -1 ? '' : file.slice(dot).toUpperCase()
  if (!windows || !SCRIPTS.has(extension)) return [file, ...args]
  return [env?.ComSpec ?? env?.COMSPEC ?? 'cmd.exe', '/d', '/s', '/c', file, ...args]
}

function pathExt(env: Lookup['env']): string[] {
  return (env?.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean)
}

/**
 * Joining and absoluteness are decided by the target platform, not the host.
 * `node:path` answers for whichever machine is running — which is the wrong
 * machine in a test, and the wrong machine is how this file's bug got in.
 */
function join(directory: string, name: string, windows: boolean): string {
  const separator = windows ? '\\' : '/'
  return directory.endsWith('\\') || directory.endsWith('/')
    ? directory + name
    : directory + separator + name
}

/** A name with a separator in it is already a path, so PATH has no say in it. */
function named(name: string, windows: boolean): boolean {
  if (windows) return /^[a-zA-Z]:[\\/]/.test(name) || name.startsWith('\\') || /[\\/]/.test(name)
  return name.includes('/')
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Run a command to completion with its output on this terminal, and answer with
 * its exit code — which is the whole of what the callers here need to know.
 */
export function runSync(
  cmd: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): number {
  const resolved = resolveSpawn(cmd)
  const finished = Bun.spawnSync({
    cmd: resolved,
    cwd: options.cwd,
    env: options.env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return finished.exitCode ?? 1
}
