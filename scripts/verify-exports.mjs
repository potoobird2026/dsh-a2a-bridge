#!/usr/bin/env node
/**
 * 门禁脚本：逐个校验 package.json 的 `exports` 指向的文件真实存在。
 *
 * 为什么需要这一步（自检背景）：
 *   1. `tsc` 即使在类型检查报错时**仍然会 emit**。如果 CI 用 `&&` 把
 *      `typecheck && build && test` 串成一条命令，typecheck 非零退出会让
 *      build 被**静默跳过**，结果 `lib/` 里缺文件，而测试可能还是绿的
 *      （Vitest 直接跑 src 或半份产物），问题被拖到安装时才暴露。
 *      所以 CI 每一步都要独立成 step，且 build 之后必须验证产物文件存在。
 *   2. `package.json.exports` 是 npm/DSH 装载插件的唯一入口。路径写错
 *      （例如 `.js` 写成 `.mjs`、`protocol/index` 漏 `/index`）在 `tsc`
 *      阶段完全合法，只会在消费方 import 时炸。
 *   3. 本脚本只做**存在性**校验，不校验导出符号；符号层面的校验应从
 *      `lib/` 里 import 后断言（需要先 build）。
 *
 * 前置：必须在 `npm run build` 之后执行（`lib/` 是构建产物）。
 *
 * 注：本仓库 `.gitignore` 明确 **`lib/` 是有意纳入版本控制的** —— 它既是随包
 * 交付物，也是 `src/` 的可恢复镜像（一次误批量编辑后，正是上一份绿色的
 * `lib/` 让恢复成为可能，见 docs/postmortem-2026-10-26.md）。因此"干净 checkout
 * 里没有 lib/"这句话**不成立**；但即使 lib/ 已在版本库里，也仍然必须重新
 * build 之后再验，否则验的是旧产物。
 *
 * 本脚本只依赖 Node 内置模块，无需 node_modules。
 *
 * 退出码：文件缺失 / exports 字段缺失 / 非法目标 → 1；全部存在 → 0。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_JSON = join(ROOT, 'package.json')

function fail(message) {
  console.error(`✗ verify-exports: ${message}`)
  process.exitCode = 1
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 递归展开 exports：值为字符串即一个目标；条件对象（types/default/import/require）
 * 与数组回退都要走到底。
 */
function collectTargets(value, conditionPath, out) {
  if (typeof value === 'string') {
    out.push({ conditionPath, target: value })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectTargets(entry, `${conditionPath}[${index}]`, out))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      collectTargets(entry, conditionPath.length === 0 ? key : `${conditionPath}.${key}`, out)
    }
    return
  }
  // null 是合法的「显式屏蔽」（例如 "./internal": null），不是错误。
  if (value !== null) {
    fail(`exports 中出现无法识别的值（${conditionPath}）：${String(value)}`)
  }
}

let manifest
try {
  manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
} catch (error) {
  fail(`无法读取/解析 package.json：${error instanceof Error ? error.message : String(error)}`)
  process.exit(process.exitCode ?? 1)
}

if (manifest.exports === undefined) {
  fail('package.json 没有 exports 字段，无法验证对外入口。请先补齐 exports。')
  process.exit(process.exitCode ?? 1)
}
if (typeof manifest.exports === 'string' || Array.isArray(manifest.exports)) {
  // 字符串/数组形态是合法的单入口简写，统一包成对象再展开。
  manifest = { ...manifest, exports: { '.': manifest.exports } }
}

const targets = []
collectTargets(manifest.exports, '', targets)

if (targets.length === 0) {
  fail('exports 展开后没有任何目标路径。')
  process.exit(process.exitCode ?? 1)
}

const missing = []
const skippedWildcards = []
let checked = 0

for (const { conditionPath, target } of targets) {
  if (!target.startsWith('./')) {
    fail(`exports["${conditionPath}"] 必须以 './' 开头（实际：${target}）`)
    continue
  }
  if (target.includes('*')) {
    // 通配符只能静态校验前缀目录，无法知道实际请求会命中哪个文件；
    // 这里显式列出来，避免给人「全都验过了」的错觉。
    skippedWildcards.push({ conditionPath, target })
    continue
  }

  const relative = target.slice(2)
  const absolute = join(ROOT, relative)
  checked += 1

  if (!isFile(absolute)) {
    missing.push({ conditionPath, target, absolute })
  }
}

for (const { conditionPath, target } of skippedWildcards) {
  console.warn(`⚠ 跳过通配符目标 exports["${conditionPath}"] -> ${target}（无法静态校验）`)
}

if (missing.length > 0) {
  console.error('')
  console.error(`✗ exports 指向的文件缺失（${missing.length} 个）：`)
  for (const { conditionPath, target, absolute } of missing) {
    console.error(`  - exports["${conditionPath}"] -> ${target}`)
    console.error(`    期望文件：${absolute}`)
  }
  console.error('')
  console.error('  排查顺序：')
  console.error('    1. 是否先跑了 npm run build（lib/ 是产物，干净 checkout 里没有）？')
  console.error('    2. tsconfig.build.json 的 include/exclude 是否漏了该源文件？')
  console.error('    3. tsc 报错时仍会 emit，产物可能不完整——先修类型错误再重跑。')
  process.exitCode = 1
} else if (process.exitCode === 1) {
  // 走到这里说明目标路径本身非法（不以 './' 开头等），fail() 已打印明细。
  console.error('✗ verify-exports: 存在非法的 exports 目标，未通过。')
} else {
  console.log(`✓ verify-exports: ${checked} 个 exports 目标文件均存在。`)
}

process.exit(process.exitCode ?? 0)
