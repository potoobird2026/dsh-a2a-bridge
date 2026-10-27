/**
 * Browser (client) half of dsh-a2a-bridge — the "A2A 模型" card inside
 * 「插件 → A2A 桥接 → 配置」.
 *
 * FORMAT CONTRACT (verified against the shipped
 * `@deepseek-ai/dsh-client-ui-plugin-manager` and `@deepseek-ai/dsh-client-modules`):
 *   - The bundle is loaded as a CLASSIC <script>, so it must contain no
 *     top-level `import`/`export`. Everything lives inside the factory the
 *     harness' `window.__ModuleLoader__` calls later.
 *   - The registration `id` MUST equal the package name `dsh-a2a-bridge`:
 *     client-modules composes the module graph from the manifest's package
 *     name, and the browser asserts "bundle loaded without registering <id>".
 *   - React comes from `require('react')` (a platform seed module). No bundled
 *     copy, no CDN — a second React instance breaks hooks across the UI.
 *
 * SLOT KEYS (the issue #55 trap): `plugins.row.config` is a KEYED slot. The
 * Plugins page dispatches with `entryKey = \`${bundle package name}#${rowId}\``
 * (`rowConfigKey()` in `dsh-client-ui-plugin-manager`) and renders the section
 * only when `ledger.rows.has(entryKey)`. `rowId` is the id our own
 * `cordis.patch.yml` declares (`a2a-bridge`). Both the bare package name and
 * the `include:`-wrapped Loader entry id are registered because the profile
 * layer chooses which spelling the inventory reports; duplicate keys live in
 * separate cells, so this is a shadowing-free duplicate.
 *
 * WRITE CHANNEL (T2). The contract of this slot is
 * (`@deepseek-ai/dsh-cordis-client-runner`, `PluginConfigViewProps`):
 *
 *     interface PluginConfigViewProps {
 *       readonly view: 'summary' | 'page'
 *       readonly form?: ConfigPageForm | undefined
 *     }
 *
 * and `dsh-client-ui-plugin-manager` opens a row page with
 * `form: formFor(openRow.rowId)`, where `formFor()` returns
 * `{ state: form.getSnapshot(), mutate(ops, revision) }` only when
 * `settings.describe()` serves the namespace named after that row id
 * (`ConfigFormController` in `dsh-client-ui-settings`). Our Config schema marks
 * `inbound.agent.provider` / `.model` as `volatile`, and
 * `SettingsForms.describe()` projects a namespace for every active entry that
 * has at least one volatile field — so the row page DOES receive `form`.
 * Using it keeps one source of truth (`cordis.patch.yml` through
 * `@deepseek-ai/dsh-config-editor`) instead of a private state file, and the
 * Host validates the field paths.
 *
 * The HTTP route below therefore stays as (a) the runtime catalog probe —
 * providers/models MUST come from `ctx.llm.listProviders()/listModels()` on
 * the Host, never from a hard-coded vendor list — and (b) the complete write
 * channel only when `form` is absent (an older Host, or a profile whose
 * settings provider is not composed). That fallback is not a second source of
 * truth: it is guarded by `hasForm` and never used while `form` is present.
 *
 * WORKSPACE PATH (task-7). `inbound.isolation.workspaceRoot` is another
 * volatile field, so it uses the same `form.mutate` channel. An empty value is
 * meaningful ("derive `<DSH_HOME>/a2a-workspaces`"), hence `set ''` rather than
 * `unset`. The "Browse…" control is OPTIONAL: it uses the generated
 * `ctx.remote.directoryPicker` namespace (VERIFIED in
 * `dsh-client-ui-workspace`: `pick()` and `list(path)` answer the Remote
 * `{ ok, value } | { ok: false, error }` envelope, and a composition may serve
 * only one of the two verbs). When the namespace is absent or refuses the
 * native chooser, the page falls back to the text input — it never fabricates a
 * filesystem API of its own.
 *
 * The file is intentionally self-contained (one compiled `lib/client.js`): the
 * project builds with plain `tsc`, which cannot bundle a module graph for the
 * browser, and the locale dictionaries must ship inside the same script.
 */

;(() => {
  /** Must equal `package.json.name` — the module-loader registration id. */
  const PACKAGE_NAME = 'dsh-a2a-bridge'
  /** Distinct Cordis plugin name; the loader id above is the package name. */
  const CLIENT_NAME = 'dsh-a2a-bridge-client'

  /** Must equal `CONFIG_ROUTE_PATH` in `src/constants.ts` (pinned by a test). */
  const CONFIG_ENDPOINT = '/a2a-bridge/config'

  /** Locale namespace this card owns; the slot `locale` option binds `t` to it. */
  const LOCALE_NAMESPACE = 'a2a-bridge'
  /** The keyed Plugins-page slot that hosts a row's configuration page. */
  const SLOT_NAME = 'plugins.row.config'
  /** Same priority the shipped cards use, so ordering stays predictable. */
  const SLOT_PRIORITY = 30

  /** Must equal the `id` this package's `cordis.patch.yml` declares. */
  const ROW_ID = 'a2a-bridge'
  /**
   * Milliseconds per day — used only to show/persist retention in DAYS.
   *
   * DUPLICATED from `src/constants.ts` on purpose: this half is a CLASSIC SCRIPT
   * emitted for the module loader, so it cannot import the Host's modules. The two
   * copies cannot drift: `tests/unit/client.spec.ts` reads this file and fails if
   * the literal stops matching `MS_PER_DAY` in constants.
   */
  const MS_PER_DAY = 86_400_000

  /**
   * Every `<inventory name>#<row id>` spelling the page may dispatch with.
   *
   * `rowConfigKey()` is exactly `${bundle}#${rowId}`; the variable part is how
   * the plugin inventory spells the bundle (bare package name, or the
   * `include:`-wrapped Loader entry id the profile composed). Registering all
   * four is a shadowing-free duplicate — one cell per key, and only the
   * dispatched key mounts the component.
   */
  const SLOT_KEYS = [
    `${PACKAGE_NAME}#${ROW_ID}`,
    `include:${ROW_ID}#${ROW_ID}`,
    PACKAGE_NAME,
    `include:${PACKAGE_NAME}`,
  ]

  /**
   * The Config field paths edited here.
   *
   * They live under `inbound.agent` because the Host resolves the A2A model
   * from the plugin's own Config (YAML pin) before falling back to "no model".
   * The names are schema field names, not provider/model values — no vendor is
   * named anywhere in this file.
   */
  const PROVIDER_PATH: readonly string[] = ['inbound', 'agent', 'provider']
  const MODEL_PATH: readonly string[] = ['inbound', 'agent', 'model']
  /**
   * The agent-preset path: a TOP-LEVEL volatile STRING under `inbound`, not part
   * of the `agent` pair object — one preset id, not two fields. It decides which
   * execution tools an A2A session gets, so an unset value is a real defect and
   * the page must show it rather than hide it.
   */
  const AGENT_PRESET_PATH: readonly string[] = ['inbound', 'agentPreset']
  /**
   * The workspace-directory path: `inbound.isolation.workspaceRoot`.
   *
   * The Host declares this field `.volatile()`, so the settings form exposes it
   * and a write reaches the running plugin without a remount. An EMPTY string is
   * a real, meaningful value ("derive `<DSH_HOME>/a2a-workspaces`"), which is
   * why the page saves `set ''` instead of `unset`: `unset` restores whatever an
   * inherited patch layer held, and that may be a path the user just cleared.
   */
  const WORKSPACE_ROOT_PATH: readonly string[] = ['inbound', 'isolation', 'workspaceRoot']
  /**
   * Task-record settings.
   *
   * `dir` is written even when empty ('' means "derive the default"), while the two
   * retention fields are only written when non-empty — clearing them would be
   * ambiguous between "reset to default" and "leave alone", so the UI treats an
   * empty retention/cap as "do not change" and says so in the hint.
   */
  const TASK_DIR_PATH: readonly string[] = ['inbound', 'tasks', 'dir']
  const TASK_RETENTION_PATH: readonly string[] = ['inbound', 'tasks', 'retentionMs']
  const TASK_MAX_RECORDS_PATH: readonly string[] = ['inbound', 'tasks', 'maxRecords']

  /**
   * Simplified Chinese copy — the dictionary DSH's `locale` service publishes
   * under the active locale id `zh`.
   *
   * Kept in JSON SHAPE (double-quoted keys and values) on purpose: the
   * `scripts/export-client-locale.mjs` exporter parses this literal with
   * `JSON.parse` and writes `locale/zh-CN.json`, and a unit test fails when the
   * shipped JSON and this dictionary drift. Do not "tidy" the quoting.
   */
  const ZH: Record<string, string> = {
    "summary.label": "A2A 模型",
    "summary.text": "{label}：{value}",
    "summary.loading": "读取中…",
    "summary.unknown": "读取失败",
    "summary.unconfigured": "未选择模型（点击配置）",
    "summary.value": "{provider} / {model}",
    "page.title": "A2A 桥接配置",
    "page.hint": "选择 A2A 会话使用的模型。未选择时 A2A 调用会被拒绝；保存后立即生效。",
    "page.warning": "尚未选择模型，A2A 调用会被拒绝",
    "page.loading": "正在读取本机模型列表…",
    "field.provider": "模型提供方",
    "field.model": "模型",
    "option.modelPlaceholder": "请选择模型",
    "option.none": "未选择模型",
    "action.save": "保存",
    "action.saving": "保存中…",
    "action.clear": "清除选择",
    "status.saved": "已保存，下一轮 A2A 会话立即生效。",
    "status.savedForm": "已写入插件配置（profile 补丁）。",
    "status.sourcePinned": "当前来源：插件配置中的 inbound.agent（YAML 固定或本页保存）",
    "status.sourceConfig": "当前来源：插件配置（profile 补丁）",
    "status.sourceNone": "当前来源：尚未选择模型",
    "status.adoptedLegacy": "已载入当前生效的 {provider} / {model}；保存后写入插件配置（profile 补丁）。",
    "status.readOnly": "当前 profile 不可写，无法在这里保存。",
    "status.noProviders": "本机尚未配置任何模型提供方，请先在「设置 → 模型」中配置。",
    "status.noModels": "该提供方没有可用的模型，请先在「设置 → 模型」中配置。",
    "status.effectiveMismatch": "Host 报告当前生效的仍是 {provider} / {model}，与本页插件配置不一致；保存后若仍未变化，请检查 Host 的读取优先级。",
    "status.cleared": "已清除选择；A2A 调用会被拒绝，直到重新选择模型。",
    "status.formLoading": "正在读取插件配置…",
    "error.load": "读取失败：{message}",
    "error.save": "保存失败：{message}",
    "error.rejected": "Host 拒绝了这次写入（配置可能已被改动），请重试。",
    "field.agentPreset": "Agent preset（执行工具集）",
    "option.presetDefault": "使用部署默认 preset",
    "page.presetHint": "preset 决定 A2A 会话能使用哪些工具；未指定时会话只能对话、无法执行命令。选择后立即写入插件配置。",
    "status.presetSaved": "已保存 agent preset；下一个 A2A 会话立即生效。",
    "status.presetsUnavailable": "无法读取 agent preset 列表（agentPresets 服务不可用）；A2A 会话可能没有执行工具。",
    "status.presetsEmpty": "本机没有声明任何 agent preset；A2A 会话将没有执行工具。",
    "status.presetNoForm": "当前 Host 未提供可写表单，无法在这里保存 preset；请直接修改插件配置 inbound.agentPreset。",
    "field.workspaceRoot": "工作区路径",    "section.model": "会话模型与工具集",
    "section.workspace": "工作区",
    "option.taskDirPlaceholder": "留空：<DSH_HOME>/a2a-tasks",
    "option.taskRetentionPlaceholder": "留空：不修改",
    "option.taskMaxRecordsPlaceholder": "留空：不修改",
    "section.tasks": "任务记录",
    "field.taskDir": "任务记录目录",
    "field.taskRetentionDays": "保留天数",
    "field.taskMaxRecords": "最多保留条数",
    "page.tasksHint": "GetTask 跨重启查询依赖这些记录。目录留空表示使用默认 <DSH_HOME>/a2a-tasks；保留天数与条数留空表示不修改。保存后下一轮 A2A 请求生效，无需重启。",
    "action.saveTasks": "保存任务记录设置",
    "status.tasksSaved": "任务记录设置已保存；下一轮 A2A 请求生效，无需重启。",
    "status.tasksNothingToChange": "没有要写入的改动：保留天数与条数留空表示不修改，目录留空表示使用默认路径。",
    "error.taskRetention": "保留天数必须是大于 0 的整数。",
    "error.taskMaxRecords": "最多保留条数必须是大于 0 的整数。",
    "option.workspaceRootPlaceholder": "留空：<DSH_HOME>/a2a-workspaces",
    "page.workspaceHint": "A2A 会话归入同一个工作区（默认名 A2A）；留空时使用 <DSH_HOME>/a2a-workspaces。保存后写入 profile 补丁，下一轮 A2A 会话即使用新路径，无需重启。",
    "action.browse": "浏览…",
    "action.savePath": "保存路径",
    "status.workspaceSaved": "工作区路径已保存；下一轮 A2A 会话生效，无需重启。",
    "status.workspaceNoForm": "当前 Host 未提供可写表单，无法在这里保存工作区路径；请直接修改插件配置 inbound.isolation.workspaceRoot。",
    "status.pickerUnavailable": "无法使用目录选择器（directoryPicker 不可用）；仍可直接输入绝对路径。",
    "status.pickerFailed": "目录选择失败：{message}",
    "status.pickerFallback": "系统目录对话框不可用（{message}），已切换为内置浏览；也可直接粘贴绝对路径。",
    "browser.title": "选择工作区目录",
    "browser.loading": "正在读取目录…",
    "browser.error": "无法读取目录：{message}",
    "browser.up": "上一级",
    "browser.choose": "使用此目录",
    "browser.cancel": "取消",
    "browser.jump": "跳转",
    "browser.pathPlaceholder": "输入绝对路径后回车；无需逐层点击",
    "browser.truncated": "目录内容过多，仅显示一部分。",
    "browser.empty": "这个目录下没有子目录。",
    "error.invalidListing": "Host 返回了无法识别的目录列表。"
  }

  /** English copy; DSH falls back to `en` when a key is missing. Same JSON shape as {@link ZH}. */
  const EN: Record<string, string> = {
    "summary.label": "A2A model",
    "summary.text": "{label}: {value}",
    "summary.loading": "loading…",
    "summary.unknown": "unavailable",
    "summary.unconfigured": "no model selected (click to configure)",
    "summary.value": "{provider} / {model}",
    "page.title": "A2A bridge configuration",
    "page.hint": "Choose the model A2A sessions run on. Until one is selected, A2A calls are rejected; a save applies immediately.",
    "page.warning": "No model is selected — A2A calls will be rejected",
    "page.loading": "Reading this machine's model catalog…",
    "field.provider": "Provider",
    "field.model": "Model",
    "option.modelPlaceholder": "Select a model",
    "option.none": "No model selected",
    "action.save": "Save",
    "action.saving": "Saving…",
    "action.clear": "Clear selection",
    "status.saved": "Saved. The next A2A session uses it immediately.",
    "status.savedForm": "Written to the plugin configuration (profile patch).",
    "status.sourcePinned": "Source: inbound.agent in the plugin configuration (YAML pin or saved on this page)",
    "status.sourceConfig": "Source: plugin configuration (profile patch)",
    "status.sourceNone": "Source: no model selected",
    "status.adoptedLegacy": "Adopted the currently effective selection ({provider} / {model}); saving writes it into the plugin configuration (profile patch).",
    "status.readOnly": "This profile is not writable; the selection cannot be saved here.",
    "status.noProviders": "No model provider is configured on this machine. Configure one in Settings → Models first.",
    "status.noModels": "This provider advertises no models. Configure one in Settings → Models first.",
    "status.effectiveMismatch": "The Host still reports {provider} / {model} as effective, which differs from the plugin configuration on this page. If it does not change after saving, check the Host's precedence.",
    "status.cleared": "Selection cleared. A2A calls are rejected until a model is chosen again.",
    "status.formLoading": "Reading the plugin configuration…",
    "error.load": "Could not load: {message}",
    "error.save": "Could not save: {message}",
    "error.rejected": "The Host rejected this write (the configuration may have changed). Retry.",
    "field.agentPreset": "Agent preset (execution toolset)",
    "option.presetDefault": "Use the deployment default preset",
    "page.presetHint": "The preset decides which tools an A2A session gets; without one the session can only chat and cannot run commands. A choice is written to the plugin configuration immediately.",
    "status.presetSaved": "Agent preset saved; the next A2A session uses it immediately.",
    "status.presetsUnavailable": "The agent preset list could not be read (the agentPresets service is unavailable); A2A sessions may have no execution tools.",
    "status.presetsEmpty": "This machine declares no agent preset; A2A sessions will have no execution tools.",
    "status.presetNoForm": "This Host exposes no writable form, so the preset cannot be saved here; edit the plugin configuration inbound.agentPreset directly.",
    "field.workspaceRoot": "Workspace path",
    "section.model": "Session model and toolset",
    "section.workspace": "Workspace",
    "option.taskDirPlaceholder": "Empty: <DSH_HOME>/a2a-tasks",
    "option.taskRetentionPlaceholder": "Empty: unchanged",
    "option.taskMaxRecordsPlaceholder": "Empty: unchanged",
    "section.tasks": "Task records",
    "field.taskDir": "Task record directory",
    "field.taskRetentionDays": "Retention (days)",
    "field.taskMaxRecords": "Max records kept",
    "page.tasksHint": "GetTask across a restart relies on these records. Empty directory means the default <DSH_HOME>/a2a-tasks; empty retention or cap means unchanged. Saved values apply to the next A2A request — no restart needed.",
    "action.saveTasks": "Save task record settings",
    "status.tasksSaved": "Task record settings saved; they apply to the next A2A request — no restart needed.",
    "status.tasksNothingToChange": "Nothing to write: empty retention or cap means unchanged, and an empty directory means the default path.",
    "error.taskRetention": "Retention must be a whole number of days greater than 0.",
    "error.taskMaxRecords": "The record cap must be a whole number greater than 0.",
    "option.workspaceRootPlaceholder": "Empty: <DSH_HOME>/a2a-workspaces",
    "page.workspaceHint": "A2A sessions are grouped into one workspace (named A2A by default); empty means <DSH_HOME>/a2a-workspaces. A save writes the profile patch; the next A2A session uses the new path — no restart needed.",
    "action.browse": "Browse…",
    "action.savePath": "Save path",
    "status.workspaceSaved": "Workspace path saved; the next A2A session uses it — no restart needed.",
    "status.workspaceNoForm": "This Host exposes no writable form, so the workspace path cannot be saved here; edit the plugin configuration inbound.isolation.workspaceRoot directly.",
    "status.pickerUnavailable": "The directory picker is unavailable (directoryPicker is not composed); an absolute path can still be typed.",
    "status.pickerFailed": "Directory picker failed: {message}",
    "status.pickerFallback": "The system folder dialog is unavailable ({message}), so the built-in browser opened instead; you can also paste an absolute path.",
    "browser.title": "Choose a workspace directory",
    "browser.loading": "Reading the directory…",
    "browser.error": "Could not read the directory: {message}",
    "browser.up": "Up",
    "browser.choose": "Use this directory",
    "browser.cancel": "Cancel",
    "browser.jump": "Go",
    "browser.pathPlaceholder": "Type an absolute path and press Enter — no need to click down level by level",
    "browser.truncated": "The directory is large; only part of it is shown.",
    "browser.empty": "This directory has no subdirectories.",
    "error.invalidListing": "The Host returned a directory listing this page cannot read."
  }

  type Translate = (key: string, params?: Record<string, unknown>) => string
  type ProviderEntry = { provider: string; models: string[] }
  type Phase = 'loading' | 'ready' | 'error'

  /** Structural view of one config payload as the browser consumes it. */
  interface PayloadView {
    providers: ProviderEntry[]
    provider: string
    model: string
    source: 'pinned' | 'none'
    /** False means A2A refuses every call until a model is picked. */
    configured: boolean
    /** Agent preset ids this deployment declares (the picker's options). */
    presets: string[]
    /**
     * False means the roster could not be read at all. The page must say
     * "unavailable", never "this deployment has none": the two lead an operator
     * to completely different fixes (compose the service vs. declare a preset).
     */
    presetsAvailable: boolean
  }

  /** The catalog probe's state, separate from the persisted selection. */
  interface CatalogState {
    phase: Phase
    providers: ProviderEntry[]
    message: string
  }

  /** One provider/model pair, either persisted or being edited. */
  interface Selection {
    provider: string
    model: string
  }

  /**
   * `ConfigPageForm.state` — the snapshot `ConfigFormController.getSnapshot()`
   * hands the row page (`status`/`value`/`revision`/`writable`).
   */
  interface FormSnapshot {
    status?: string
    value?: unknown
    revision?: number
    writable?: boolean
  }

  /** One path-addressed edit accepted by `settings.mutate` / `ConfigForm.mutate`. */
  interface FormWriteOp {
    op: 'set' | 'unset'
    path: readonly string[]
    value?: unknown
  }

  /** The owner-prop `form` the Plugins page passes (optional by contract). */
  interface ConfigPageFormLike {
    state?: FormSnapshot
    mutate?: (ops: readonly FormWriteOp[], revision?: number) => Promise<unknown>
  }

  /**
   * One directory entry as the browse listing returns it.
   *
   * VERIFIED against `@deepseek-ai/dsh-host-directory-picker` types: the browse
   * backend returns only ENTERABLE child directories, so this page can treat
   * every entry as a jump target (unlike a general file listing).
   */
  interface DirectoryEntry {
    name: string
    path: string
    hidden: boolean
  }

  /** One directory level plus its ancestry, as `directoryPicker.list()` answers. */
  interface DirectoryListing {
    path: string
    home: string
    crumbs: DirectoryEntry[]
    entries: DirectoryEntry[]
    truncated: boolean
  }

  /** The inline browser panel's state (open even while loading). */
  interface BrowserState {
    open: boolean
    phase: 'idle' | 'loading' | 'ready' | 'error'
    listing: DirectoryListing | undefined
    message: string
  }

  /**
   * Result envelope of the generated Remote namespace.
   *
   * VERIFIED against `dsh-client-ui-workspace` (its `pickDirectory()`/
   * `listDirectory()` read `result.ok` / `result.value` / `result.error`):
   * Remote calls never throw the business failure into the caller; they answer
   * `{ ok: false, error }`. A transport failure still rejects, so both paths are
   * handled.
   */
  type RemoteResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: { message?: string } }

  /**
   * The slice of `ctx.remote.directoryPicker` this page uses.
   *
   * Both verbs are OPTIONAL: a native backend serves `pick` only, a browse
   * backend serves `list` only, and a profile may compose neither. The page
   * degrades to the text input instead of inventing a chooser.
   */
  interface DirectoryPickerLike {
    pick?: () => Promise<RemoteResult<string | null>>
    list?: (path?: string) => Promise<RemoteResult<DirectoryListing>>
  }

  /** Coerce a `list()` value into the shape this page renders; anything else is a failure. */
  function adoptListing(value: unknown): DirectoryListing | undefined {
    if (!isRecord(value) || typeof value.path !== 'string') return undefined
    const crumbs: DirectoryEntry[] = []
    if (Array.isArray(value.crumbs)) {
      for (const crumb of value.crumbs) {
        if (isRecord(crumb) && typeof crumb.name === 'string' && typeof crumb.path === 'string') {
          crumbs.push({ name: crumb.name, path: crumb.path, hidden: crumb.hidden === true })
        }
      }
    }
    const entries: DirectoryEntry[] = []
    if (Array.isArray(value.entries)) {
      for (const entry of value.entries) {
        if (isRecord(entry) && typeof entry.name === 'string' && typeof entry.path === 'string') {
          entries.push({ name: entry.name, path: entry.path, hidden: entry.hidden === true })
        }
      }
    }
    return {
      path: value.path,
      home: typeof value.home === 'string' ? value.home : '',
      crumbs,
      entries,
      truncated: value.truncated === true,
    }
  }

  /** Operator-facing text for a Remote failure (falls back to `String(error)`). */
  function remoteMessage(error: unknown): string {
    return isRecord(error) && typeof error.message === 'string'
      ? error.message
      : describeError(error)
  }

  /** Stringify anything thrown by `fetch`/`JSON` without leaking a stack. */
  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  /** Read `value.inbound.agent.provider` (or any fixed path) without throwing. */
  function stringAt(value: unknown, keys: readonly string[]): string {
    let node: unknown = value
    for (const key of keys) {
      if (!isRecord(node)) return ''
      node = node[key]
    }
    return typeof node === 'string' ? node : ''
  }

  /**
   * Same walk as `stringAt`, but for a NUMERIC field, rendered as text.
   *
   * The task retention and record cap are numbers in the schema; reusing
   * `stringAt` would read every one of them as '' and the form would look unset on
   * every open — the exact "explicit value reads as missing" trap this file has
   * hit before with volatile fields.
   */
  function numberTextAt(value: unknown, keys: readonly string[]): string {
    let node: unknown = value
    for (const key of keys) {
      if (!isRecord(node)) return ''
      node = node[key]
    }
    return typeof node === 'number' && Number.isFinite(node) ? String(node) : ''
  }

  /**
   * Milliseconds-as-text → whole days-as-text, for the retention field.
   *
   * Returns '' for anything unusable so the input shows empty rather than `NaN`.
   */
  function daysOf(millisecondsText: string): string {
    const milliseconds = Number.parseFloat(millisecondsText)
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return ''
    return String(Math.round(milliseconds / MS_PER_DAY))
  }

  /**
   * Coerce the Host's answer. The server is trusted, but a shape change must
   * degrade to an empty form rather than crash the whole Plugins page.
   */
  function adoptPayload(payload: unknown): PayloadView {
    const record = isRecord(payload) ? payload : {}

    const providers: ProviderEntry[] = []
    if (Array.isArray(record.providers)) {
      for (const entry of record.providers) {
        if (!isRecord(entry)) continue
        if (typeof entry.provider !== 'string' || entry.provider.length === 0) continue
        const models: string[] = []
        if (Array.isArray(entry.models)) {
          for (const model of entry.models) {
            if (typeof model === 'string' && model.length > 0) models.push(model)
          }
        }
        providers.push({ provider: entry.provider, models })
      }
    }

    const presets: string[] = []
    if (Array.isArray(record.presets)) {
      for (const preset of record.presets) {
        if (typeof preset === 'string' && preset.length > 0) presets.push(preset)
      }
    }

    return {
      providers,
      provider: typeof record.provider === 'string' ? record.provider : '',
      model: typeof record.model === 'string' ? record.model : '',
      source: record.source === 'pinned' ? 'pinned' : 'none',
      // Absent/false is the safe reading: an older Host that does not send the
      // flag is assumed unconfigured, so the warning shows rather than a
      // silently dead bridge.
      configured: record.configured === true,
      presets,
      presetsAvailable: record.presetsAvailable === true,
    }
  }

  /** One GET/POST against the Host route. Non-2xx carries the server's own text. */
  async function requestConfig(init: {
    method: 'GET' | 'POST'
    body?: unknown
  }): Promise<unknown> {
    // Typed structurally rather than through `typeof fetch`: the project's
    // `lib` is ES2024 (no DOM), and `@types/node`'s fetch signature is not
    // something a browser bundle should depend on.
    const fetchFn = (
      globalThis as unknown as {
        fetch?: (
          input: string,
          init?: Record<string, unknown>,
        ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
      }
    ).fetch
    if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable')

    const response = await fetchFn(CONFIG_ENDPOINT, {
      method: init.method,
      // `cache: 'no-store'` matters: a cached GET after a save would show the
      // OLD selection while the Host already runs the new one.
      cache: 'no-store',
      credentials: 'same-origin',
      headers: init.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: init.method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined,
    })

    const text = await response.text()
    let payload: unknown
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      const detail =
        isRecord(payload) && typeof payload.error === 'string'
          ? String(payload.error)
          : `HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isRecord(payload)) throw new Error('unexpected response from the Host')
    return payload
  }

  /**
   * Read the Host-owned values from the slot's `form` prop.
   *
   * Returns `undefined` while the form is still loading or unavailable, so the
   * view can keep showing the catalog/effective values instead of flashing
   * "unconfigured". Only `status === 'ready'` carries a validated `value`.
   */
  function readFormSelection(form: ConfigPageFormLike | undefined): Selection | undefined {
    const state = form?.state
    if (state === undefined || state.status !== 'ready') return undefined
    return {
      provider: stringAt(state.value, [...PROVIDER_PATH]),
      model: stringAt(state.value, [...MODEL_PATH]),
    }
  }

  /**
   * Write through `ConfigPageForm.mutate`.
   *
   * `mutate` resolves `false` when the Host refused the edit after recovering its
   * mirror — the documented case is a revision conflict.
   *
   * WHY THE ARGUMENT IS OMITTED WHEN UNKNOWN: passing `undefined` explicitly is not
   * the same as not passing it. A strict compare-and-set reads an explicit
   * `undefined` as "revision 0", which never matches, so EVERY save is rejected with
   * the generic conflict message — exactly the symptom reported in the field. When
   * this page has no numeric revision to assert, the correct request is to omit the
   * argument and let the Host apply the write without an optimistic check.
   *
   * A single retry stays: `false` means the Host already recovered its mirror, and
   * every op this page writes is an idempotent `set`/`unset`, so re-applying cannot
   * double anything.
   */
  async function mutateForm(
    form: ConfigPageFormLike | undefined,
    ops: readonly FormWriteOp[],
  ): Promise<boolean> {
    // Bridge route first: form.mutate's wrapper fills in form.state.revision (0),
    // making every write CONDITIONAL. The bridge route calls
    // ctx.settings.mutate(ns, ops, undefined) — the unconditional write path.
    // On failure the error is SURFACED (not swallowed by a silent fallback).
    try {
      const response = await fetch('/a2a-bridge/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      })
      if (response.ok) return true
      const body = (await response.json().catch(() => ({}))) as { message?: string }
      throw new Error(`bridge write failed (HTTP ${response.status}): ${body.message ?? 'no detail'}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('bridge write failed')) throw error
      // Network error (bridge unavailable) — fall through to form.mutate.
    }
    if (form === undefined || typeof form.mutate !== 'function') {
      throw new Error('form.mutate is unavailable')
    }
    return (await form.mutate(ops, form.state?.revision)) !== false
  }

  /**
   * Build the component around the host's React instance.
   *
   * `React.createElement` is used instead of JSX on purpose: this project's
   * `tsconfig` has no `jsx` setting, and adding one just to compile this file
   * would change the host build's semantics.
   */
  function createConfigView(React: any): any {
    const h = React.createElement

    // Host theme tokens only: literal colors would stop following
    // light/dark and would drift from the Plugin Manager page.
    const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary)'
    const TEXT_TERTIARY = 'var(--dsw-alias-label-tertiary)'
    const TEXT_PRIMARY = 'var(--dsw-alias-label-primary)'
    const ERROR_TEXT = 'var(--dsw-alias-state-error-primary)'
    const WARN_TEXT = 'var(--dsw-alias-state-warn-label)'
    const WARN_FILL = 'var(--dsw-alias-state-warn-tertiary)'
    const WARN_STROKE = 'var(--dsw-alias-state-warn-secondary)'
    const BORDER = 'var(--dsw-alias-border-l4)'
    const BORDER_MUTED = 'var(--dsw-alias-border-l3)'
    const CONTROL_FILL = 'var(--dsw-alias-bg-layer-1)'
    const PRIMARY_FILL = 'var(--dsw-alias-button-primary-fill)'
    const PRIMARY_TEXT = 'var(--dsw-alias-label-primary-foreground)'
    const RADIUS_MD = 'var(--dsw-radius-md)'
    const RADIUS_SM = 'var(--dsw-radius-sm)'

    // Font weights are PAGE-LOCAL typography, not theme tokens: the Harness
    // theme publishes colour / radius / spacing aliases but no weight scale, so
    // these two numbers have no upstream name to borrow. They are named here
    // (instead of inline) because a bare `600` in a style object is
    // indistinguishable from a protocol number during review.
    const FONT_WEIGHT_HEADING = 500
    const FONT_WEIGHT_BANNER = 600

    /** Native select styled like the host's Input/Button primitives (copied tokens, not the package). */
    const controlStyle = {
      boxSizing: 'border-box',
      height: '32px',
      padding: '0 8px',
      border: `0.5px solid ${BORDER}`,
      borderRadius: RADIUS_MD,
      background: CONTROL_FILL,
      color: TEXT_PRIMARY,
      fontSize: '14px',
      lineHeight: '22px',
      fontFamily: 'inherit',
    } as const

    const primaryButtonStyle = (enabled: boolean): Record<string, unknown> => ({
      boxSizing: 'border-box',
      height: '28px',
      padding: '0 10px',
      border: 'none',
      borderRadius: RADIUS_SM,
      background: PRIMARY_FILL,
      color: PRIMARY_TEXT,
      fontSize: '12px',
      lineHeight: '18px',
      cursor: enabled ? 'pointer' : 'not-allowed',
      opacity: enabled ? 1 : 0.4,
    })

    const outlineButtonStyle = (enabled: boolean): Record<string, unknown> => ({
      boxSizing: 'border-box',
      height: '28px',
      padding: '0 10px',
      border: `0.5px solid ${BORDER_MUTED}`,
      borderRadius: RADIUS_SM,
      background: 'transparent',
      color: TEXT_PRIMARY,
      fontSize: '12px',
      lineHeight: '18px',
      cursor: enabled ? 'pointer' : 'not-allowed',
      opacity: enabled ? 1 : 0.4,
    })

    /** Minimal labelled form field. */
    const field = (id: string, label: string, control: any): any =>
      h(
        'div',
        { style: { display: 'grid', gap: '6px' } },
        h(
          'label',
          { htmlFor: id, style: { fontSize: '12px', lineHeight: '18px', color: TEXT_SECONDARY } },
          label,
        ),
        control,
      )

    /**
     * Group heading inside one page.
     *
     * The page now edits three independent decisions (model pair, preset,
     * workspace path), each with its own write; a heading keeps each control
     * beside the save action that commits it.
     */
    const sectionHeading = (label: string): any =>
      h(
        'h5',
        {
          style: {
            margin: '4px 0 0',
            fontSize: '13px',
            lineHeight: '20px',
            fontWeight: FONT_WEIGHT_HEADING,
            color: TEXT_SECONDARY,
          },
        },
        label,
      )

    const option = (value: string, label: string): any =>
      h('option', { value, key: value.length === 0 ? '__empty' : value }, label)

    /** Small informational line; `tone` selects the host token for errors. */
    const note = (text: string, tone: 'muted' | 'error' = 'muted', testId?: string): any =>
      h(
        'p',
        {
          ...(testId === undefined ? {} : { [testId]: true }),
          style: {
            margin: 0,
            fontSize: '12px',
            lineHeight: '18px',
            color: tone === 'error' ? ERROR_TEXT : TEXT_SECONDARY,
          },
        },
        text,
      )

    /** Warning banner: unconfigured state or a legacy selection shadowing the form. */
    const banner = (text: string, testId: string): any =>
      h(
        'p',
        {
          role: 'alert',
          [testId]: true,
          style: {
            margin: 0,
            padding: '8px 10px',
            borderRadius: RADIUS_MD,
            fontSize: '12px',
            lineHeight: '18px',
            fontWeight: FONT_WEIGHT_BANNER,
            color: WARN_TEXT,
            background: WARN_FILL,
            border: `0.5px solid ${WARN_STROKE}`,
          },
        },
        text,
      )

    function ConfigView(props: any): any {
      // `props.t` is provided by the slot's `locale` option (and mirrored by
      // `ctx.locale.bind`'s stable function); the fallback keeps a raw key from
      // surfacing as `undefined` if an older host omits it.
      const t: Translate = typeof props?.t === 'function' ? props.t : (key: string) => key
      const isPage = props?.view === 'page'

      const form = props?.form as ConfigPageFormLike | undefined
      const hasForm = form !== undefined && form !== null

      const initialCatalog: CatalogState = { phase: 'loading', providers: [], message: '' }
      // `React` is untyped here (the browser module has no .d.ts in this
      // project), so the state types are carried by the annotated initial
      // values instead of `useState<...>` type arguments.
      const [catalog, setCatalog] = React.useState(initialCatalog)
      const [effective, setEffective] = React.useState({
        provider: '',
        model: '',
        source: 'none' as 'pinned' | 'none',
        configured: false,
      })
      const [draft, setDraft] = React.useState({ provider: '', model: '' })
      /**
       * The agent preset is edited SEPARATELY from provider/model.
       *
       * It is a different Config field with its own immediate write, so folding
       * it into the model's save would make one click commit two unrelated
       * decisions — and "clear selection" would silently drop the toolset too.
       */
      const [preset, setPreset] = React.useState('')
      const [presets, setPresets] = React.useState({ ids: [] as string[], available: false })
      const [saving, setSaving] = React.useState(false)
      const [status, setStatus] = React.useState({ tone: 'idle' as 'idle' | 'ok' | 'error', text: '' })
      // Set when the form config was empty but the bridge already had an
      // effective selection; the value was copied into the draft so the user
      // sees (and can migrate) what A2A actually runs.
      const [adoptedLegacy, setAdoptedLegacy] = React.useState(
        undefined as Selection | undefined,
      )
      // Bumped after a form write so the catalog/effective read refreshes.
      const [reloadToken, setReloadToken] = React.useState(0)
      // Invalidates an in-flight `list()` when the user navigates or closes.
      const browserGeneration = React.useRef(0)
      /** Workspace-root draft; '' is the "derive the default" value, not "missing". */
      const [workspaceRoot, setWorkspaceRoot] = React.useState('')
      /** Task-record drafts. Retention is entered in DAYS; the schema stores ms. */
      const [taskDir, setTaskDir] = React.useState('')
      const [taskRetentionDays, setTaskRetentionDays] = React.useState('')
      const [taskMaxRecords, setTaskMaxRecords] = React.useState('')
      /**
       * Which path field the OS picker / inline browser is currently filling.
       *
       * Both fields open the SAME picker: duplicating the ~40-line pick fallback
       * chain per field would guarantee they drift, and a user who learned one
       * button would face a different behaviour on the other.
       */
      // `React` arrives as a parameter of the module factory (untyped), so a
      // generic argument is not allowed here; the annotation is applied instead.
      const pickerTarget = React.useRef('workspace') as { current: 'workspace' | 'tasks' }
      const applyPickedPath = (path: string): void => {
        if (pickerTarget.current === 'tasks') setTaskDir(path)
        else setWorkspaceRoot(path)
      }
      /** Inline browse panel: used when the native chooser is not composed. */
      const [browser, setBrowser] = React.useState({
        open: false,
        phase: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
        listing: undefined as DirectoryListing | undefined,
        message: '',
      })
      /**
       * Path typed into the browse panel to jump straight to a directory.
       *
       * The host mounts the `browse` backend (not the OS chooser) whenever remote
       * authorities are allowed, which is the normal Desktop composition. Walking
       * eight levels of a home directory to reach a known path is the thing that
       * makes that panel feel useless, so the panel takes a path directly.
       */
      const [browserPathDraft, setBrowserPathDraft] = React.useState('')

      // Guards a late response from writing into an unmounted component (the
      // Plugins page unmounts the detail panel on navigation).
      const alive = React.useRef(true)
      // The translator is stable in practice, but keeping it out of the
      // effect's dependency list means a host that re-binds `t` per render
      // cannot turn the catalog probe into an update loop. Reads always see
      // the latest binding.
      const translate = React.useRef(t)
      translate.current = t
      // Resolved per render through a getter supplied by `apply` (which wraps
      // `ctx.get`): the Remote namespace may mount after this plugin, and a
      // profile may compose no directory picker at all. Never captured once at
      // registration time, or a late mount would look permanently unavailable.
      const directoryPicker: DirectoryPickerLike | undefined =
        typeof props?.directoryPicker === 'function' ? props.directoryPicker() : undefined

      // ── Runtime catalog probe (T3) ───────────────────────────────────────
      // Providers and models are whatever THIS Host's `ctx.llm` reports. The
      // browser never invents a vendor or model name; a deployment with no
      // provider simply renders an empty picker plus an explanation.
      React.useEffect(() => {
        alive.current = true
        setCatalog((previous: CatalogState) => ({ ...previous, phase: 'loading', message: '' }))
        requestConfig({ method: 'GET' }).then(
          (payload) => {
            if (!alive.current) return
            const adopted = adoptPayload(payload)
            setCatalog({ phase: 'ready', providers: adopted.providers, message: '' })
            setPresets({ ids: adopted.presets, available: adopted.presetsAvailable })
            setEffective({
              provider: adopted.provider,
              model: adopted.model,
              source: adopted.source,
              configured: adopted.configured,
            })
            // Without a form, the bridge's own payload is the value source.
            // With one, the draft is owned by the form sync effect below so a
            // late catalog response cannot clobber what the Host just wrote.
            if (!hasForm) setDraft({ provider: adopted.provider, model: adopted.model })
          },
          (error: unknown) => {
            if (!alive.current) return
            setCatalog((previous: CatalogState) => ({
              ...previous,
              phase: 'error',
              message: translate.current('error.load', { message: describeError(error) }),
            }))
          },
        )
        return () => {
          alive.current = false
        }
      }, [hasForm, reloadToken])

      // ── Form-derived selection (T2) ──────────────────────────────────────
      const formSelection = hasForm ? readFormSelection(form) : undefined
      const formReady = hasForm && form?.state?.status === 'ready'
      const formWritable = !hasForm || form?.state?.writable !== false
      const formRevision = form?.state?.revision
      const formProvider = formSelection === undefined ? '' : formSelection.provider
      const formModel = formSelection === undefined ? '' : formSelection.model

      // Adopt the Host's values when the form first becomes ready and after
      // every accepted write (the revision moves). While the user is editing,
      // none of these dependencies change, so their draft is not reset.
      React.useEffect(() => {
        if (formSelection === undefined) return
        setDraft({ provider: formProvider, model: formModel })
      }, [formReady, formProvider, formModel, formRevision])

      // The preset is read from the FORM, never from the bridge payload: `form`
      // is the supported write channel, and taking the same value from two
      // sources would let the page show one preset while the Host stores
      // another.
      const formPreset = hasForm ? stringAt(form?.state?.value, [...AGENT_PRESET_PATH]) : ''
      React.useEffect(() => {
        if (!formReady) return
        setPreset(formPreset)
      }, [formReady, formPreset, formRevision])

      // The workspace root is a third independent field with its own save
      // button: a text field cannot commit on every keystroke, and folding it
      // into the model save would commit two unrelated decisions at once.
      const formWorkspaceRoot = hasForm ? stringAt(form?.state?.value, [...WORKSPACE_ROOT_PATH]) : ''
      const storedWorkspaceRoot = React.useRef(formWorkspaceRoot)
      React.useEffect(() => {
        if (!formReady) return
        if (formWorkspaceRoot === storedWorkspaceRoot.current) return
        // Adopt external/saved changes, but never clobber an unsaved edit when
        // another field (the preset) bumps the revision.
        const edited = workspaceRoot !== storedWorkspaceRoot.current
        storedWorkspaceRoot.current = formWorkspaceRoot
        if (!edited) setWorkspaceRoot(formWorkspaceRoot)
      }, [formReady, formWorkspaceRoot, formRevision])

      // Adopt external/saved changes on the same rule as the workspace root, but
      // tracked per field: retention arrives in MILLISECONDS from the form and is
      // shown in DAYS, so an unguarded two-way sync would convert back and forth
      // on every revision bump and drift.
      const formTaskDir = hasForm ? stringAt(form?.state?.value, [...TASK_DIR_PATH]) : ''
      const formTaskRetention = hasForm ? numberTextAt(form?.state?.value, [...TASK_RETENTION_PATH]) : ''
      const formTaskMaxRecords = hasForm ? numberTextAt(form?.state?.value, [...TASK_MAX_RECORDS_PATH]) : ''
      const storedTasks = React.useRef({
        dir: formTaskDir,
        retention: formTaskRetention,
        maxRecords: formTaskMaxRecords,
      })
      React.useEffect(() => {
        if (!formReady) return
        const previous = storedTasks.current
        if (
          previous.dir === formTaskDir &&
          previous.retention === formTaskRetention &&
          previous.maxRecords === formTaskMaxRecords
        ) {
          return
        }
        const editedDir = taskDir !== previous.dir
        const editedRetention = taskRetentionDays !== daysOf(previous.retention)
        const editedMaxRecords = taskMaxRecords !== previous.maxRecords
        storedTasks.current = {
          dir: formTaskDir,
          retention: formTaskRetention,
          maxRecords: formTaskMaxRecords,
        }
        if (!editedDir) setTaskDir(formTaskDir)
        if (!editedRetention) setTaskRetentionDays(daysOf(formTaskRetention))
        if (!editedMaxRecords) setTaskMaxRecords(formTaskMaxRecords)
      }, [formReady, formTaskDir, formTaskRetention, formTaskMaxRecords, formRevision])
      // the page never hides the model A2A actually runs. Saving then moves the
      // pair into the standard channel; nothing is written twice.
      const adoptedOnce = React.useRef(false)
      React.useEffect(() => {
        if (adoptedOnce.current || !formReady) return
        if (formProvider.length > 0 || formModel.length > 0) return
        if (effective.source !== 'pinned') return
        if (effective.provider.length === 0 || effective.model.length === 0) return
        adoptedOnce.current = true
        const legacy = { provider: effective.provider, model: effective.model }
        setDraft(legacy)
        setAdoptedLegacy(legacy)
      }, [
        formReady,
        formProvider,
        formModel,
        effective.source,
        effective.provider,
        effective.model,
      ])

      const providers = catalog.providers
      const activeProvider = providers.find((entry) => entry.provider === draft.provider)
      // Copy: the code below may append the effective value, and mutating a
      // value that lives in state would be a render-order landmine.
      const models = activeProvider === undefined ? [] : [...activeProvider.models]

      const providerValues = providers.map((entry) => entry.provider)
      // A pinned provider may be absent from this catalog (or the catalog may
      // have degraded); keep the effective value visible instead of letting
      // the select fall back to its first option.
      if (draft.provider.length > 0 && !providerValues.includes(draft.provider)) {
        providerValues.push(draft.provider)
      }
      if (draft.model.length > 0 && !models.includes(draft.model)) models.push(draft.model)

      const pinned = draft.provider.length > 0 && draft.model.length > 0
      const configuredNow = hasForm ? pinned : effective.configured
      const catalogLoading = catalog.phase === 'loading'
      const catalogFailed = catalog.phase === 'error'

      // Which persistence path this render actually uses — surfaced as a DOM
      // attribute so the behavior can be verified without reading state.
      const channel = hasForm ? 'form' : 'bridge'

      // ── Save / clear ─────────────────────────────────────────────────────
      const save = (): void => {
        if (saving || !formWritable || draft.provider.length === 0 || draft.model.length === 0) return
        const provider = draft.provider
        const model = draft.model
        setSaving(true)
        setStatus({ tone: 'idle', text: '' })

        const done = (message: string): void => {
          if (!alive.current) return
          setStatus({ tone: 'ok', text: message })
          setSaving(false)
          setAdoptedLegacy(undefined)
        }
        const fail = (error: unknown): void => {
          if (!alive.current) return
          setStatus({ tone: 'error', text: t('error.save', { message: describeError(error) }) })
          setSaving(false)
        }

        if (hasForm) {
          // Standard channel: one atomic mutation of the volatile fields. The
          // Host writes the profile patch and re-applies the config; there is
          // no private file involved.
          mutateForm(form, [
            { op: 'set', path: PROVIDER_PATH, value: provider },
            { op: 'set', path: MODEL_PATH, value: model },
          ]).then(
            (accepted) => {
              if (!accepted) {
                fail(new Error(t('error.rejected')))
                return
              }
              // Re-read so a Host that still prefers another source can be
              // reported instead of showing a misleading "saved".
              setReloadToken((value: number) => value + 1)
              done(t('status.savedForm'))
            },
            fail,
          )
          return
        }

        requestConfig({ method: 'POST', body: { provider, model } }).then(
          (payload) => {
            if (!alive.current) return
            const adopted = adoptPayload(payload)
            setCatalog({ phase: 'ready', providers: adopted.providers, message: '' })
            setPresets({ ids: adopted.presets, available: adopted.presetsAvailable })
            setEffective({
              provider: adopted.provider,
              model: adopted.model,
              source: adopted.source,
              configured: adopted.configured,
            })
            setDraft({ provider: adopted.provider, model: adopted.model })
            done(t('status.saved'))
          },
          fail,
        )
      }

      const clear = (): void => {
        if (saving || !formWritable) return
        setSaving(true)
        setStatus({ tone: 'idle', text: '' })
        setDraft({ provider: '', model: '' })

        const done = (): void => {
          if (!alive.current) return
          setStatus({ tone: 'ok', text: t('status.cleared') })
          setSaving(false)
          setAdoptedLegacy(undefined)
        }
        const fail = (error: unknown): void => {
          if (!alive.current) return
          setStatus({ tone: 'error', text: t('error.save', { message: describeError(error) }) })
          setSaving(false)
        }

        if (hasForm) {
          // `unset` removes the two volatile fields (restoring any inherited
          // value); a half-set pair is deliberately not expressible here.
          mutateForm(form, [
            { op: 'unset', path: PROVIDER_PATH },
            { op: 'unset', path: MODEL_PATH },
          ]).then(
            (accepted) => {
              if (!accepted) {
                fail(new Error(t('error.rejected')))
                return
              }
              setReloadToken((value: number) => value + 1)
              done()
            },
            fail,
          )
          return
        }

        requestConfig({ method: 'POST', body: { provider: '', model: '' } }).then(
          (payload) => {
            if (!alive.current) return
            const adopted = adoptPayload(payload)
            setEffective({
              provider: adopted.provider,
              model: adopted.model,
              source: adopted.source,
              configured: adopted.configured,
            })
            setDraft({ provider: '', model: '' })
            done()
          },
          fail,
        )
      }

      /**
       * Persist the agent preset immediately.
       *
       * There is no separate save button on purpose: one preset id is one
       * decision, and folding it into the model's save would make a single click
       * commit two unrelated values (and "clear selection" would drop the
       * toolset as a side effect).
       *
       * The bridge route has no field for this value, so the form channel is the
       * ONLY writer; without it the control stays disabled and says why.
       */
      const choosePreset = (next: string): void => {
        if (saving || !hasForm || !formWritable) return
        setPreset(next)
        setSaving(true)
        setStatus({ tone: 'idle', text: '' })
        mutateForm(form, [
          next.length === 0
            ? { op: 'unset', path: AGENT_PRESET_PATH }
            : { op: 'set', path: AGENT_PRESET_PATH, value: next },
        ]).then(
          (accepted) => {
            if (!alive.current) return
            setSaving(false)
            if (!accepted) {
              setStatus({ tone: 'error', text: t('error.rejected') })
              return
            }
            // Re-read so the form's mirror (and the revision) is authoritative.
            setReloadToken((value: number) => value + 1)
            setStatus({ tone: 'ok', text: t('status.presetSaved') })
          },
          (error: unknown) => {
            if (!alive.current) return
            setSaving(false)
            setStatus({ tone: 'error', text: t('error.save', { message: describeError(error) }) })
          },
        )
      }

      // ── Workspace root (task-7) ───────────────────────────────────────────
      const workspaceDirty = workspaceRoot.trim() !== formWorkspaceRoot.trim()
      const pickerAvailable =
        directoryPicker !== undefined &&
        (typeof directoryPicker.pick === 'function' || typeof directoryPicker.list === 'function')

      /**
       * List one directory level in the inline panel.
       *
       * This is the fallback interaction for a browse-only composition (a
       * remote page cannot reach an OS chooser). `list()` is the ONLY data
       * source; the page never derives entries from another plugin's DOM.
       */
      const openBrowser = (path?: string, target: 'workspace' | 'tasks' = 'workspace'): void => {
        pickerTarget.current = target
        if (directoryPicker === undefined || typeof directoryPicker.list !== 'function') {
          setStatus({ tone: 'error', text: t('status.pickerUnavailable') })
          return
        }
        // Rapid navigation must not let an older listing overwrite a newer one.
        const generation = browserGeneration.current + 1
        browserGeneration.current = generation
        setBrowser((previous: BrowserState) => ({
          ...previous,
          open: true,
          phase: 'loading',
          message: '',
        }))
        directoryPicker.list(path).then(
          (result) => {
            if (!alive.current || browserGeneration.current !== generation) return
            if (result?.ok === true) {
              const listing = adoptListing(result.value)
              if (listing !== undefined) {
                setBrowser({ open: true, phase: 'ready', listing, message: '' })
                setBrowserPathDraft(listing.path)
                return
              }
            }
            const message =
              result?.ok === false
                ? remoteMessage(result.error)
                : t('error.invalidListing')
            setBrowser((previous: BrowserState) => ({
              ...previous,
              phase: 'error',
              message: t('browser.error', { message }),
            }))
          },
          (error: unknown) => {
            if (!alive.current || browserGeneration.current !== generation) return
            setBrowser((previous: BrowserState) => ({
              ...previous,
              phase: 'error',
              message: t('browser.error', { message: describeError(error) }),
            }))
          },
        )
      }

      /**
       * The DSH Desktop native chooser hook, when this page runs inside it.
       *
       * On Windows the desktop shell does NOT compose the `native` directory-picker
       * backend (see `dsh-plugin-desktop`'s profile builder: win32 disables the auto
       * selector and mounts `browse`). Instead it installs a renderer global —
       * `window.__DSH_DESKTOP_PICK_DIRECTORY__` — that calls Electron's
       * `dialog.showOpenDialog({ properties: ['openDirectory'] })` from the main
       * process. That is why the Harness's own "add workspace" flow shows a real
       * Windows folder dialog while `directoryPicker.pick()` is refused here.
       *
       * Reading it directly is deliberate and matches what the official browse
       * surface does (`dsh-client-ui-directory-picker-browse`: `pickNativeDirectory`).
       * It is a plain function on the renderer global, not a slot prop, so any plugin
       * page may use it.
       */
      const nativeDesktopPick = (): Promise<string | null> | undefined => {
        const hook = (globalThis as { __DSH_DESKTOP_PICK_DIRECTORY__?: unknown })
          .__DSH_DESKTOP_PICK_DIRECTORY__
        if (typeof hook !== 'function') return undefined
        try {
          return (hook as () => Promise<string | null>)()
        } catch {
          return undefined
        }
      }

      /**
       * "Browse…": prefer a real OS chooser, fall back to `list()`.
       *
       * Order matters and each step is a DIFFERENT channel:
       *   1. the desktop shell's renderer hook (Windows/macOS desktop app) — this is
       *      the only one that can raise an OS dialog on a `browse` composition;
       *   2. `directoryPicker.pick()` — the host `native` backend, used when the
       *      profile really composes it (plain browser / Linux with a chooser);
       *   3. the in-app browser panel — the universal fallback.
       *
       * The previous version started at (2), so on Windows it always hit a refused
       * `pick` and silently degraded to the panel with no explanation.
       */
      const pickDirectory = (target: 'workspace' | 'tasks'): void => {
        if (saving || !hasForm || !formWritable || !formReady) return
        pickerTarget.current = target
        setStatus({ tone: 'idle', text: '' })
        const current = target === 'tasks' ? taskDir : workspaceRoot
        const startPath = current.trim().length > 0 ? current.trim() : undefined

        // (1) Desktop shell hook: available even when only `browse` is composed.
        const native = nativeDesktopPick()
        if (native !== undefined) {
          setStatus({ tone: 'idle', text: '' })
          native.then(
            (path) => {
              if (!alive.current) return
              if (typeof path === 'string' && path.length > 0) applyPickedPath(path)
              // A cancelled dialog is not an error.
            },
            (error: unknown) => {
              if (!alive.current) return
              setStatus({
                tone: 'error',
                text: t('status.pickerFailed', { message: describeError(error) }),
              })
            },
          )
          return
        }

        // (2) Host-side native backend.
        const picker = directoryPicker
        if (picker === undefined || typeof picker.pick !== 'function') {
          if (picker === undefined || typeof picker.list !== 'function') {
            setStatus({ tone: 'error', text: t('status.pickerUnavailable') })
            return
          }
          openBrowser(startPath, target)
          return
        }
        picker.pick().then(
          (result) => {
            if (!alive.current) return
            if (result?.ok === true) {
              if (typeof result.value === 'string' && result.value.length > 0) {
                applyPickedPath(result.value)
              }
              return
            }
            // (3) In-app panel. Say WHY, instead of swapping the interaction silently.
            if (typeof picker.list === 'function') {
              setStatus({
                tone: 'idle',
                text: t('status.pickerFallback', {
                  message:
                    result?.ok === false ? remoteMessage(result.error) : t('summary.unknown'),
                }),
              })
              openBrowser(startPath, target)
              return
            }
            setStatus({
              tone: 'error',
              text: t('status.pickerFailed', {
                message: result?.ok === false ? remoteMessage(result.error) : t('summary.unknown'),
              }),
            })
          },
          (error: unknown) => {
            if (!alive.current) return
            if (typeof picker.list === 'function') {
              setStatus({
                tone: 'idle',
                text: t('status.pickerFallback', { message: describeError(error) }),
              })
              openBrowser(startPath, target)
              return
            }
            setStatus({
              tone: 'error',
              text: t('status.pickerFailed', { message: describeError(error) }),
            })
          },
        )
      }

      /**
       * Persist the workspace root.
       *
       * `set ''` on purpose (see {@link WORKSPACE_ROOT_PATH}): the Host treats an
       * empty value as "derive the default", while `unset` would resurrect an
       * inherited layer's path.
       */
      /**
       * Persist the task-record settings.
       *
       * `dir` is ALWAYS written — '' is the meaningful "derive the default" value,
       * exactly like the workspace root — while retention/cap are written only when
       * the operator typed something, because an empty numeric field has no
       * unambiguous meaning. The button therefore always has an effect.
       */
      const saveTaskSettings = (): void => {
        if (saving || !hasForm || !formWritable || !formReady) return
        const ops: Array<{ op: 'set', path: readonly string[], value: string | number }> = [
          { op: 'set', path: TASK_DIR_PATH, value: taskDir.trim() },
        ]
        const retentionText = taskRetentionDays.trim()
        if (retentionText.length > 0) {
          const days = Number.parseInt(retentionText, 10)
          if (!Number.isFinite(days) || days <= 0 || String(days) !== retentionText) {
            setStatus({ tone: 'error', text: t('error.taskRetention') })
            return
          }
          ops.push({ op: 'set', path: TASK_RETENTION_PATH, value: days * MS_PER_DAY })
        }
        const maxText = taskMaxRecords.trim()
        if (maxText.length > 0) {
          const maxRecords = Number.parseInt(maxText, 10)
          if (!Number.isFinite(maxRecords) || maxRecords <= 0 || String(maxRecords) !== maxText) {
            setStatus({ tone: 'error', text: t('error.taskMaxRecords') })
            return
          }
          ops.push({ op: 'set', path: TASK_MAX_RECORDS_PATH, value: maxRecords })
        }
        if (ops.length === 1 && ops[0]?.value === formTaskDir.trim()) {
          // Only the directory was "written", and it already holds that value.
          setStatus({ tone: 'idle', text: t('status.tasksNothingToChange') })
          return
        }
        setSaving(true)
        setStatus({ tone: 'idle', text: '' })
        mutateForm(form, ops).then(
          (accepted) => {
            if (!alive.current) return
            setSaving(false)
            if (!accepted) {
              setStatus({ tone: 'error', text: t('error.rejected') })
              return
            }
            setReloadToken((value: number) => value + 1)
            setStatus({ tone: 'ok', text: t('status.tasksSaved') })
          },
          (error: unknown) => {
            if (!alive.current) return
            setSaving(false)
            setStatus({ tone: 'error', text: t('error.save', { message: describeError(error) }) })
          },
        )
      }

      const saveWorkspaceRoot = (): void => {
        if (saving || !hasForm || !formWritable || !formReady || !workspaceDirty) return
        const next = workspaceRoot.trim()
        setSaving(true)
        setStatus({ tone: 'idle', text: '' })
        mutateForm(form, [{ op: 'set', path: WORKSPACE_ROOT_PATH, value: next }]).then(
          (accepted) => {
            if (!alive.current) return
            setSaving(false)
            if (!accepted) {
              setStatus({ tone: 'error', text: t('error.rejected') })
              return
            }
            setWorkspaceRoot(next)
            setReloadToken((value: number) => value + 1)
            setStatus({ tone: 'ok', text: t('status.workspaceSaved') })
          },
          (error: unknown) => {
            if (!alive.current) return
            setSaving(false)
            setStatus({ tone: 'error', text: t('error.save', { message: describeError(error) }) })
          },
        )
      }

      const chooseBrowsedDirectory = (): void => {
        if (browser.listing === undefined) return
        browserGeneration.current += 1
        // Shared by both path fields: the browser panel does not know (and must
        // not know) which one opened it.
        applyPickedPath(browser.listing.path)
        setBrowser((previous: BrowserState) => ({ ...previous, open: false }))
        setStatus({ tone: 'idle', text: '' })
      }

      const browsedParent =
        browser.listing !== undefined && browser.listing.crumbs.length >= 2
          ? browser.listing.crumbs[browser.listing.crumbs.length - 2]
          : undefined

      // The effective selection can come from a source this form does not write
      // (a YAML pin, or a Host build that resolves the pin itself). When it
      // disagrees with the form, saving here would not change what A2A runs, so
      // say so instead of lying.
      const mismatch =
        hasForm &&
        formReady &&
        effective.source === 'pinned' &&
        effective.provider.length > 0 &&
        effective.model.length > 0 &&
        (effective.provider !== draft.provider || effective.model !== draft.model)
          ? effective
          : undefined

      if (!isPage) {
        // Summary: ONE line — the row description slot has no room for a form.
        let value: string
        if (formReady) {
          value = pinned
            ? t('summary.value', { provider: draft.provider, model: draft.model })
            : t('summary.unconfigured')
        } else if (catalogLoading) {
          value = t('summary.loading')
        } else if (catalogFailed) {
          value = t('summary.unknown')
        } else if (!effective.configured || effective.provider.length === 0) {
          value = t('summary.unconfigured')
        } else {
          value = t('summary.value', { provider: effective.provider, model: effective.model })
        }
        return h(
          'span',
          { 'data-a2a-config-summary': true, 'data-a2a-channel': channel },
          t('summary.text', { label: t('summary.label'), value }),
        )
      }

      const busy = saving
      const canSave = !busy && formWritable && pinned
      const sourceLabel = hasForm
        ? formReady
          ? t('status.sourceConfig')
          : t('status.formLoading')
        : effective.source === 'pinned'
          ? t('status.sourcePinned')
          : t('status.sourceNone')

      const providerSelect = h(
        'select',
        {
          id: 'a2a-bridge-provider',
          value: draft.provider,
          disabled: busy || catalogLoading || (hasForm && !formReady) || providerValues.length === 0,
          style: controlStyle,
          onChange: (event: any) => {
            const nextProvider = String(event.target.value)
            const entry = providers.find((candidate) => candidate.provider === nextProvider)
            const nextModel = entry === undefined ? '' : (entry.models[0] ?? '')
            setDraft({ provider: nextProvider, model: nextModel })
            setStatus({ tone: 'idle', text: '' })
            setAdoptedLegacy(undefined)
          },
        },
        option('', t('option.none')),
        ...providerValues.map((provider) => option(provider, provider)),
      )

      const modelSelect = h(
        'select',
        {
          id: 'a2a-bridge-model',
          value: draft.model,
          disabled:
            busy ||
            catalogLoading ||
            (hasForm && !formReady) ||
            draft.provider.length === 0 ||
            models.length === 0,
          style: controlStyle,
          onChange: (event: any) => {
            setDraft((previous: Selection) => ({ ...previous, model: String(event.target.value) }))
            setStatus({ tone: 'idle', text: '' })
            setAdoptedLegacy(undefined)
          },
        },
        option('', t('option.modelPlaceholder')),
        ...models.map((model) => option(model, model)),
      )

      // Options are whatever THIS deployment declares, plus the currently
      // stored id when it is not in the roster (a preset that was removed still
      // has to be visible, otherwise the select would silently fall back to its
      // first option and misreport the effective value).
      const presetValues = [...presets.ids]
      if (preset.length > 0 && !presetValues.includes(preset)) presetValues.push(preset)

      const presetSelect = h(
        'select',
        {
          id: 'a2a-bridge-agent-preset',
          'data-a2a-agent-preset': true,
          value: preset,
          // Disabled without a form: the bridge route cannot carry this field,
          // and a live control that cannot save is worse than an explained one.
          disabled: busy || !hasForm || !formWritable || !formReady,
          style: controlStyle,
          onChange: (event: any) => choosePreset(String(event.target.value)),
        },
        option('', t('option.presetDefault')),
        ...presetValues.map((id) => option(id, id)),
      )

      // The path is an ordinary text input plus two explicit actions. Keeping
      // it a text input means a deployment without `directoryPicker` can still
      // configure the workspace, which is the requirement; the picker is an
      // enhancement, never the only way in.
      const workspaceControlsDisabled = busy || !hasForm || !formWritable || !formReady
      const workspaceInput = h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('input', {
          id: 'a2a-bridge-workspace-root',
          'data-a2a-workspace-root': true,
          type: 'text',
          value: workspaceRoot,
          placeholder: t('option.workspaceRootPlaceholder'),
          disabled: workspaceControlsDisabled,
          style: { ...controlStyle, flex: '1 1 16rem', minWidth: '12rem' },
          onChange: (event: any) => {
            setWorkspaceRoot(String(event.target.value))
            setStatus({ tone: 'idle', text: '' })
          },
          onKeyDown: (event: any) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              saveWorkspaceRoot()
            }
          },
        }),
        h(
          'button',
          {
            type: 'button',
            'data-a2a-browse': true,
            disabled: workspaceControlsDisabled || !pickerAvailable,
            style: outlineButtonStyle(!workspaceControlsDisabled && pickerAvailable),
            onClick: () => pickDirectory('workspace'),
          },
          t('action.browse'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-a2a-save-workspace': true,
            disabled: workspaceControlsDisabled || !workspaceDirty,
            style: outlineButtonStyle(!workspaceControlsDisabled && workspaceDirty),
            onClick: saveWorkspaceRoot,
          },
          t('action.savePath'),
        ),
      )

      const browserPanel = browser.open
        ? h(
            'div',
            {
              'data-a2a-directory-browser': true,
              role: 'group',
              'aria-label': t('browser.title'),
              style: {
                display: 'grid',
                gap: '8px',
                padding: '10px',
                border: `0.5px solid ${BORDER}`,
                borderRadius: RADIUS_MD,
                background: CONTROL_FILL,
              },
            },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '8px',
                },
              },
              h(
                'span',
                { style: { fontSize: '12px', fontWeight: FONT_WEIGHT_BANNER, color: TEXT_PRIMARY } },
                t('browser.title'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: outlineButtonStyle(true),
                  onClick: () => {
                    browserGeneration.current += 1
                    setBrowser((previous: BrowserState) => ({ ...previous, open: false }))
                  },
                },
                t('browser.cancel'),
              ),
            ),
            browser.phase === 'loading' ? note(t('browser.loading')) : null,
            browser.phase === 'error' ? note(browser.message, 'error') : null,
            browser.phase === 'ready' && browser.listing !== undefined
              ? h(
                  'div',
                  { style: { display: 'grid', gap: '6px' } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                    h('input', {
                      id: 'a2a-bridge-browser-path',
                      'data-a2a-browser-path': true,
                      type: 'text',
                      value: browserPathDraft,
                      placeholder: t('browser.pathPlaceholder'),
                      style: { ...controlStyle, flex: '1 1 16rem', minWidth: '12rem' },
                      onChange: (event: any) => setBrowserPathDraft(String(event.target.value)),
                      onKeyDown: (event: any) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          openBrowser(browserPathDraft.trim(), pickerTarget.current)
                        }
                      },
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        'data-a2a-browser-jump': true,
                        style: outlineButtonStyle(true),
                        onClick: () => openBrowser(browserPathDraft.trim(), pickerTarget.current),
                      },
                      t('browser.jump'),
                    ),
                  ),
                  browser.listing.entries.length === 0
                    ? note(t('browser.empty'))
                    : h(
                        'div',
                        {
                          style: {
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '6px',
                            maxHeight: '12rem',
                            overflow: 'auto',
                          },
                        },
                        ...browser.listing.entries.map((entry) =>
                          h(
                            'button',
                            {
                              key: entry.path,
                              type: 'button',
                              title: entry.path,
                              style: {
                                ...outlineButtonStyle(true),
                                height: '24px',
                                opacity: entry.hidden ? 0.6 : undefined,
                              },
                              onClick: () => openBrowser(entry.path),
                            },
                            entry.name,
                          ),
                        ),
                      ),
                  browser.listing.truncated ? note(t('browser.truncated')) : null,
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                    h(
                      'button',
                      {
                        type: 'button',
                        disabled: browsedParent === undefined,
                        style: outlineButtonStyle(browsedParent !== undefined),
                        onClick: () => {
                          if (browsedParent !== undefined) openBrowser(browsedParent.path)
                        },
                      },
                      t('browser.up'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: primaryButtonStyle(true),
                        onClick: chooseBrowsedDirectory,
                      },
                      t('browser.choose'),
                    ),
                  ),
                )
              : null,
          )
        : null

      const statusColor = status.tone === 'error' ? ERROR_TEXT : TEXT_SECONDARY
      return h(
        'section',
        {
          'data-a2a-config-page': true,
          'data-a2a-channel': channel,
          'data-a2a-form-state': hasForm ? (form?.state?.status ?? 'unknown') : 'absent',
          style: { display: 'grid', gap: '12px', padding: '4px 0' },
        },
        h('h4', { style: { margin: 0, fontSize: '14px', fontWeight: FONT_WEIGHT_HEADING, color: TEXT_PRIMARY } }, t('page.title')),

        // An unconfigured deployment refuses EVERY A2A call. Shown above the
        // form so it cannot be missed, but not while the first read is in
        // flight (an unconfigured-looking flash on every page open would train
        // users to ignore it).
        catalogLoading || (hasForm && !formReady)
          ? null
          : configuredNow
            ? null
            : banner(t('page.warning'), 'data-a2a-config-warning'),

        h(
          'p',
          { style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: TEXT_SECONDARY } },
          t('page.hint'),
        ),

        catalogLoading ? note(t('page.loading'), 'muted', 'data-a2a-config-loading') : null,
        hasForm && !formReady && !catalogLoading
          ? note(t('status.formLoading'), 'muted', 'data-a2a-config-form')
          : null,
        catalogFailed ? note(catalog.message, 'error', 'data-a2a-config-error') : null,
        !catalogLoading && !catalogFailed && providerValues.length === 0
          ? note(t('status.noProviders'), 'muted', 'data-a2a-config-empty')
          : null,
        !catalogLoading && !catalogFailed && draft.provider.length > 0 && models.length === 0
          ? note(t('status.noModels'), 'muted', 'data-a2a-config-no-models')
          : null,
        adoptedLegacy === undefined
          ? null
          : note(
              t('status.adoptedLegacy', {
                provider: adoptedLegacy.provider,
                model: adoptedLegacy.model,
              }),
              'muted',
              'data-a2a-config-adopted',
            ),
        hasForm && !formWritable && formReady
          ? note(t('status.readOnly'), 'error', 'data-a2a-config-readonly')
          : null,
        mismatch === undefined
          ? null
          : banner(
              t('status.effectiveMismatch', {
                provider: mismatch.provider,
                model: mismatch.model,
              }),
              'data-a2a-config-mismatch',
            ),

        sectionHeading(t('section.model')),
        field('a2a-bridge-provider', t('field.provider'), providerSelect),
        field('a2a-bridge-model', t('field.model'), modelSelect),
        field('a2a-bridge-agent-preset', t('field.agentPreset'), presetSelect),
        h(
          'p',
          { style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: TEXT_SECONDARY } },
          t('page.presetHint'),
        ),
        // "Unavailable" and "none declared" are different defects with
        // different fixes, so they never share a message.
        !presets.available && !catalogLoading
          ? note(t('status.presetsUnavailable'), 'error', 'data-a2a-presets-unavailable')
          : null,
        presets.available && presets.ids.length === 0
          ? note(t('status.presetsEmpty'), 'error', 'data-a2a-presets-empty')
          : null,
        hasForm ? null : note(t('status.presetNoForm'), 'muted', 'data-a2a-preset-noform'),

        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              disabled: !canSave,
              style: primaryButtonStyle(canSave),
              onClick: save,
            },
            busy ? t('action.saving') : t('action.save'),
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: busy || !formWritable,
              style: outlineButtonStyle(!busy && formWritable),
              onClick: clear,
            },
            t('action.clear'),
          ),
          h(
            'span',
            {
              'data-a2a-config-source': channel,
              style: { fontSize: '12px', lineHeight: '18px', color: TEXT_TERTIARY },
            },
            sourceLabel,
          ),
        ),

        sectionHeading(t('section.workspace')),
        field('a2a-bridge-workspace-root', t('field.workspaceRoot'), workspaceInput),
        h(
          'p',
          { style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: TEXT_SECONDARY } },
          t('page.workspaceHint'),
        ),
        hasForm ? null : note(t('status.workspaceNoForm'), 'muted', 'data-a2a-workspace-noform'),
        pickerAvailable
          ? null
          : note(t('status.pickerUnavailable'), 'muted', 'data-a2a-picker-unavailable'),
        browserPanel,

        // Task records are a SEPARATE concern from the workspace: the workspace is
        // a directory a peer can list, these are the protocol's own bookkeeping. A
        // separate group keeps that distinction visible to the operator.
        sectionHeading(t('section.tasks')),
        field(
          'a2a-bridge-task-dir',
          t('field.taskDir'),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              id: 'a2a-bridge-task-dir',
              'data-a2a-task-dir': true,
              type: 'text',
              value: taskDir,
              placeholder: t('option.taskDirPlaceholder'),
              disabled: workspaceControlsDisabled,
              style: { ...controlStyle, flex: '1 1 18rem', minWidth: '12rem' },
              onChange: (event: any) => {
                setTaskDir(String(event.target.value))
                setStatus({ tone: 'idle', text: '' })
              },
              onKeyDown: (event: any) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  saveTaskSettings()
                }
              },
            }),
            // Same picker as the workspace path: prefer the host's OS chooser and
            // fall back to the inline browser. Typing a path is still possible, but
            // it must not be the ONLY way in.
            h(
              'button',
              {
                type: 'button',
                'data-a2a-browse-tasks': true,
                disabled: workspaceControlsDisabled || !pickerAvailable,
                style: outlineButtonStyle(!workspaceControlsDisabled && pickerAvailable),
                onClick: () => pickDirectory('tasks'),
              },
              t('action.browse'),
            ),
          ),
        ),
        field(
          'a2a-bridge-task-retention',
          t('field.taskRetentionDays'),
          h('input', {
            id: 'a2a-bridge-task-retention',
            'data-a2a-task-retention': true,
            type: 'text',
            inputMode: 'numeric',
            value: taskRetentionDays,
            placeholder: t('option.taskRetentionPlaceholder'),
            disabled: workspaceControlsDisabled,
            style: { ...controlStyle, width: '8rem' },
            onChange: (event: any) => {
              setTaskRetentionDays(String(event.target.value))
              setStatus({ tone: 'idle', text: '' })
            },
            onKeyDown: (event: any) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveTaskSettings()
              }
            },
          }),
        ),
        field(
          'a2a-bridge-task-max-records',
          t('field.taskMaxRecords'),
          h('input', {
            id: 'a2a-bridge-task-max-records',
            'data-a2a-task-max-records': true,
            type: 'text',
            inputMode: 'numeric',
            value: taskMaxRecords,
            placeholder: t('option.taskMaxRecordsPlaceholder'),
            disabled: workspaceControlsDisabled,
            style: { ...controlStyle, width: '8rem' },
            onChange: (event: any) => {
              setTaskMaxRecords(String(event.target.value))
              setStatus({ tone: 'idle', text: '' })
            },
            onKeyDown: (event: any) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveTaskSettings()
              }
            },
          }),
        ),
        h(
          'p',
          { style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: TEXT_SECONDARY } },
          t('page.tasksHint'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-a2a-save-tasks': true,
            disabled: workspaceControlsDisabled,
            style: outlineButtonStyle(!workspaceControlsDisabled),
            onClick: saveTaskSettings,
          },
          t('action.saveTasks'),
        ),

        status.text.length > 0
          ? h(
              'p',
              {
                'data-a2a-config-status': status.tone,
                style: {
                  margin: 0,
                  fontSize: '12px',
                  lineHeight: '18px',
                  color: statusColor,
                },
              },
              status.text,
            )
          : null,
      )
    }

    return ConfigView
  }

  const loader = (globalThis as unknown as {
    __ModuleLoader__?: {
      load?: (registration: {
        id: string
        factory: (require: (id: string) => any) => unknown
      }) => void
    }
  }).__ModuleLoader__

  if (loader === undefined || typeof loader.load !== 'function') {
    // Nothing to attach to: the module system has not booted. Logging (rather
    // than throwing) keeps a stray script tag from breaking the page.
    console.warn(`[${PACKAGE_NAME}] __ModuleLoader__ is unavailable; client half not registered`)
    return
  }

  loader.load({
    id: PACKAGE_NAME,
    factory: (require) => {
      const React = require('react')
      const ConfigView = createConfigView(React)

      function apply(ctx: any): void {
        try {
          // Copy goes through the locale service so it follows language
          // switches live. The slot registration below names the same
          // namespace, so DSH injects the `t` prop the view reads.
          ctx.effect(
            () => ctx.locale.register(LOCALE_NAMESPACE, { zh: ZH, en: EN }),
            'a2a-bridge: config copy',
          )

          ctx.effect(() => {
            const disposers: Array<() => void> = []
            for (const key of SLOT_KEYS) {
              try {
                // `slots.inject` waits for the page to DECLARE the slot, so a
                // registration made before the Plugins page mounts is queued,
                // not lost.
                const dispose = ctx.slots.inject(SLOT_NAME, () =>
                  ctx.slots.register(
                    {
                      name: SLOT_NAME,
                      key,
                      priority: SLOT_PRIORITY,
                      locale: LOCALE_NAMESPACE,
                      // OPTIONAL service access, resolved per render: a profile
                      // without the workspace Remote still gets the text input,
                      // and a late mount becomes usable without re-registering.
                      inject: () => ({
                        directoryPicker: () => ctx.get('remote.directoryPicker'),
                      }),
                    },
                    ConfigView,
                  ),
                )
                if (typeof dispose === 'function') disposers.push(dispose)
              } catch (error) {
                // Isolate per key: one rejected spelling must not cost the
                // other one its registration.
                console.error(
                  `[${PACKAGE_NAME}] slot "${SLOT_NAME}" key "${key}" failed to register:`,
                  error,
                )
              }
            }
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose()
                } catch {
                  /* already disposed */
                }
              }
            }
          }, 'a2a-bridge: plugin config slots')
        } catch (error) {
          console.error(`[${PACKAGE_NAME}] client half failed to load:`, error)
        }
      }

      return { name: CLIENT_NAME, inject: ['slots', 'locale'], apply }
    },
  })
})()
