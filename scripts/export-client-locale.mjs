#!/usr/bin/env node
/**
 * Export the client dictionaries to `locale/zh-CN.json` + `locale/en.json`.
 *
 * Usage:
 *   node scripts/export-client-locale.mjs           # write the files
 *   node scripts/export-client-locale.mjs --check   # fail when they drift
 *
 * The dictionaries are the source of truth inside `src/client.ts` (they must
 * be inlined in a classic browser script), so this script is the only supported
 * way to update the JSON copies. `--check` is what CI and the unit test use.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  LOCALE_TARGETS,
  localePath,
  readDictionaries,
} from './client-locale.mjs'

const check = process.argv.includes('--check')
const dictionaries = readDictionaries()
const problems = []

for (const [locale, target] of Object.entries(LOCALE_TARGETS)) {
  const path = localePath(target)
  const expected = `${JSON.stringify(dictionaries[locale], null, 2)}\n`

  if (check) {
    let actual
    try {
      actual = readFileSync(path, 'utf8')
    } catch {
      problems.push(`${target} is missing; run: node scripts/export-client-locale.mjs`)
      continue
    }
    if (actual !== expected) {
      problems.push(`${target} is out of sync with src/client.ts ZH/EN dictionaries`)
    }
    continue
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, expected, 'utf8')
  console.log(`✓ wrote ${target} (${Object.keys(dictionaries[locale]).length} keys)`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ client-locale: ${problem}`)
  process.exitCode = 1
} else if (check) {
  console.log('✓ client-locale: locale documents match the client dictionaries.')
}
