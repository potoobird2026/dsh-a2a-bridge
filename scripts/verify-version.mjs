#!/usr/bin/env node
/**
 * 门禁脚本：校验 `package.json.version` 与源码里的版本常量一致。
 *
 * 为什么需要：DSH 按 `engines.dsh` + 包版本装载插件，Agent Card / 诊断信息里
 * 也可能报插件版本。版本号散落两处时，发版很容易只改一处，导致「装的是
 * 0.1.1，运行时自报 0.1.0」这种只能靠日志发现的错位。
 *
 * 校验顺序：
 *   1. 扫 `src/**\/*.ts`，找显式版本常量（PLUGIN_VERSION / PACKAGE_VERSION /
 *      BRIDGE_VERSION / DSH_A2A_VERSION，以及裸 `const VERSION`）。
 *      找到就逐一与 package.json.version 比较，不一致 → 退出码 1。
 *   2. 没有版本常量时，退而检查仓库根 README.md 顶部 40 行里的版本声明
 *      （frontmatter `version:` 或 `版本：x.y.z`）。找到就比较。
 *   3. 两处都没有 → **明确说明跳过原因**并退出 0（advisory gate）。
 *
 * 注意：`src/constants.ts` 里的 `A2A_PROTOCOL_VERSION = '1.0'` 是**协议版本**，
 * 与包版本无关，绝不能拿来比对；本脚本按常量名白名单取值，天然排除它。
 *
 * 背景：本机 `@deepseek-ai/*` 有 0 个 `.d.ts`，tsconfig 因此保留
 * `noImplicitAny:false` + `skipLibCheck:true`。Vitest 不做类型检查，
 * 版本一致性只能由独立门禁保证。
 *
 * 退出码：版本不一致 → 1；一致 → 0；无法判定 → 0（打印原因 + CI warning）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_JSON = join(ROOT, 'package.json')

/** 只有这些名字才算「包版本常量」——不要泛化到 A2A_PROTOCOL_VERSION。 */
const VERSION_CONSTANT_NAMES = [
  'PLUGIN_VERSION',
  'PACKAGE_VERSION',
  'BRIDGE_VERSION',
  'DSH_A2A_VERSION',
  'VERSION',
]

const CONSTANT_PATTERN = new RegExp(
  String.raw`(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(${VERSION_CONSTANT_NAMES.join('|')})\s*(?::[^=\n]+)?=\s*['"]([^'"]+)['"]`,
  'g',
)

const README_LABEL_PATTERN =
  /^\s*(?:[-*]\s*)?(?:\*\*)?(?:version|版本)(?:\*\*)?\s*[:：]\s*`?v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)`?/im

const README_HEADING_PATTERN =
  /^#\s+.*?\bv([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\b/im

function fail(message) {
  console.error(`✗ verify-version: ${message}`)
  process.exitCode = 1
}

function warn(message) {
  const line = `⚠ verify-version: ${message}`
  console.warn(line)
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning::${line.replace(/^⚠\s*/, '')}`)
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

function walkTypeScript(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTypeScript(path, out)
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

function findVersionConstants() {
  const found = []
  for (const file of walkTypeScript(join(ROOT, 'src'), [])) {
    const source = readFileSync(file, 'utf8')
    CONSTANT_PATTERN.lastIndex = 0
    let match
    while ((match = CONSTANT_PATTERN.exec(source)) !== null) {
      found.push({ name: match[1], value: match[2], file: file.slice(ROOT.length + 1) })
    }
  }
  return found
}

function findReadmeVersion() {
  let names
  try {
    names = readdirSync(ROOT)
  } catch {
    return undefined
  }
  const readmeName = names.find((name) => name.toLowerCase() === 'readme.md')
  if (readmeName === undefined) return undefined

  const path = join(ROOT, readmeName)
  if (!statSync(path).isFile()) return undefined

  const top = readFileSync(path, 'utf8').split(/\r?\n/).slice(0, 40).join('\n')
  const labeled = README_LABEL_PATTERN.exec(top)
  if (labeled !== null) return { path: readmeName, value: labeled[1] }

  const heading = README_HEADING_PATTERN.exec(top)
  if (heading !== null) return { path: readmeName, value: heading[1] }

  return undefined
}

const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
const packageVersion = typeof manifest.version === 'string' ? manifest.version.trim() : ''

if (packageVersion.length === 0) {
  fail('package.json 没有 version 字段。')
  process.exit(process.exitCode ?? 1)
}

const constants = findVersionConstants()

if (constants.length > 0) {
  const mismatches = constants.filter((entry) => entry.value.trim() !== packageVersion)
  for (const entry of constants) {
    if (entry.value.trim() === packageVersion) {
      console.log(`✓ ${entry.file}: ${entry.name} = ${entry.value}（与 package.json 一致）`)
    }
  }

  if (mismatches.length > 0) {
    console.error('')
    console.error(`✗ 版本常量与 package.json.version 不一致（version = ${packageVersion}）：`)
    for (const entry of mismatches) {
      console.error(`  - ${entry.file}: ${entry.name} = '${entry.value}'`)
    }
    console.error('')
    console.error('  两处必须同源更新：改 package.json.version 时同步改该常量。')
    process.exitCode = 1
  } else {
    console.log(`✓ verify-version: 源码版本常量与 package.json（${packageVersion}）一致。`)
  }
} else {
  // 当前仓库没有包版本常量：这是允许的状态，因为版本只由 package.json 承载。
  const readme = findReadmeVersion()
  if (readme !== undefined && readme.value !== packageVersion) {
    fail(`README 顶部版本（${readme.value}，见 ${readme.path}）与 package.json（${packageVersion}）不一致。`)
  } else if (readme !== undefined) {
    console.log(`✓ verify-version: README 顶部版本 ${readme.value} 与 package.json 一致。`)
  } else {
    warn(
      `src/ 下没有版本常量，README.md 顶部也没有版本声明，跳过比对` +
        `（package.json.version = ${packageVersion}）。当前包版本只由 package.json 承载；` +
        `如果以后新增 PLUGIN_VERSION 之类的常量，本门禁会自动开始校验。`,
    )
    console.log('ℹ verify-version: 已明确跳过（不是通过校验）。')
  }
}

process.exit(process.exitCode ?? 0)
