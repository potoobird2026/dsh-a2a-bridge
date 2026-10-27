#!/usr/bin/env node
/**
 * Live acceptance checks for dsh-a2a-bridge.
 *
 * WHY THIS EXISTS: every verification round so far needed a human to run several
 * ad-hoc scripts and eyeball the output, and twice we drew the wrong conclusion
 * by inspecting a stale DSH process instead of the deployed build. This script
 * makes the whole matrix one command with explicit PASS/FAIL, so "it works" is a
 * reproducible observation rather than a memory of one.
 *
 * It is READ-ONLY toward the plugin: it sends A2A messages, reads the deployed
 * artifacts, and reads the Harness home. It never starts or restarts DSH.
 *
 * Configuration comes from the environment — nothing is hardcoded, because peers,
 * ports, tokens and the Harness home differ per machine:
 *
 *   A2A_LOCAL_URL    e.g. http://192.168.1.10:3081   (this machine's own bridge)
 *   A2A_REMOTE_URL   e.g. http://192.168.1.11:3081   (the peer's bridge)
 *   A2A_TOKEN        the shared Bearer token (or A2A_TOKEN_FILE pointing at it)
 *   DSH_HOME         optional; defaults to ~/.dsh
 *
 * Exit code 0 only when every REQUIRED check passes.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const results = []
function record(name, ok, detail, required = true) {
  results.push({ name, ok, detail, required })
  const tag = ok === undefined ? 'SKIP' : ok ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function env(name) {
  const value = process.env[name]
  return value === undefined || value.length === 0 ? undefined : value
}

function token() {
  const direct = env('A2A_TOKEN')
  if (direct !== undefined) return direct
  const file = env('A2A_TOKEN_FILE')
  if (file !== undefined && existsSync(file)) return readFileSync(file, 'utf8').trim()
  return undefined
}

async function post(url, body, headers) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  const text = await response.text()
  return { status: response.status, text }
}

function sendBody(text) {
  // No `contextId` on purpose: the plugin must derive a STABLE one from the
  // project, which is exactly requirement #3. Passing one would hide a regression.
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text }],
      },
      configuration: { returnImmediately: false },
    },
  }
}

const bridgeUrl = (base) => `${base.replace(/\/$/, '')}/a2a`
const cardUrl = (base) => `${base.replace(/\/$/, '')}/.well-known/agent-card.json`

async function main() {
  const local = env('A2A_LOCAL_URL')
  const remote = env('A2A_REMOTE_URL')
  const bearer = token()
  if (bearer === undefined) {
    console.error('missing A2A_TOKEN (or A2A_TOKEN_FILE)')
    process.exit(2)
  }

  console.log('1. Agent Cards')
  for (const [label, base] of [
    ['local', local],
    ['remote', remote],
  ]) {
    if (base === undefined) {
      record(`${label} agent card`, undefined, 'no URL configured', false)
      continue
    }
    try {
      const response = await fetch(cardUrl(base), { signal: AbortSignal.timeout(15_000) })
      const card = await response.json()
      record(`${label} agent card`, response.status === 200 && typeof card.name === 'string', `HTTP ${response.status} name=${card.name}`)
      // The card and the dispatcher share ONE constant, so this also tells you
      // whether the running build has inbound streaming at all.
      record(
        `${label} card advertises streaming`,
        card?.capabilities?.streaming === true,
        `capabilities.streaming=${String(card?.capabilities?.streaming)}`,
        false,
      )
    } catch (error) {
      record(`${label} agent card`, false, String(error))
    }
  }

  if (local === undefined) {
    console.log('2-4. skipped (no A2A_LOCAL_URL)')
    return finish()
  }

  console.log('2. Session continuity (requirement #3) — two sends, no contextId')
  let first
  let second
  try {
    const a = await post(bridgeUrl(local), sendBody('Reply with exactly: ONE'), {
      'a2a-version': '1.0',
      authorization: `Bearer ${bearer}`,
    })
    first = JSON.parse(a.text)
    const b = await post(bridgeUrl(local), sendBody('Reply with exactly: TWO'), {
      'a2a-version': '1.0',
      authorization: `Bearer ${bearer}`,
    })
    second = JSON.parse(b.text)
    const c1 = first?.result?.task?.contextId
    const c2 = second?.result?.task?.contextId
    const s1 = first?.result?.task?.metadata?.dsh?.sessionId
    const s2 = second?.result?.task?.metadata?.dsh?.sessionId
    record('contextId is stable across two sends', c1 !== undefined && c1 === c2, `${c1} vs ${c2}`)
    record('sessionId is stable across two sends', s1 !== undefined && s1 === s2, `${s1} vs ${s2}`)
    const state1 = first?.result?.task?.status?.state
    const reply1 = first?.result?.task?.status?.message?.parts?.[0]?.text
    record('task settles COMPLETED', state1 === 'TASK_STATE_COMPLETED', `${state1} reply=${JSON.stringify(reply1)}`)
  } catch (error) {
    record('session continuity probe', false, String(error))
  }

  console.log('3. Workspace directory naming — must NOT carry a timestamp (requirement #2)')
  const home = env('DSH_HOME') ?? join(homedir(), '.dsh')
  const roots = [join(home, 'a2a-workspaces')]
  let newest = undefined
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const peerDir of readdirSync(root)) {
      const peerPath = join(root, peerDir)
      if (!statSync(peerPath).isDirectory()) continue
      for (const entry of readdirSync(peerPath)) {
        const path = join(peerPath, entry)
        if (!statSync(path).isDirectory()) continue
        const mtime = statSync(path).mtimeMs
        if (newest === undefined || mtime > newest.mtime) newest = { path, mtime, name: entry }
      }
    }
  }
  if (newest === undefined) {
    record('session directory under the A2A workspace root', undefined, 'none found yet', false)
  } else {
    // The pre-fix naming embedded MMDD-HHMMSS; the fixed naming is
    // `<prefix>-<peer>-<24 hex>`. A timestamp means a STALE build is running.
    const timestamped = /\d{4}-\d{6}/.test(newest.name)
    record('newest session dir has no timestamp', !timestamped, newest.name)
  }

  console.log('4. Mirror session (requirement #1) — a session whose events include our message')
  // We cannot unseal the session log from here, so this is an advisory signal: an
  // outbound mirror writes into a session whose cwd lives under a2a-workspaces,
  // and each write bumps that session's mtime. Count recent ones for the operator.
  let recent = 0
  const sessionsRoot = join(home, 'sessions')
  if (existsSync(sessionsRoot)) {
    const cutoff = Date.now() - 10 * 60_000
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        const info = statSync(path)
        if (info.isDirectory()) {
          if (path.includes('a2a-workspaces')) recent += 1
          walk(path)
        }
      }
    }
    try {
      walk(sessionsRoot)
    } catch {
      /* a broken store must not fail the run */
    }
  }
  record('sessions under a2a-workspaces exist', recent > 0, `${recent} session director${recent === 1 ? 'y' : 'ies'}`, false)

  console.log('5. Task state machine — GetTask / CancelTask against the task just handed out')
  // This is the ONLY end-to-end check of the persisted task store: the unit tests
  // drive the executor seam, this drives the real listener over HTTP.
  const taskId = first?.result?.task?.id
  if (typeof taskId !== 'string' || taskId.length === 0) {
    record('GetTask round-trip', undefined, 'no task id from SendMessage', false)
  } else {
    const auth = { 'a2a-version': '1.0', authorization: `Bearer ${bearer}` }
    try {
      const got = await post(bridgeUrl(local), {
        jsonrpc: '2.0',
        id: 1,
        method: 'GetTask',
        params: { id: taskId },
      }, auth)
      const payload = JSON.parse(got.text)
      // A2A shape: GetTask's `result` IS the Task, not `{ task }`. A build that
      // still stubs the method answers -32001 for a task it JUST returned, which
      // is what makes this a useful staleness probe.
      const task = payload?.result
      const ok = task?.id === taskId && typeof task?.status?.state === 'string'
      record(
        'GetTask returns the task it just returned',
        ok,
        ok ? `${task.id} ${task.status.state}` : `payload=${String(got.text).slice(0, 180)}`,
      )
    } catch (error) {
      record('GetTask round-trip', false, String(error))
    }

    try {
      const canceled = await post(bridgeUrl(local), {
        jsonrpc: '2.0',
        id: 1,
        method: 'CancelTask',
        params: { id: taskId },
      }, auth)
      const code = JSON.parse(canceled.text)?.error?.code
      // A settled task must be refused with -32002 ("not cancelable"), NOT -32001
      // ("unknown"): conflating them would hide the fact that the task WAS found.
      record('CancelTask refuses a settled task with -32002', code === -32002, `code=${code}`)
    } catch (error) {
      record('CancelTask probe', false, String(error))
    }
  }

  console.log('6. Inbound streaming — a capability is only real if it really streams')
  // `stream: false` would make this a plain JSON answer; that is exactly the
  // silent downgrade the dispatcher is written to avoid, so the content type is
  // asserted and not just the status code.
  try {
    const auth = { 'a2a-version': '1.0', authorization: `Bearer ${bearer}` }
    const response = await fetch(bridgeUrl(local), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendStreamingMessage',
        params: {
          message: {
            messageId: crypto.randomUUID(),
            role: 'ROLE_USER',
            parts: [{ text: 'Reply with exactly: ONE' }],
          },
        },
      }),
      signal: AbortSignal.timeout(180_000),
    })
    const contentType = response.headers.get('content-type') ?? ''
    const body = await response.text()
    const frames = body.split('\n\n').filter((part) => part.trim().length > 0)
    record(
      'SendStreamingMessage answers text/event-stream',
      response.status === 200 && contentType.includes('text/event-stream'),
      `HTTP ${response.status} ${contentType}`,
    )
    record('the stream carries at least 3 frames', frames.length >= 3, `${frames.length} frame(s)`)
    record(
      'every frame echoes the request id',
      frames.length > 0 && frames.every((frame) => frame.includes('"id":1')),
      `${frames.length} checked`,
    )
    const last = frames[frames.length - 1] ?? ''
    // v1.0 has no `final` flag: the CLOSING frame carries the terminal state.
    record(
      'the last frame reports a terminal state',
      last.includes('TASK_STATE_COMPLETED') || last.includes('TASK_STATE_FAILED'),
      last.startsWith('data: ') ? last.slice(0, 160) : '(no frame)',
    )
  } catch (error) {
    record('streaming probe', false, String(error))
  }

  finish()
}

function finish() {
  const failed = results.filter((entry) => entry.required && entry.ok === false)
  const skipped = results.filter((entry) => entry.ok === undefined)
  console.log('')
  console.log(`summary: ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`)
  if (failed.length > 0) {
    console.log('failed checks:')
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error(`verify-live crashed: ${String(error)}`)
  process.exit(2)
})
