#!/usr/bin/env node
/**
 * 门禁脚本：把 ADR-008「禁硬编码」从纪律变成可执行的门禁。
 *
 * 为什么需要（自检背景）：
 *   1. `tsc` 与 `vitest` 都**看不见硬编码**。把 `3081` 写进模块、把
 *      `C:/Users/<某人>/.dsh` 写进随包发布的 `cordis.patch.yml`，类型全对、
 *      用例全绿，只有换一台机器才会暴露。这类缺陷只能靠文本层门禁抓。
 *   2. 规范要求「所有 port / host / timeout / 上限数字必须来自
 *      `src/config.ts` 或 `src/constants.ts`」。只要默认值在别处再写一遍，
 *      就会出现两个真值，改一处不改另一处 —— 这是本仓库已经踩过的坑
 *      （`DEFAULT_LISTEN_PORT` 曾在 config.ts 与 constants.ts 各写一份）。
 *   3. Client 侧可见文案必须走 locale；中文写死在别处等于只有中文用户。
 *
 * 扫描范围：`src/**\/*.ts`，**排除** `src/dsh-ambient.d.ts`（环境声明，不是逻辑）。
 * 不扫 `lib/`（构建产物）、`tests/`（测试夹具里出现厂商名是正常的）。
 *
 * 判定口径（重要）：
 *   - **注释不算违规**。注释里出现厂商名、示例路径是文档，不是逻辑。
 *     本脚本先把注释替换成等长空白再扫描，行号不变，因此
 *     `// 例如 deepseek-account / LongCat` 不会被误报。
 *   - **`src/constants.ts` 与 `src/config.ts` 是默认值的合法归属**，
 *     因此不参与「魔法数字」规则（它们本身就得写具体数字）。
 *   - **命名常量的定义行不算硬编码**（`const DEFAULT_PORT = 3081`）。规则抓的是
 *     「裸字面量出现在表达式里」。例外：类字段 `readonly code = -32602` 不豁免，
 *     因为它是在重复定义已经存在的具名错误码。
 *   - Client 中文（`src/client.ts`）和 Host 中文分开处理：前者是**硬失败**
 *     （locale 是 DSH 的明确要求），后者是 **advisory 警告**
 *     （Host 侧面向 peer 的协议文案没有强制 locale 通道）。
 *
 * 允许名单怎么维护：
 *   两种方式，都必须写清理由，且理由要能被人复核 ——
 *   1. `ALLOWLIST` 数组：按「文件 + 规则 + 精确片段」放行，适合长期例外。
 *   2. 行内 pragma：在被放行那一行（或紧邻上一行）写
 *      `// hardcode-audit-allow: <理由>`，适合就地说明的一次性例外。
 *   放行不等于无问题：审计报告 `docs/standards-audit.md` 里仍然必须记一条。
 *   常量文件里定义 provider / model 白名单的写法（`PROVIDER_ALLOWLIST`
 *   之类）属于**设计上的白名单**，放行时在 ALLOWLIST 里指向那个常量声明。
 *
 * 用法：
 *   node scripts/verify-no-hardcode.mjs            # 门禁模式：命中即 exit 1
 *   node scripts/verify-no-hardcode.mjs --report    # 报告模式：只打印，exit 0
 *
 * 退出码：门禁模式命中 → 1；无命中 → 0；脚本自身异常 → 1。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const REPORT_ONLY = process.argv.includes('--report')

/** 不属于「逻辑」的文件：环境声明是手写的 d.ts，允许出现任何字面量。 */
const EXCLUDED_FILES = new Set(['src/dsh-ambient.d.ts'])

/** 默认值的两个合法归属；不参与魔法数字规则。 */
const DEFAULT_OWNER_FILES = new Set(['src/config.ts', 'src/constants.ts'])

/** Client 半（必须走 locale）。 */
const CLIENT_FILE = 'src/client.ts'
/**
 * Host 侧文案的唯一合法归属地。
 *
 * `host-locale` 这条 advisory 的建议就是「把 Host 中文集中到一处导出」；如果连那张表
 * 也报，这条规则的建议就永远无法满足。因此只豁免这一个文件，其它 Host 文件照旧告警 ——
 * 压力仍在，只是有了一个能落地的去处。
 */
const MESSAGES_FILE = 'src/messages.ts'

// ── 允许名单 ───────────────────────────────────────────────────────────────

/**
 * 长期例外。每条都必须能被复核：`why` 要回答「为什么这不算绕过单点定义」。
 *
 * 维护原则：**能改代码就别往这里加**。这张表变长就是审计报告要写的内容。
 */
const ALLOWLIST = [
  {
    rule: 'magic-number',
    file: 'src/config.ts',
    match: '',
    why: '占位：默认值归属文件本身不受本规则约束（见 DEFAULT_OWNER_FILES），此条不会被命中。',
  },
]

/** 行内 pragma；必须带非空理由。 */
const PRAGMA = /hardcode-audit-allow\s*:\s*(\S.*)$/

// ── 注释剥离 ───────────────────────────────────────────────────────────────

/**
 * 把注释内容替换成空格，保留换行与字符数（行号、列号因此不变）。
 *
 * 只处理 `//` 与 `/* *\/`；不处理字符串里的 `//`（本项目没有把 URL 放在
 * 会被误判的形态里，且字符串内的 `//` 之后通常紧跟路径而非中文/厂商名）。
 * 这个取舍写在这里，免得以后有人以为它是完整词法器。
 */
function stripComments(source) {
  const out = []
  let i = 0
  let state = 'code'
  const n = source.length
  while (i < n) {
    const c = source[i]
    const next = i + 1 < n ? source[i + 1] : ''

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line'
        out.push('  ')
        i += 2
        continue
      }
      if (c === '/' && next === '*') {
        state = 'block'
        out.push('  ')
        i += 2
        continue
      }
      out.push(c)
      i += 1
      continue
    }

    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out.push('\n')
      } else {
        out.push(' ')
      }
      i += 1
      continue
    }

    // state === 'block'
    if (c === '*' && next === '/') {
      state = 'code'
      out.push('  ')
      i += 2
      continue
    }
    out.push(c === '\n' ? '\n' : ' ')
    i += 1
  }
  return out.join('')
}

// ── 规则 ───────────────────────────────────────────────────────────────────

/** 盘符绝对路径。负向后顾避免把 `http://` 里的 `p:/` 当成盘符。 */
const DRIVE_PATH = /(?<![\w.-])[A-Za-z]:[\\/]/
/** POSIX 家目录绝对路径。 */
const POSIX_HOME = /(?:^|[^:\w])\/(?:Users|home)\/[A-Za-z0-9._-]+/
/** Win32 用户目录片段。 */
const WIN_USER_DIR = /\b(?:AppData|Program Files|ProgramData)\b/
/**
 * 这里**刻意没有**"某个具体人"的规则。
 *
 * 曾经有一条把本机用户名与 checkout 目录名写死的正则。它有两个问题：
 *   1. 门禁脚本本身成了泄露源 —— 它把个人信息发布到了公开仓库；
 *   2. 发布流程把人名替换成占位符后，正则变成匹配字面量 `<用户名>`，静默失效。
 * 绝对路径的风险已由 DRIVE_PATH / POSIX_HOME / WIN_USER_DIR 通用覆盖，
 * 所以规则保持"与人无关"。
 */
/** 厂商 / 模型名（出现在逻辑里就是硬编码路由）。 */
const VENDOR_NAME =
  /\b(?:deepseek-account|longcat|LongCat|ollama|Ollama|anthropic|openai|claude-[\w.-]+|gpt-[\w.-]+)\b/
/** 协议里的主机字面量。 */
const HOST_LITERAL = /['"`](?:127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1?\])['"`]/
/**
 * 3 位以上数字（含 `5_000` 分隔写法）。
 *
 * 排除两种情况，否则误报会把门禁变成噪声：
 *   - 十六进制颜色（`#666`、`#c0392b`）：`#` 或十六进制字母紧邻左侧；
 *   - 标识符内的数字（`sha256`、`es2024`）：前一个字符是单词字符。
 */
const MAGIC_NUMBER = /(?<![#\w])\d[\d_]{2,}/
/**
 * 「命名常量的定义行」整行匹配：`const NAME = 3081` / `const X: number = 3081`。
 *
 * 这类行**不是硬编码**，而是魔法数字的正确归宿 —— 把数字起个名字。本规则
 * 只抓「裸字面量出现在表达式里」。刻意不含 `readonly`（类字段）：
 * `readonly code = -32602` 是重复定义已存在的 `ERR_INVALID_PARAMS`，
 * 属于要修的问题，必须被抓住。
 */
const CONST_DEFINITION = /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::\s*[^=]+)?=\s*-?\d[\d_]*\s*$/
/** setTimeout / setInterval 的裸数字时长。 */
const TIMER_LITERAL = /set(?:Timeout|Interval)\s*\([^,]+,\s*(\d[\d_]*)/

const CJK = /[\u4e00-\u9fff]/
/** locale 字典行：`"key": "值"` 形态（client.ts 的 ZH / EN 就是这种）。 */
const LOCALE_ENTRY_LINE = /^\s*"[^"]+"\s*:\s*"/

const RULES = [
  {
    id: 'absolute-path',
    severity: 'error',
    describe: '绝对路径 / 盘符',
    test: (text) => DRIVE_PATH.test(text) || POSIX_HOME.test(text) || WIN_USER_DIR.test(text),
    fix: '改用 node:path 基于 ctx 提供的根（如 homePaths / cwd）解析；路径只能来自配置。',
  },
  // 此处不再有 'local-identity' 规则：它曾把具体用户名写进本脚本 —— 既是泄露源，
  // 又会在发布替换后变成匹配字面量 `<用户名>` 的废规则。绝对路径风险由
  // drive-path / posix-home / win-user-dir 三条通用规则覆盖。
  {
    id: 'vendor-name',
    severity: 'error',
    describe: '厂商 / 模型名出现在逻辑里',
    test: (text) => VENDOR_NAME.test(text),
    fix: 'provider / model 必须来自运行时探测（ctx.llm）或配置，模块内不得点名任何厂商。',
  },
  {
    id: 'host-literal',
    severity: 'error',
    describe: '主机字面量',
    test: (text) => HOST_LITERAL.test(text),
    fix: 'host 必须来自 config（如 inbound.listen.host）；通配/回环判断请与 constants 里的常量比较。',
  },
  {
    id: 'magic-number',
    severity: 'error',
    describe: '数字上限/超时/端口未来自 config|constants',
    test: (text) => MAGIC_NUMBER.test(text) || TIMER_LITERAL.test(text),
    fix: '提到 src/constants.ts（不变量）或 src/config.ts（可配置项），模块里只引用常量名。',
  },
]

// ── 扫描 ───────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

function toRepoPath(absolute) {
  return relative(ROOT, absolute).split(sep).join('/')
}

function allowlisted(rule, file, line, previousLine) {
  for (const entry of ALLOWLIST) {
    if (entry.rule !== rule) continue
    if (entry.file !== undefined && toRepoPath(entry.file) !== file && entry.file !== file) continue
    if (entry.match === '') continue
    if (line.includes(entry.match)) return entry.why
  }
  const pragma = PRAGMA.exec(line) ?? PRAGMA.exec(previousLine ?? '')
  if (pragma !== null && pragma[1].trim().length > 0) return pragma[1].trim()
  return undefined
}

/** 收集 `export const NAME =` 的声明位置，用于「重复定义」全局规则。 */
function collectExportedConstants(file, lines) {
  const found = new Map()
  const pattern = /^\s*export\s+const\s+([A-Z][A-Z0-9_]*)\s*[:=]/
  lines.forEach((line, index) => {
    const match = pattern.exec(line)
    if (match !== null) found.set(match[1], index + 1)
  })
  return found
}

let files
try {
  files = walk(SRC)
} catch (error) {
  console.error(`✗ verify-no-hardcode: 无法读取 src/：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

/** @type {Array<{file:string,line:number,rule:string,severity:'error'|'warn',text:string,fix:string,why?:string}>} */
const findings = []
const constantOwners = new Map()

/**
 * 扫描顺序：`constants.ts` → `config.ts` → 其余按字母序。
 *
 * 顺序有语义：`duplicate-default` 把「后出现的那份」报成违规，而
 * `constants.ts` 才是 protocol/运行时不变量的家，所以它必须先进表，
 * 这样被报出来的是 `config.ts` 里多余的那份，而不是反过来。
 */
const SCAN_ORDER = ['src/constants.ts', 'src/config.ts']
const ordered = files
  .map((absolute) => ({ absolute, file: toRepoPath(absolute) }))
  .sort((a, b) => {
    const rankA = SCAN_ORDER.indexOf(a.file)
    const rankB = SCAN_ORDER.indexOf(b.file)
    if (rankA !== rankB) return (rankA < 0 ? SCAN_ORDER.length : rankA) - (rankB < 0 ? SCAN_ORDER.length : rankB)
    return a.file.localeCompare(b.file)
  })

for (const { absolute, file } of ordered) {
  if (EXCLUDED_FILES.has(file)) continue

  const raw = readFileSync(absolute, 'utf8')
  const rawLines = raw.split(/\r?\n/)
  const codeLines = stripComments(raw).split(/\r?\n/)
  const isDefaultOwner = DEFAULT_OWNER_FILES.has(file)

  if (isDefaultOwner) {
    const own = collectExportedConstants(file, codeLines)
    for (const [name, line] of own) {
      const existing = constantOwners.get(name)
      if (existing === undefined) constantOwners.set(name, { file, line })
      else if (existing.file !== file) {
        findings.push({
          file,
          line,
          rule: 'duplicate-default',
          severity: 'error',
          text: `常量 ${name} 已在 ${existing.file}:${existing.line} 定义`,
          fix: '同一默认值只能有一个归属：protocol/运行时不变量的家在 constants.ts。删掉这里的一份并改成 import。',
        })
      }
    }
  }

  for (let index = 0; index < codeLines.length; index += 1) {
    const code = codeLines[index]
    if (code.trim().length === 0) continue
    const previous = codeLines[index - 1]
    const rawLine = rawLines[index] ?? ''

    // Client 中文：locale 字典行放行，其余硬失败。
    if (file === CLIENT_FILE && CJK.test(code) && !LOCALE_ENTRY_LINE.test(code)) {
      if (allowlisted('client-locale', file, rawLine, rawLines[index - 1]) === undefined) {
        findings.push({
          file,
          line: index + 1,
          rule: 'client-locale',
          severity: 'error',
          text: code.trim().slice(0, 120),
          fix: 'Client 可见文案必须进 ZH / EN 字典（`ctx.locale`）后按 key 取；不要在组件里写死中文。',
        })
      }
    }

    // Host 侧中文：advisory。Host 没有强制 locale 通道，但仍是可移植性缺陷。
    if (file !== CLIENT_FILE && file !== MESSAGES_FILE && CJK.test(code)) {
      findings.push({
        file,
        line: index + 1,
        rule: 'host-locale',
        severity: 'warn',
        text: code.trim().slice(0, 120),
        fix: '面向用户/peer 的文案应集中到一处导出（如 session/events.ts 的标签表），便于统一替换与审核。',
      })
    }

    for (const rule of RULES) {
      if (rule.id === 'magic-number' && (isDefaultOwner || CONST_DEFINITION.test(code))) continue
      if (!rule.test(code)) continue
      const why = allowlisted(rule.id, file, rawLine, rawLines[index - 1])
      if (why !== undefined) continue
      findings.push({
        file,
        line: index + 1,
        rule: rule.id,
        severity: rule.severity,
        text: code.trim().slice(0, 120),
        fix: rule.fix,
      })
    }
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────────

const errors = findings.filter((finding) => finding.severity === 'error')
const warnings = findings.filter((finding) => finding.severity === 'warn')
const byRule = new Map()
for (const finding of findings) byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1)

const RULE_TITLES = {
  'absolute-path': '绝对路径 / 盘符',
  'local-identity': '本机用户名 / 本机目录名',
  'vendor-name': '厂商 / 模型名',
  'host-literal': '主机字面量',
  'magic-number': '数字上限/超时/端口',
  'duplicate-default': '默认值重复定义',
  'client-locale': 'Client 中文绕过 locale',
  'host-locale': 'Host 侧中文（advisory）',
}

function printGroup(list, label) {
  if (list.length === 0) return
  console.log('')
  console.log(`${label}（${list.length}）：`)
  let currentFile
  for (const finding of list) {
    if (finding.file !== currentFile) {
      currentFile = finding.file
      console.log(`\n  ${currentFile}`)
    }
    console.log(`    ${finding.line}: [${finding.rule}] ${finding.text}`)
    console.log(`        → ${finding.fix}`)
  }
}

console.log('verify-no-hardcode: 扫描 src/**/*.ts（已排除 src/dsh-ambient.d.ts）')
console.log('  规则：绝对路径 / 本机身份 / 厂商名 / 主机字面量 / 魔法数字 / 默认值重复 / Client locale / Host 中文')

printGroup(errors, '✗ error')
printGroup(warnings, '⚠ warn')

console.log('')
console.log('  按规则统计：')
for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${(RULE_TITLES[rule] ?? rule).padEnd(28, ' ')} ${count}`)
}
console.log('')
console.log(`  合计 error ${errors.length} 条 / warn ${warnings.length} 条`)

if (errors.length === 0) {
  console.log('✓ verify-no-hardcode: 未发现硬编码。')
  process.exit(0)
}

console.error('')
console.error(`✗ verify-no-hardcode: 发现 ${errors.length} 条硬编码。`)
console.error('  ADR-008：默认值只能存在于 src/config.ts（可配置）或 src/constants.ts（不变量）。')
console.error('  修法二选一：① 改成引用常量/配置；② 确属长期例外则加 ALLOWLIST 条目并写清 `why`，')
console.error('             同时在 docs/standards-audit.md 留一条记录。')

if (REPORT_ONLY) {
  console.log('')
  console.log('ℹ --report：报告模式，退出码 0（不阻塞）。')
  process.exit(0)
}

process.exit(1)
