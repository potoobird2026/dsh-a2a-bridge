/**
 * Host-side copy that an operator (in logs) or a peer (in an A2A error) sees.
 *
 * WHY ONE FILE: these strings sit in four modules today. Scattered, nobody can
 * answer "what does this deployment actually tell a peer?" by reading one place,
 * and a future translation has no entry point. The audit rule (`host-locale`,
 * advisory) asks for exactly this consolidation — but it used to flag the table
 * itself, which made its own advice impossible to follow. The rule now exempts
 * THIS file and nothing else.
 *
 * Why Host text is advisory rather than a hard failure: DSH's locale channel is a
 * CLIENT concern. The Host has no `t()` at runtime, so these strings cannot be
 * translated live — they can only be kept findable.
 *
 * Rules for this file: user/peer-facing copy only, no logic, no imports. Anything
 * interpolated stays at the call site so the literal here is the reviewable unit.
 */

export const HOST_MESSAGES = Object.freeze({
  /** Peer-visible: the JSON-RPC error body when no model is bound. */
  modelNotSelected:
    'A2A 尚未选择模型：请在 DSH 的「插件 → A2A 桥接 → 配置」中选择本机已配置的 provider 与 model 后重试。',
  /** Log warning: the preset could not be mounted, so the session is tool-less. */
  presetMountFailed: 'a2a: agent preset 挂载失败，本会话将没有执行工具',
  /** Log warning: no per-session working directory, so isolation is off. */
  workingDirectoryUnavailable: 'a2a: workingDirectory 服务不可用，A2A 会话将与工作区共用目录',
  /** Log warning: no preset resolved at all. */
  presetNotConfigured: 'a2a: 未指定 agent preset，A2A 会话将没有执行工具',
  /** Continuation of the warning above; kept separate so the reason sits between. */
  presetNotConfiguredHint: '请在插件页 inbound.agentPreset 选择，或在部署中声明默认 preset',
  /** Tool output: `a2a_list` with no configured contacts. */
  noContacts: '（未配置任何远程 A2A agent）',
  /** Outbound progress labels, mirrored into the local conversation. */
  progressDelegating: '正在委派给',
  progressWaiting: '远端状态：已接收，等待任务结束',
  progressCompleted: '收到回复',
  progressFailed: '远端调用失败',
  progressAborted: '远端调用已取消',
  /** Inbound (C1) progress milestones, emitted as streaming statusUpdate frames. */
  progressAgentReady: '会话已就绪',
  progressFollowupSent: '已发送，等待模型',
  progressTurnIdle: '模型已结束，正在收集回复',
})

/**
 * One `a2a_list` line for a contact whose card could not be fetched.
 *
 * A function rather than a template constant so the surrounding ASCII stays at the
 * call site and this file only owns the wording.
 */
export function probeFailedLine(name: string, url: string, error: unknown): string {
  return `- ${name}: ${url} (探测失败: ${String(error)})`
}
