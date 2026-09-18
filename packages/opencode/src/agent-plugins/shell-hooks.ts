export * as ShellHooks from "./shell-hooks"

import type { Hooks } from "@opencode-ai/plugin"
import { Effect, Exit, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { expandPlaceholders } from "./paths"
import type { Issue } from "./manifest"

export const HOOKS_FILE = "hooks/hooks.json"
const TIMEOUT_MS = 60_000
const CLAUDE_ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}"

// Lifecycle events with a direct opencode trigger mapping. The remaining
// events (SessionStart, UserPromptSubmit, Stop, SubagentStart, SubagentStop,
// PreCompact) have no trigger surface yet; they load with a warning.
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"])
const KNOWN_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
])

export interface ShellCommand {
  command: string
  matcher?: string
}

export interface Parsed {
  preToolUse: Array<ShellCommand>
  postToolUse: Array<ShellCommand>
  warnings: Array<Issue>
}

export interface Vars {
  root: string
  data: string
}

// Parse a hooks/hooks.json value. Unknown events and malformed entries are
// skipped with warnings; valid entries keep loading.
export function parse(input: unknown): Parsed {
  const warnings: Array<Issue> = []
  const empty: Parsed = { preToolUse: [], postToolUse: [], warnings }
  if (!isRecord(input) || !isRecord(input["hooks"])) {
    warnings.push({ path: ["hooks"], message: "hooks.json must contain a hooks object" })
    return empty
  }
  for (const [event, entries] of Object.entries(input["hooks"])) {
    if (!KNOWN_EVENTS.has(event)) {
      warnings.push({ path: ["hooks", event], message: `Unknown hook event "${event}" ignored` })
      continue
    }
    if (!Array.isArray(entries)) {
      warnings.push({ path: ["hooks", event], message: `Hook event "${event}" must be an array` })
      continue
    }
    const commands = flatten(event, entries, warnings)
    if (!TOOL_EVENTS.has(event)) {
      if (commands.length > 0) {
        warnings.push({ path: ["hooks", event], message: `Hook event "${event}" has no trigger mapping yet` })
      }
      continue
    }
    if (event === "PreToolUse") empty.preToolUse.push(...commands)
    else empty.postToolUse.push(...commands)
  }
  return empty
}

function flatten(event: string, entries: Array<unknown>, warnings: Array<Issue>): Array<ShellCommand> {
  const commands: Array<ShellCommand> = []
  for (const entry of entries) {
    if (isMatcherEntry(entry)) {
      for (const nested of entry.hooks) {
        const command = readCommand(nested)
        if (command === undefined) {
          warnings.push({ path: ["hooks", event], message: `Hook entry in "${event}" must set a command string` })
          continue
        }
        commands.push({ command: command.command, matcher: command.matcher ?? entry.matcher })
      }
      continue
    }
    const command = readCommand(entry)
    if (command === undefined) {
      warnings.push({ path: ["hooks", event], message: `Hook entry in "${event}" must set a command string` })
      continue
    }
    commands.push(command)
  }
  return commands
}

interface CommandEntry {
  command: string
  matcher?: string
}

function isMatcherEntry(entry: unknown): entry is { matcher?: string; hooks: Array<unknown> } {
  return isRecord(entry) && Array.isArray(entry["hooks"])
}

function readCommand(entry: unknown): CommandEntry | undefined {
  if (!isRecord(entry) || entry["type"] !== "command" || typeof entry["command"] !== "string") return undefined
  if (entry["command"].length === 0) return undefined
  const matcher = entry["matcher"]
  if (matcher !== undefined && typeof matcher !== "string") return undefined
  return matcher === undefined ? { command: entry["command"] } : { command: entry["command"], matcher }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Expand plugin placeholders in a hook command. ${CLAUDE_PLUGIN_ROOT} stays
// as a compatibility alias for ${PLUGIN_ROOT}; anything else stays literal.
// Substitutions are POSIX single-quoted: hook commands run through sh, and
// config-directory paths may contain spaces or metacharacters.
export function expand(command: string, vars: Vars): string {
  const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const aliased = command.split(CLAUDE_ROOT_VAR).join(quoted(vars.root))
  return expandPlaceholders(aliased, { root: quoted(vars.root), data: quoted(vars.data) })
}

const patternCache = new Map<string, RegExp | undefined>()

// Match a tool name against an optional matcher. Matchers are regular
// expressions compiled once and cached; an invalid pattern falls back to
// substring matching. Patterns come from plugin files, which already execute
// arbitrary shell, so matchers share the command trust level.
export function matches(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined) return true
  let pattern = patternCache.get(matcher)
  if (!patternCache.has(matcher)) {
    try {
      pattern = new RegExp(matcher)
    } catch {
      pattern = undefined
    }
    patternCache.set(matcher, pattern)
  }
  if (pattern) return pattern.test(tool)
  return tool.includes(matcher)
}

export interface RunResult {
  exit: number
  stdout: string
  stderr: string
}

// Run one hook command with the event payload on stdin. The command always
// runs through sh with the plugin root as cwd; PLUGIN_ROOT, PLUGIN_DATA, and
// CLAUDE_PLUGIN_ROOT are set for the child. A command that outlives the
// timeout is terminated (TERM, then KILL after a grace period) and reported
// as exit 124, so one hung plugin can delay but never stall tool execution.
export async function run(command: string, payload: unknown, vars: Vars, timeoutMs = TIMEOUT_MS): Promise<RunResult> {
  const child = Bun.spawn(["sh", "-c", command], {
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    cwd: vars.root,
    env: {
      ...process.env,
      PLUGIN_ROOT: vars.root,
      PLUGIN_DATA: vars.data,
      CLAUDE_PLUGIN_ROOT: vars.root,
    },
  })
  const done = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(
    ([stdout, stderr, exit]) => ({ exit, stdout, stderr }),
  )
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
      }, Math.min(5000, timeoutMs))
      resolve(undefined)
    }, timeoutMs)
  })
  try {
    const finished = await Promise.race([done, deadline.then(() => undefined)])
    if (finished) return finished
    return { exit: 124, stdout: "", stderr: `hook timed out after ${timeoutMs / 1000}s` }
  } finally {
    clearTimeout(killTimer)
  }
}

// Build observer hooks from parsed shell commands. PreToolUse and PostToolUse
// fire around every matching tool call; failures are logged, never thrown,
// and shell output never mutates the call.
export function build(parsed: Parsed, vars: Vars, plugin: string): Hooks {
  return {
    "tool.execute.before": async (input, output) => {
      for (const entry of parsed.preToolUse) {
        if (!matches(entry.matcher, input.tool)) continue
        const result = await run(expand(entry.command, vars), { ...input, args: output.args }, vars).catch(
          () => undefined,
        )
        if (!result) continue
        if (result.exit !== 0) {
          console.warn(`agent plugin ${plugin} PreToolUse hook failed: ${result.stderr.trim()}`)
        }
      }
    },
    "tool.execute.after": async (input, output) => {
      for (const entry of parsed.postToolUse) {
        if (!matches(entry.matcher, input.tool)) continue
        const result = await run(expand(entry.command, vars), { ...input, ...output }, vars).catch(() => undefined)
        if (!result) continue
        if (result.exit !== 0) {
          console.warn(`agent plugin ${plugin} PostToolUse hook failed: ${result.stderr.trim()}`)
        }
      }
    },
  }
}

// Load hooks/hooks.json from an extension directory. Missing files mean no
// shell hooks; malformed files mean no shell hooks plus warnings.
export const loadFile = Effect.fn("ShellHooks.loadFile")(function* (
  fs: FSUtil.Interface,
  dir: string,
  vars: Vars,
  plugin: string,
) {
  const warnings: Array<Issue> = []
  const text = yield* fs.readFileStringSafe(`${dir}/${HOOKS_FILE}`).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (text === undefined) return undefined
  const decoded = Schema.decodeUnknownExit(Schema.UnknownFromJsonString)(text)
  if (!Exit.isSuccess(decoded)) {
    warnings.push({ path: [HOOKS_FILE], message: `Invalid ${HOOKS_FILE} in plugin "${plugin}": not valid JSON` })
    return { hooks: undefined, warnings }
  }
  const parsed = parse(decoded.value)
  warnings.push(...parsed.warnings)
  if (parsed.preToolUse.length === 0 && parsed.postToolUse.length === 0) return { hooks: undefined, warnings }
  return { hooks: build(parsed, vars, plugin), warnings }
})
