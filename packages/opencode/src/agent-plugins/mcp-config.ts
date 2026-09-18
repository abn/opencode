export * as McpConfig from "./mcp-config"

import { classifyCwd } from "./paths"
import type { Issue } from "./manifest"

// Canonical identifier for Agent Plugins 1.0.0 MCP configuration. The version
// must match the one declared by the sibling plugin.json.
export const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

const KNOWN_TOP_LEVEL = new Set(["$schema", "mcpServers"])
const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"])
const REMOTE_FIELDS = new Set(["type", "url", "headers"])

export interface StdioServer {
  type: "stdio"
  command: string
  args?: Array<string>
  env?: Record<string, string>
  cwd?: string
}

export interface RemoteServer {
  type: "streamable-http" | "sse"
  url: string
  headers?: Record<string, string>
}

export type Server = StdioServer | RemoteServer

export interface ServerResult {
  ok: boolean
  server?: Server
  errors: Array<Issue>
}

export interface Result {
  ok: boolean
  servers: Record<string, ServerResult>
  errors: Array<Issue>
  warnings: Array<Issue>
}

// Validate an mcp.json value. Top-level violations disable MCP for the plugin
// but never fail sibling components; each invalid server entry is skipped
// while the rest keep loading.
export function parse(input: unknown, manifestSchema: string): Result {
  const errors: Array<Issue> = []
  const warnings: Array<Issue> = []
  const empty: Record<string, ServerResult> = {}
  if (!isRecord(input)) return { ok: false, servers: empty, errors: [{ path: [], message: "mcp.json must contain a top-level object" }], warnings }

  for (const key of Object.keys(input)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      errors.push({ path: [key], message: `Unknown top-level field "${key}"` })
      return { ok: false, servers: empty, errors, warnings }
    }
  }

  const schema = input["$schema"]
  // The MCP identifier differs from the manifest identifier; what must match
  // is the specification version both target.
  if (schema !== SCHEMA || schemaVersion(schema) !== schemaVersion(manifestSchema)) {
    errors.push({ path: ["$schema"], message: "mcp.json targets an unsupported or mismatched version" })
    return { ok: false, servers: empty, errors, warnings }
  }

  const entries = input["mcpServers"]
  if (!isRecord(entries)) {
    errors.push({ path: ["mcpServers"], message: 'Field "mcpServers" must be an object' })
    return { ok: false, servers: empty, errors, warnings }
  }

  const servers: Record<string, ServerResult> = {}
  for (const [name, entry] of Object.entries(entries)) servers[name] = parseServer(name, entry)
  return { ok: true, servers, errors, warnings }
}

function parseServer(name: string, entry: unknown): ServerResult {
  const errors: Array<Issue> = []
  const path = ["mcpServers", name]
  if (!isRecord(entry)) return { ok: false, errors: [{ path, message: "Server entry must be an object" }] }
  if (entry["type"] === "stdio") return parseStdio(path, entry)
  if (entry["type"] === "streamable-http" || entry["type"] === "sse") return parseRemote(path, entry)
  return { ok: false, errors: [{ path: [...path, "type"], message: 'Field "type" must be "stdio", "streamable-http", or "sse"' }] }
}

function parseStdio(path: Array<string>, entry: Record<string, unknown>): ServerResult {
  const errors: Array<Issue> = []
  for (const key of Object.keys(entry)) {
    if (!STDIO_FIELDS.has(key)) {
      errors.push({ path: [...path, key], message: `Unknown field "${key}" for stdio server` })
      return { ok: false, errors }
    }
  }
  const server: StdioServer = { type: "stdio", command: "" }
  const command = entry["command"]
  // A command is one executable token: a bare name or a ./-relative path.
  // Placeholders never expand here; ./-paths resolve against the plugin root.
  if (typeof command !== "string" || command.length === 0 || !isCommandToken(command)) {
    errors.push({ path: [...path, "command"], message: 'Field "command" must be a bare name or "./"-relative path' })
    return { ok: false, errors }
  }
  server.command = command

  if (entry["args"] !== undefined) {
    const args = entry["args"]
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      errors.push({ path: [...path, "args"], message: 'Field "args" must be an array of strings' })
      return { ok: false, errors }
    }
    server.args = args as Array<string>
  }

  if (entry["env"] !== undefined) {
    const env = readStringRecord(entry["env"])
    if (!env) {
      errors.push({ path: [...path, "env"], message: 'Field "env" must be an object of strings' })
      return { ok: false, errors }
    }
    for (const key of Object.keys(env)) {
      if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") {
        errors.push({ path: [...path, "env", key], message: `Reserved variable "${key}" must not be configured` })
        return { ok: false, errors }
      }
    }
    server.env = env
  }

  if (entry["cwd"] !== undefined) {
    const cwd = entry["cwd"]
    if (typeof cwd !== "string" || classifyCwd(cwd) === "invalid") {
      errors.push({ path: [...path, "cwd"], message: 'Field "cwd" must be "./"-relative, "${PLUGIN_ROOT}[/...]", or "${PLUGIN_DATA}[/...]"' })
      return { ok: false, errors }
    }
    server.cwd = cwd
  }
  return { ok: true, server, errors }
}

function parseRemote(path: Array<string>, entry: Record<string, unknown>): ServerResult {
  const errors: Array<Issue> = []
  for (const key of Object.keys(entry)) {
    if (!REMOTE_FIELDS.has(key)) {
      errors.push({ path: [...path, key], message: `Unknown field "${key}" for remote server` })
      return { ok: false, errors }
    }
  }
  const urlError = checkUrl(entry["url"])
  if (urlError) {
    errors.push({ path: [...path, "url"], message: urlError })
    return { ok: false, errors }
  }
  const server: RemoteServer = { type: entry["type"] as RemoteServer["type"], url: entry["url"] as string }
  if (entry["headers"] !== undefined) {
    const headers = readStringRecord(entry["headers"])
    if (!headers) {
      errors.push({ path: [...path, "headers"], message: 'Field "headers" must be an object of strings' })
      return { ok: false, errors }
    }
    const seen = new Set<string>()
    for (const name of Object.keys(headers)) {
      if (!isHeaderName(name)) {
        errors.push({ path: [...path, "headers", name], message: `Invalid header name "${name}"` })
        return { ok: false, errors }
      }
      const folded = name.toLowerCase()
      if (seen.has(folded)) {
        errors.push({ path: [...path, "headers", name], message: `Duplicate header "${name}"` })
        return { ok: false, errors }
      }
      seen.add(folded)
      if (!isHeaderValue(headers[name])) {
        errors.push({ path: [...path, "headers", name], message: `Invalid header value for "${name}"` })
        return { ok: false, errors }
      }
    }
    server.headers = headers
  }
  return { ok: true, server, errors }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function schemaVersion(schema: unknown): string | undefined {
  if (typeof schema !== "string") return undefined
  return /\/schemas\/(\d+\.\d+\.\d+)\//.exec(schema)?.[1]
}

function isCommandToken(command: string): boolean {
  // Syntax-only: a single token with no shell metacharacters or separators.
  // Containment (../ escapes, symlinks, existence) is enforced later by
  // Discovery.resolveContained via realpath, which runs before any plugin
  // command is launched.
  if (command.startsWith("./")) return command.length > 2 && !command.includes("\\") && !/\s/.test(command)
  return command.length > 0 && !/[\s/\\]/.test(command)
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  for (const entry of Object.values(value)) {
    if (typeof entry !== "string") return undefined
  }
  return value as Record<string, string>
}

// Absolute http(s) URL, no userinfo or fragment. Plain http stays opt-in for
// loopback hosts only; everything else requires https.
function checkUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return 'Field "url" must be a string'
  const parsed = parseUrl(value)
  if (!parsed) return 'Field "url" must be an absolute http or https URL'
  if (parsed.username !== "" || parsed.password !== "") return 'Field "url" must not contain user information'
  if (parsed.hash !== "") return 'Field "url" must not contain a fragment'
  if (parsed.protocol === "https:") return undefined
  if (isLoopback(parsed.hostname)) return undefined
  return 'Non-loopback "url" must use https'
}

function parseUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed
  } catch {
    return undefined
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1")
  if (host === "localhost") return true
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) return true
  if (host === "::1") return true
  return false
}

function isHeaderName(name: string): boolean {
  if (name.length === 0 || name.length > 128) return false
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
}

function isHeaderValue(value: string): boolean {
  // Visible ASCII plus obs-text, no bare CR or LF.
  return /^[\t \x21-\x7E\x80-\xFF]*$/.test(value)
}
