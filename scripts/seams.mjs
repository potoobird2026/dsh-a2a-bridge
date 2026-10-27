/**
 * Print the plugin's seam-probe line from the DSH host log, and optionally diff
 * two machines' probes.
 *
 * WHY: `docs/rc-seam-audit.md` explains that a byte-level `.d.ts` comparison is
 * impossible against a packaged DSH (`app.asar`), so the runtime seam probe is the
 * main cross-build evidence. Reading it out of a 10 MB log by hand is the part that
 * does not scale — this script is that comparison, automated.
 *
 * Usage:
 *   node scripts/seams.mjs                 # newest probe in the newest log
 *   node scripts/seams.mjs --all           # every probe, oldest → newest
 *   node scripts/seams.mjs --compare       # diff the last two DISTINCT probes
 *   node scripts/seams.mjs --file <path>   # read a specific directory or file
 *   node scripts/seams.mjs --require       # exit 1 when no probe is present
 *
 * Exit codes: 0 normally; 1 only with `--require` and no probe line; 2 on a bad
 * `--file`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROBE = /a2a: seams (.+)$/
/** Newest N log files are enough: a probe is emitted once per plugin start. */
const MAX_FILES = 3

function fail(message, code = 2) {
  console.error(message)
  process.exit(code)
}

function defaultLogDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData !== undefined && appData.length > 0) return join(appData, 'DSH Desktop', 'logs', 'host')
    return join(homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'logs', 'host')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Logs', 'DSH Desktop', 'host')
  }
  return join(homedir(), '.config', 'DSH Desktop', 'logs', 'host')
}

/** Accept either a directory (take the newest logs) or one explicit file. */
function resolveSources(target) {
  let info
  try {
    info = statSync(target)
  } catch {
    fail(`log path not found: ${target}`)
  }
  if (info.isFile()) return [target]
  return readdirSync(target)
    .filter((name) => name.endsWith('.log'))
    .map((name) => ({
      name,
      path: join(target, name),
      mtime: statSync(join(target, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES)
    .map((entry) => entry.path)
}

/**
 * Collect probes in chronological order.
 *
 * A log line carries the timestamp in front of the message, so the file order is
 * enough; within a file the lines are already chronological.
 */
function collectProbes(files) {
  const probes = []
  for (const file of [...files].reverse()) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const match = PROBE.exec(line)
      if (match === null) continue
      // The line may be a JSON-encoded duplicate (`{"message":"…"}`); keep the
      // human-readable occurrence only so the output is not doubled.
      if (line.includes('"message"')) continue
      probes.push({ file, flags: match[1].trim() })
    }
  }
  return probes
}

function parseFlags(text) {
  const flags = new Map()
  for (const token of text.split(/\s+/)) {
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    flags.set(token.slice(0, eq), token.slice(eq + 1))
  }
  return flags
}

function compare(previous, current) {
  const before = parseFlags(previous.flags)
  const after = parseFlags(current.flags)
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort()
  const differences = []
  for (const key of keys) {
    if (key === 'missing' || key === 'critical-missing') continue
    const a = before.get(key)
    const b = after.get(key)
    if (a !== b) differences.push(`${key}: ${a ?? '(absent)'} → ${b ?? '(absent)'}`)
  }
  return differences
}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name) => {
  const index = argv.indexOf(name)
  return index !== -1 && index + 1 < argv.length ? argv[index + 1] : undefined
}

const target = valueOf('--file') ?? process.env.DSH_LOG_DIR ?? defaultLogDir()
const probes = collectProbes(resolveSources(target))

if (probes.length === 0) {
  console.log(`no "a2a: seams" probe found under ${target}`)
  console.log('')
  console.log('A probe is written once per plugin start. If the log has none, the running')
  console.log('build predates the probe: restart DSH so the deployed build loads, then retry.')
  process.exit(flag('--require') ? 1 : 0)
}

if (flag('--all')) {
  for (const probe of probes) console.log(probe.flags)
  process.exit(0)
}

const latest = probes[probes.length - 1]
console.log(latest.flags)

if (flag('--compare')) {
  // Compare against the previous run with a DIFFERENT result; two starts of the
  // same build produce identical lines and would diff to nothing useful.
  const distinct = probes.filter((probe, index) => index === 0 || probe.flags !== probes[index - 1].flags)
  if (distinct.length < 2) {
    console.log('')
    console.log('only one distinct probe so far — nothing to compare yet')
    process.exit(0)
  }
  const differences = compare(distinct[distinct.length - 2], distinct[distinct.length - 1])
  console.log('')
  if (differences.length === 0) {
    console.log('no seam differences between the last two distinct probes')
  } else {
    console.log('seam differences (previous → current):')
    for (const line of differences) console.log(`  ${line}`)
  }
}
