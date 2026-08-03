/**
 * The Windows build blocker, held down.
 *
 * `bun run build` used to die with `uv_spawn 'bunx' ENOENT` on a machine where
 * `bunx next build` worked when typed. The cause is not exotic: an npm global
 * install writes a POSIX shell script named `bunx` next to the `bunx.cmd` that
 * Windows can run, libuv's PATH walk does not apply `PATHEXT`, so it finds the
 * script, cannot start it, and reports the command missing.
 *
 * Every test below fakes a filesystem and a PATH rather than reading the host's,
 * because the bug only appears on one platform and CI runs on another. The
 * point is that the resolution rule is checked on every push from either.
 */

import { expect, test } from 'bun:test'

import { CommandNotFound, resolveSpawn } from '../spawn.js'

/** The npm-global layout that produced the bug: a script, and a shim beside it. */
const NPM_GLOBAL = ['C:\\Users\\dev\\AppData\\Roaming\\npm\\bunx', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\bunx.cmd']

const BUN = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe'

/**
 * A Windows machine with the given files on it and one directory on PATH.
 *
 * The fake filesystem is case-insensitive because NTFS is, and `PATHEXT` is
 * conventionally upper case while the files on disk are not — a case-sensitive
 * fake would pass this suite by being wrong in a way Windows never is.
 */
function windows(files: readonly string[], path = 'C:\\Users\\dev\\AppData\\Roaming\\npm') {
  const present = new Set(files.map((file) => file.toLowerCase()))
  return {
    platform: 'win32',
    execPath: BUN,
    env: { PATH: path, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    isFile: (candidate: string) => present.has(candidate.toLowerCase()),
  }
}

/** Windows compares paths without case, and `PATHEXT` is upper while disks are not. */
const nocase = (cmd: readonly string[]): string[] => cmd.map((part) => part.toLowerCase())

// ----------------------------------------------------------------------- tests

test('bunx is answered by the Bun already running, not by a search of PATH', () => {
  // The fix. There is no lookup to get wrong, on any platform, because the
  // binary that is executing this line is the binary the command needs.
  const cmd = resolveSpawn(['bunx', 'next', 'build'], windows(NPM_GLOBAL))

  expect(cmd).toEqual([BUN, 'x', 'next', 'build'])
})

test('bunx resolves even when nothing named bunx is on PATH at all', () => {
  // The literal ENOENT case: an empty PATH used to be fatal and is now irrelevant.
  const cmd = resolveSpawn(['bunx', 'next', 'build'], { ...windows([]), env: { PATH: '' } })

  expect(cmd[0]).toBe(BUN)
  expect(cmd[1]).toBe('x')
})

test('bun is spawned as itself rather than by name', () => {
  const cmd = resolveSpawn(['bun', 'run', 'server/main.ts'], windows([]))

  expect(cmd).toEqual([BUN, 'run', 'server/main.ts'])
})

test('a Windows lookup prefers the executable to the extensionless script beside it', () => {
  // The bug in one assertion. Both files exist and are one character apart; the
  // bare name is the one Windows cannot start, so PATHEXT is consulted first.
  const cmd = resolveSpawn(['tool'], windows(['C:\\bin\\tool', 'C:\\bin\\tool.exe'], 'C:\\bin'))

  expect(nocase(cmd)).toEqual(['c:\\bin\\tool.exe'])
})

test('a .cmd shim is handed to the command interpreter, which is what can read it', () => {
  // CreateProcess refuses a batch script. Spawning one directly is the same
  // failure in a different costume, so it goes through ComSpec instead.
  const cmd = resolveSpawn(['tool', '--flag'], windows(['C:\\bin\\tool.cmd'], 'C:\\bin'))

  expect(nocase(cmd)).toEqual(nocase(['C:\\Windows\\system32\\cmd.exe', '/d', '/s', '/c', 'C:\\bin\\tool.cmd', '--flag']))
})

test('PATH is searched in order, and the first directory holding it wins', () => {
  const cmd = resolveSpawn(['tool'], {
    ...windows(['C:\\second\\tool.exe', 'C:\\first\\tool.exe']),
    env: { PATH: 'C:\\first;C:\\second', PATHEXT: '.EXE' },
  })

  expect(nocase(cmd)).toEqual(['c:\\first\\tool.exe'])
})

test('on a Unix machine the bare name is the whole answer', () => {
  const cmd = resolveSpawn(['tool', 'go'], {
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin' },
    isFile: (candidate) => candidate === '/usr/bin/tool',
  })

  expect(cmd).toEqual(['/usr/bin/tool', 'go'])
})

test('a command given as a path is run from there without consulting PATH', () => {
  const cmd = resolveSpawn(['./node_modules/.bin/next', 'build'], {
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    isFile: (candidate) => candidate === './node_modules/.bin/next',
  })

  expect(cmd).toEqual(['./node_modules/.bin/next', 'build'])
})

test('a command that is nowhere says which one, rather than surfacing an errno', () => {
  // What the failure used to look like was `uv_spawn 'bunx' ENOENT`, which sends
  // whoever reads it into libuv rather than to their PATH.
  expect(() => resolveSpawn(['absent'], windows([]))).toThrow(CommandNotFound)
  expect(() => resolveSpawn(['absent'], windows([]))).toThrow(/absent/)
})

test('an empty command is refused before anything is spawned', () => {
  expect(() => resolveSpawn([])).toThrow(CommandNotFound)
})
