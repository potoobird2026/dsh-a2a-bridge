#!/usr/bin/env node
/**
 * Shared helper: read the locale dictionaries that live INSIDE the browser
 * bundle source (`src/client.ts`) and turn them into the shipped
 * `locale/*.json` documents.
 *
 * WHY THE DICTIONARY LIVES IN `src/client.ts` AND NOT IN THE JSON:
 * the browser half is loaded as a CLASSIC <script>, so it cannot `import` a
 * JSON file (that is ESM syntax) and this project builds with plain `tsc`,
 * which does not bundle a module graph. The dictionaries must therefore be
 * inlined in the emitted `lib/client.js`. The JSON files are the same copy in a
 * machine-readable form, and the dictionary is deliberately written in JSON
 * shape (double quotes, no trailing commas) so this helper can parse it with
 * `JSON.parse` — no `eval`, no regex-guessing at the value level.
 *
 * `scripts/export-client-locale.mjs` writes the JSON files;
 * `tests/unit/client.spec.ts` asserts they never drift from the source.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const CLIENT_SOURCE = join(ROOT, 'src', 'client.ts')

/**
 * Locale id -> shipped file.
 *
 * DSH's own locale ids are `zh` and `en` (see `LOCALE_IDS` in
 * `@deepseek-ai/dsh-client-locale`), which is why the dictionaries register
 * under those ids even though the Chinese document is named `zh-CN.json`.
 */
export const LOCALE_TARGETS = Object.freeze({
  zh: 'locale/zh-CN.json',
  en: 'locale/en.json',
})

/** The exported TS constants that hold each dictionary. */
export const DICTIONARY_NAMES = Object.freeze({ zh: 'ZH', en: 'EN' })

/**
 * Extract one object literal from TypeScript source and parse it as JSON.
 *
 * A balanced-brace scan (string-aware) is used instead of a regex so a value
 * containing `}` or `{` — Chinese copy plausibly does — cannot truncate the
 * match.
 *
 * @param {string} source TypeScript source text.
 * @param {string} name Constant name, e.g. `ZH`.
 * @returns {Record<string, string>} the parsed dictionary.
 */
export function extractDictionary(source, name) {
  const marker = new RegExp(String.raw`const\s+${name}\s*(?::[^=]+)?=\s*\{`)
  const match = marker.exec(source)
  if (match === null) throw new Error(`client-locale: dictionary "${name}" not found in src/client.ts`)

  const start = match.index + match[0].length - 1
  let depth = 0
  let quote = undefined
  let escaped = false

  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== undefined) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = undefined
      }
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '{') {
      depth += 1
      continue
    }
    if (character === '}') {
      depth -= 1
      if (depth === 0) {
        const literal = source.slice(start, index + 1)
        try {
          return JSON.parse(literal)
        } catch (error) {
          throw new Error(
            `client-locale: dictionary "${name}" is not valid JSON (${String(error)}); ` +
              'keep the literal JSON-shaped (double quotes, no trailing commas)',
          )
        }
      }
    }
  }

  throw new Error(`client-locale: unterminated dictionary "${name}" in src/client.ts`)
}

/** Read `src/client.ts` once. */
export function readClientSource() {
  return readFileSync(CLIENT_SOURCE, 'utf8')
}

/** Every dictionary, keyed by locale id. */
export function readDictionaries() {
  const source = readClientSource()
  const dictionaries = {}
  for (const [locale, name] of Object.entries(DICTIONARY_NAMES)) {
    dictionaries[locale] = extractDictionary(source, name)
  }
  return dictionaries
}

/** Absolute path of a shipped locale document. */
export function localePath(target) {
  return join(ROOT, target)
}
