#!/usr/bin/env node
/**
 * Run BOTH TypeScript chains and report both results.
 *
 * Why this exists: `"typecheck": "tsc A && tsc B"` stops at the first failure, so a
 * type error in `src` makes every type error in `tests` invisible until it is fixed.
 * That is the same hazard the CI workflow avoids by keeping each gate a separate
 * step, and it was reproduced deliberately (inject a type error in src → the tests
 * chain never ran).
 *
 * This runner executes both chains regardless, prints each chain's diagnostics in
 * place, and exits non-zero if either failed. Nothing is hidden.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const chains = [
  ['src', ['tsc', '-p', 'tsconfig.json', '--noEmit']],
  ['tests', ['tsc', '-p', 'tsconfig.tests.json', '--noEmit']],
]

let failed = 0
for (const [name, command] of chains) {
  console.log(`\n── typecheck (${name}) ──`)
  const result = spawnSync(command[0], command.slice(1), { cwd: root, shell: true })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    failed += 1
    console.log(`✗ typecheck (${name}) failed`)
  } else {
    console.log(`✓ typecheck (${name}) passed`)
  }
}

if (failed > 0) {
  console.log(`\n✗ ${failed} of ${chains.length} typecheck chains failed.`)
  process.exit(1)
}
console.log(`\n✓ all ${chains.length} typecheck chains passed.`)
