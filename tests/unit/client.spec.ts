/**
 * Contract tests for the browser half (`src/client.ts`).
 *
 * The client bundle cannot be imported in Node: it is a classic script that
 * expects `window.__ModuleLoader__` and React. What CAN be pinned, and what
 * actually breaks silently in production, is the contract:
 *   - the module-loader id equals the package name (issue: "loaded without
 *     registering <id>"),
 *   - both keyed `plugins.row.config` spellings are registered (issue #55:
 *     an empty configuration page and no error),
 *   - the page uses the Host-owned `form` prop when present and only falls
 *     back to the plugin's own HTTP route when it is absent,
 *   - the browser endpoint equals the Host's `CONFIG_ROUTE_PATH`,
 *   - the shipped locale documents match the inlined dictionaries,
 *   - no top-level ESM syntax sneaks in (a classic script cannot parse it),
 *   - colors come from host theme tokens, not literal hex values.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CONFIG_ROUTE_PATH } from '../../src/constants.js'
import {
  CLIENT_SOURCE,
  LOCALE_TARGETS,
  ROOT,
  readDictionaries,
} from '../../scripts/client-locale.mjs'

const source = readFileSync(CLIENT_SOURCE, 'utf8')

/** Extract `const <name> = <literal>` for a simple string constant. */
function stringConstant(name: string): string {
  const match = new RegExp(String.raw`const\s+${name}\s*=\s*['"\`]([^'"\`]+)['"\`]`).exec(
    source,
  )
  if (match === null) throw new Error(`constant ${name} not found in src/client.ts`)
  return match[1] as string
}

describe('module loader registration', () => {
  it('registers under the package name, which client-modules composes from the manifest', () => {
    expect(stringConstant('PACKAGE_NAME')).toBe('dsh-a2a-bridge')

    // The registration id must be the SAME constant, never a second literal.
    expect(source).toMatch(/loader\.load\(\{\s*\n\s*id:\s*PACKAGE_NAME,/)
  })

  it('exposes a factory that takes the platform require, not a bundled React', () => {
    expect(source).toMatch(/factory:\s*\(require\)/)
    expect(source).toMatch(/require\(['"]react['"]\)/)
    // A second React copy would break hooks across the whole UI.
    expect(source).not.toContain('react-dom')
  })

  it('contains no top-level ESM statement (it is loaded as a classic script)', () => {
    const topLevelImport = /^\s*(?:import|export)\s/m.exec(source)
    expect(topLevelImport).toBeNull()
  })
})

describe('slot registration keys (issue #55)', () => {
  it('registers every <inventory name>#<row id> spelling the host may dispatch with', () => {
    // Occupant format is `<inventory name>#<row id>`, proven by a shipped card
    // that occupies `dsh-connect-workbuddy#dsh-connect-workbuddy`. Both the name
    // spelling (bare vs include:-wrapped Loader entry id) and the `#<row id>`
    // suffix are load-bearing: a wrong shape yields no control and NO error.
    expect(source).toContain("const ROW_ID = 'a2a-bridge'")
    expect(source).toContain('`${PACKAGE_NAME}#${ROW_ID}`')
    expect(source).toContain('`include:${ROW_ID}#${ROW_ID}`')
  })

  it('never registers only the legacy package#rowId spelling', () => {
    // `dsh-a2a-bridge#a2a-bridge` alone is the spelling that produced no card.
    expect(source).not.toMatch(/const SLOT_KEYS = \[`\$\{PACKAGE_NAME\}#a2a-bridge`\]/)
  })

  it('uses the keyed plugins.row.config slot with the shipped priority', () => {
    expect(source).toContain("const SLOT_NAME = 'plugins.row.config'")
    expect(source).toMatch(/const SLOT_PRIORITY = 30/)
  })

  it('binds the slot to the locale namespace so DSH injects `t`', () => {
    expect(source).toContain("const LOCALE_NAMESPACE = 'a2a-bridge'")
    expect(source).toContain('locale: LOCALE_NAMESPACE')
    expect(source).toContain('ctx.locale.register(LOCALE_NAMESPACE, { zh: ZH, en: EN })')
  })
})

describe('write channel (T2: form first, bridge route only as fallback)', () => {
  it('reads the Host-owned form prop, which the contract declares optional', () => {
    expect(source).toContain('props?.view === \'page\'')
    // `form` is optional: the summary view must render without it, and the
    // page must not assume it exists.
    expect(source).toContain('const form = props?.form as ConfigPageFormLike | undefined')
    expect(source).toContain('const hasForm = form !== undefined && form !== null')
    expect(source).toMatch(/function readFormSelection\(/)
    expect(source).toMatch(/function mutateForm\(/)
    // The snapshot fields the page hands over: status/value/revision/writable.
    expect(source).toContain('state.status !== \'ready\'')
    expect(source).toContain('form?.state?.revision')
    expect(source).toContain('form?.state?.writable')
  })

  it('writes the volatile Config paths through form.mutate', () => {
    expect(source).toContain("const PROVIDER_PATH: readonly string[] = ['inbound', 'agent', 'provider']")
    expect(source).toContain("const MODEL_PATH: readonly string[] = ['inbound', 'agent', 'model']")
    expect(source).toContain('{ op: \'set\', path: PROVIDER_PATH, value: provider }')
    expect(source).toContain('{ op: \'set\', path: MODEL_PATH, value: model }')
    expect(source).toContain('{ op: \'unset\', path: PROVIDER_PATH }')
    expect(source).toContain('{ op: \'unset\', path: MODEL_PATH }')
  })

  it('keeps the plugin HTTP route as the fallback, never as a parallel write', () => {
    // Every POST lives under the `if (hasForm) { ... return }` branch's else:
    // the bridge route is only reached when the Host passed no form.
    const formBranches = source.match(/if \(hasForm\) \{/g) ?? []
    expect(formBranches.length).toBeGreaterThanOrEqual(2)
    expect(source).toContain("requestConfig({ method: 'POST', body: { provider, model } })")
    expect(source).toContain("requestConfig({ method: 'POST', body: { provider: '', model: '' } })")
  })

  it('refreshes the effective read after a form write instead of claiming success blindly', () => {
    expect(source).toContain('setReloadToken((value: number) => value + 1)')
    expect(source).toContain("t('status.savedForm')")
    expect(source).toMatch(/effective\.provider !== draft\.provider/)
  })
})

describe('agent preset picker', () => {
  it('writes inbound.agentPreset through the same form channel', () => {
    expect(source).toContain(
      "const AGENT_PRESET_PATH: readonly string[] = ['inbound', 'agentPreset']",
    )
    expect(source).toContain('{ op: \'set\', path: AGENT_PRESET_PATH, value: next }')
    expect(source).toContain("{ op: 'unset', path: AGENT_PRESET_PATH }")
    // The old provider/model pair is untouched by the preset path: a different
    // field, not a second spelling of the same one.
    expect(source).toContain("const AGENT_PRESET_PATH: readonly string[] = ['inbound', 'agentPreset']")
    expect(source).not.toContain("['inbound', 'agent', 'agentPreset']")
  })

  it('takes its options from the Host roster, never from a literal list', () => {
    expect(source).toContain('presetValues.map((id) => option(id, id))')
    expect(source).toContain("option('', t('option.presetDefault'))")
    expect(source).toContain("t('status.presetsUnavailable')")
    expect(source).toContain("t('status.presetsEmpty')")
    // "unavailable" and "nothing declared" must stay distinguishable.
    expect(source).toContain('presets.available && presets.ids.length === 0')
  })

  it('is disabled when the Host supplied no writable form (the route cannot carry it)', () => {
    expect(source).toContain("disabled: busy || !hasForm || !formWritable || !formReady")
    expect(source).toContain("t('status.presetNoForm')")
    expect(source).toContain("'data-a2a-agent-preset': true")
  })
})

describe('workspace root (task-7)', () => {
  it('writes inbound.isolation.workspaceRoot through the form channel', () => {
    expect(source).toContain(
      "const WORKSPACE_ROOT_PATH: readonly string[] = ['inbound', 'isolation', 'workspaceRoot']",
    )
    expect(source).toContain("{ op: 'set', path: WORKSPACE_ROOT_PATH, value: next }")
    // Empty means "derive <DSH_HOME>/a2a-workspaces", so the page writes an
    // explicit empty string; `unset` would restore an inherited layer's path.
    expect(source).not.toContain("{ op: 'unset', path: WORKSPACE_ROOT_PATH }")
    expect(source).toContain('stringAt(form?.state?.value, [...WORKSPACE_ROOT_PATH])')
  })

  it('uses the directoryPicker Remote contract (pick/list), never a fabricated filesystem API', () => {
    // VERIFIED shape: `dsh-client-ui-workspace` destructures the same envelope.
    expect(source).toContain('pick?: () => Promise<RemoteResult<string | null>>')
    expect(source).toContain('list?: (path?: string) => Promise<RemoteResult<DirectoryListing>>')
    expect(source).toContain('result?.ok === true')
    expect(source).toContain('function adoptListing(')
    expect(source).toContain('function remoteMessage(')
    // The picker is optional; the plain text input must remain usable.
    expect(source).toContain("typeof props?.directoryPicker === 'function'")
    expect(source).toContain("ctx.get('remote.directoryPicker')")
    // No absolute path literal may sneak into the logic.
    expect(source).not.toMatch(/[A-Za-z]:[\\/]/)
  })

  it('renders the path input, browse and save controls', () => {
    expect(source).toContain("'data-a2a-workspace-root': true")
    expect(source).toContain("'data-a2a-browse': true")
    expect(source).toContain("'data-a2a-save-workspace': true")
    expect(source).toContain("'data-a2a-directory-browser': true")
    expect(source).toContain("t('action.browse')")
    expect(source).toContain("t('action.savePath')")
  })

  it('explains the degraded states instead of rendering dead controls', () => {
    expect(source).toContain(
      "const workspaceControlsDisabled = busy || !hasForm || !formWritable || !formReady",
    )
    expect(source).toContain("t('status.workspaceNoForm')")
    expect(source).toContain("t('status.pickerUnavailable')")
    expect(source).toContain("t('status.pickerFailed'")
    expect(source).toContain("t('status.workspaceSaved')")
  })
})

describe('summary view', () => {
  it('renders one line and does not depend on `form` being present', () => {
    expect(source).toContain("if (!isPage) {")
    expect(source).toContain("t('summary.text'")
    expect(source).not.toMatch(/props\.form\./)
  })
})

describe('runtime catalog (T3)', () => {
  it('loads providers/models from the Host route, never from a literal list', () => {
    expect(source).toContain("requestConfig({ method: 'GET' })")
    expect(source).toContain('adoptPayload(payload)')
    // Three explicit states the view must distinguish.
    expect(source).toContain("t('page.loading')")
    expect(source).toContain("t('status.noProviders')")
    expect(source).toContain('catalogFailed')
  })
})

describe('Host endpoint', () => {
  it('matches the Host route constant exactly', () => {
    expect(stringConstant('CONFIG_ENDPOINT')).toBe(CONFIG_ROUTE_PATH)
  })

  it('is not the peer-facing JSON-RPC base path', () => {
    expect(CONFIG_ROUTE_PATH.startsWith('/a2a-')).toBe(true)
    expect(CONFIG_ROUTE_PATH).not.toBe('/a2a')
  })
})

describe('locale documents', () => {
  it('match the inlined ZH/EN dictionaries exactly', () => {
    const dictionaries = readDictionaries()

    for (const [locale, target] of Object.entries(LOCALE_TARGETS)) {
      const shipped = JSON.parse(readFileSync(join(ROOT, target as string), 'utf8')) as Record<
        string,
        string
      >
      expect(shipped, String(target)).toEqual(dictionaries[locale])
    }
  })

  it('keeps zh and en key sets identical so no label falls back to a raw key', () => {
    const dictionaries = readDictionaries()
    const zh = Object.keys(dictionaries.zh as Record<string, string>).sort()
    const en = Object.keys(dictionaries.en as Record<string, string>).sort()

    expect(zh).toEqual(en)
  })

  it('ships real Chinese copy for the required labels', () => {
    const zh = readDictionaries().zh as Record<string, string>

    expect(zh['summary.label']).toMatch(/[\u4e00-\u9fff]/)
    expect(zh['action.save']).toMatch(/[\u4e00-\u9fff]/)
    expect(zh['page.hint']).toMatch(/[\u4e00-\u9fff]/)
  })

  it('covers the form/fallback and catalog states the page can show', () => {
    const dictionaries = readDictionaries()
    const required = [
      'page.loading',
      'status.savedForm',
      'status.sourceConfig',
      'status.sourcePinned',
      'status.sourceNone',
      'status.readOnly',
      'status.adoptedLegacy',
      'status.noProviders',
      'status.noModels',
      'status.effectiveMismatch',
      'status.cleared',
      'status.formLoading',
      'error.rejected',
      'field.agentPreset',
      'option.presetDefault',
      'page.presetHint',
      'status.presetSaved',
      'status.presetsUnavailable',
      'status.presetsEmpty',
      'status.presetNoForm',
      'field.workspaceRoot',
      'section.model',
      'section.workspace',
      'option.workspaceRootPlaceholder',
      'page.workspaceHint',
      'action.browse',
      'action.savePath',
      'status.workspaceSaved',
      'status.workspaceNoForm',
      'status.pickerUnavailable',
      'status.pickerFailed',
      'browser.title',
      'browser.loading',
      'browser.error',
      'browser.up',
      'browser.choose',
      'browser.cancel',
      'browser.truncated',
      'browser.empty',
      'error.invalidListing',
    ]

    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      for (const key of required) {
        expect(dictionary as Record<string, string>, `${locale}:${key}`).toHaveProperty(key)
      }
    }
  })
})

describe('theme and hard-coded values (T4)', () => {
  it('styles with host theme tokens', () => {
    expect(source).toContain('var(--dsw-alias-label-primary)')
    expect(source).toContain('var(--dsw-alias-label-secondary)')
    expect(source).toContain('var(--dsw-alias-state-error-primary)')
    expect(source).toMatch(/var\(--dsw-radius-(?:md|sm)\)/)
  })

  it('ships no literal color fallback (a token rename must never paint a stale color)', () => {
    expect(source).not.toMatch(/var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/)
    expect(source).not.toMatch(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/)
  })

  it('names no concrete provider or model', () => {
    expect(source).not.toMatch(/deepseek-(?:account|flash|pro)/)
    expect(source).not.toMatch(/LongCat-/)
  })

  it('exposes the active write channel for verification without reading state', () => {
    expect(source).toContain("'data-a2a-channel': channel")
    expect(source).toContain("'data-a2a-form-state': hasForm")
  })
})

/**
 * Task records: the operator-facing half of the persisted task store.
 *
 * Decisions taken by the user: retention is entered in DAYS (A1) and the controls
 * live in their own "Task records" group (B1). Both are pinned here because a
 * silent regression in either would look like "my setting was ignored".
 */
describe('task records group (A1 days / B1 own group)', () => {
  it('writes the three inbound.tasks paths through the form channel', () => {
    expect(source).toContain("['inbound', 'tasks', 'dir']")
    expect(source).toContain("['inbound', 'tasks', 'retentionMs']")
    expect(source).toContain("['inbound', 'tasks', 'maxRecords']")
    expect(source).toContain("path: TASK_DIR_PATH")
    expect(source).toContain("path: TASK_RETENTION_PATH")
    expect(source).toContain("path: TASK_MAX_RECORDS_PATH")
  })

  it('renders its own group with a field per setting', () => {
    expect(source).toContain("sectionHeading(t('section.tasks'))")
    expect(source).toContain("'data-a2a-task-dir': true")
    expect(source).toContain("'data-a2a-task-retention': true")
    expect(source).toContain("'data-a2a-task-max-records': true")
    expect(source).toContain("'data-a2a-save-tasks': true")
    // The hint must say that empty means "unchanged" / "default", otherwise the
    // operator cannot tell why nothing happened.
    expect(source).toContain("t('page.tasksHint')")
  })

  it('converts DAYS to milliseconds exactly once, through a named constant', () => {
    expect(source).toContain('value: days * MS_PER_DAY')
    // Numeric fields are read with a NUMBER-aware walk; `stringAt` would report
    // every numeric field as '' and the page would look unset on every open.
    expect(source).toContain('function numberTextAt(')
    expect(source).toContain("numberTextAt(form?.state?.value, [...TASK_RETENTION_PATH])")
  })

  it("keeps the client's MS_PER_DAY equal to the Host constant", async () => {
    // The client half is a classic script and cannot import constants.ts, so the
    // value is duplicated. This is the guard that stops the two copies drifting.
    const { MS_PER_DAY } = await import('../../src/constants.js')
    const declared = /const MS_PER_DAY = ([0-9_]+)/.exec(source)
    expect(declared).not.toBeNull()
    expect(Number(String(declared?.[1]).replaceAll('_', ''))).toBe(MS_PER_DAY)
  })

  it('treats an empty retention or cap as "do not change"', () => {
    // Only the directory is always written ('' is the meaningful "derive the
    // default"); the numeric fields are skipped when blank.
    expect(source).toContain('if (retentionText.length > 0)')
    expect(source).toContain('if (maxText.length > 0)')
    expect(source).toContain("t('status.tasksNothingToChange')")
  })

  it('offers the SAME directory picker for the task directory as for the workspace', () => {
    expect(source).toContain('const pickerTarget = React.useRef')
    expect(source).toContain("const pickDirectory = (target: 'workspace' | 'tasks'): void =>")
    expect(source).toContain("onClick: () => pickDirectory('tasks')")
    expect(source).toContain("onClick: () => pickDirectory('workspace')")
    expect(source).toContain("'data-a2a-browse-tasks': true")
    // ONE implementation. Duplicating the ~40-line pick fallback chain per field is
    // exactly how the two would drift apart, and the user would face two different
    // behaviours behind two identical-looking buttons.
    expect((source.match(/picker\.pick\(\)/g) ?? []).length).toBe(1)
    expect((source.match(/const openBrowser = /g) ?? []).length).toBe(1)
  })

  it('applies a picked path to whichever field opened the picker', () => {
    expect(source).toContain('const applyPickedPath = (path: string): void =>')
    expect(source).toContain("if (pickerTarget.current === 'tasks') setTaskDir(path)")
    // The inline browser must not hardcode the workspace field any more.
    expect(source).toContain('applyPickedPath(browser.listing.path)')
    expect(source).not.toContain('setWorkspaceRoot(browser.listing.path)')
  })
})

/**
 * The browse panel is the fallback whenever the host mounts the `browse` backend
 * instead of the OS chooser — the normal Desktop composition whenever remote
 * authorities are allowed (an OS dialog on the host would be reachable by a remote
 * browser). Clicking down eight levels to reach a known path is what made the
 * panel feel useless, so it accepts a path directly.
 */
describe('browse panel: direct path jump', () => {
  it('takes an absolute path instead of requiring level-by-level clicking', () => {
    expect(source).toContain("'data-a2a-browser-path': true")
    expect(source).toContain("'data-a2a-browser-jump': true")
    expect(source).toContain('openBrowser(browserPathDraft.trim(), pickerTarget.current)')
    // The draft follows navigation, so the shown path is always the real one.
    expect(source).toContain('setBrowserPathDraft(listing.path)')
    expect(source).toContain("t('browser.jump')")
  })
})
