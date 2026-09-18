export * as PluginDiscovery from "./discovery"

import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigMarkdown } from "@/config/markdown"
import { isRecord, Manifest } from "./manifest"
import { McpConfig } from "./mcp-config"
import { containsPath, expandList, expandRecord, resolveCwd } from "./paths"
import type { Issue } from "./manifest"

// Convention directory scanned inside every config directory, mirroring how
// commands, agents, and skills are discovered. No config schema change needed.
export const PLUGIN_DIR = "agent-plugins"

// Reverse-domain namespace owning opencode-specific behavior. Portable
// clients ignore it; opencode ignores namespaces it does not implement.
export const EXTENSION_NAMESPACE = "ai.opencode"

const HOOK_FILES = ["plugin.ts", "plugin.js"]

export interface ExtensionRef {
  dir: string
  entry: string | undefined
  options: Record<string, unknown>
  dataDir: string
}

const SKILL_FILE = "SKILL.md"
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface DiscoveredSkill {
  plugin: string
  name: string
  dir: string
}

export interface PluginLoad {
  root: string
  manifest: Manifest.Info | undefined
  skills: Array<DiscoveredSkill>
  mcp: McpConfig.Result | undefined
  extension?: ExtensionRef | undefined
  errors: Array<Issue>
  warnings: Array<Issue>
}

// Load and validate one plugin directory: manifest, fixed skills/ location,
// and mcp.json. Failures stay inside the returned issues; the effect never
// fails for invalid plugin content.
export const loadPluginDir = Effect.fn("Discovery.loadPluginDir")(function* (
  fs: FSUtil.Interface,
  root: string,
  dataRoot: string,
) {
  const errors: Array<Issue> = []
  const warnings: Array<Issue> = []

  const realRoot = yield* fs.realPath(root).pipe(Effect.catch(() => Effect.succeed(root)))
  const invalid = () => ({ root: realRoot, manifest: undefined, skills: [], mcp: undefined, errors, warnings })

  // Fixed files are opened through their realpath: a symlinked plugin.json
  // that resolves outside the plugin root makes the package invalid.
  const plugin = yield* realContained(fs, realRoot, path.join(root, "plugin.json"))
  if (!plugin.ok) {
    errors.push({
      path: [],
      message:
        plugin.reason === "outside"
          ? `plugin.json in ${root} resolves outside the plugin root`
          : `Missing plugin.json in ${root}`,
    })
    return invalid()
  }
  const raw = yield* fs.readJson(plugin.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (raw === undefined) {
    errors.push({ path: [], message: `Unreadable plugin.json in ${root}` })
    return invalid()
  }
  const parsed = Manifest.parse(raw)
  errors.push(...parsed.errors)
  warnings.push(...parsed.warnings)
  if (!parsed.ok || !parsed.manifest) return invalid()
  const manifest = parsed.manifest

  const skills = yield* collectSkills(fs, realRoot, manifest, warnings)
  const mcp = yield* readMcpConfig(fs, realRoot, manifest, errors, warnings)
  const extension = yield* loadExtension(fs, realRoot, path.join(dataRoot, manifest.name), manifest, warnings)
  return { root: realRoot, manifest, skills, mcp, extension, errors, warnings }
})

// Collect every plugin load across directories, then keep one load per
// plugin name. Directories arrive global-first, so a project package shadows
// a global one with the same name instead of loading twice.
function collectLoads(fs: FSUtil.Interface, dirs: Array<string>, dataRoot: string) {
  return Effect.gen(function* () {
    const seen: Array<PluginLoad> = []
    const errors: Array<Issue> = []
    const warnings: Array<Issue> = []
    for (const dir of dirs) {
      for (const root of yield* pluginRoots(fs, dir)) {
        const load = yield* loadPluginDir(fs, root, dataRoot)
        errors.push(...load.errors)
        warnings.push(...load.warnings)
        seen.push(load)
      }
    }
    const byName = new Map<string, PluginLoad>()
    for (const load of seen) {
      if (!load.manifest) continue
      const prior = byName.get(load.manifest.name)
      if (prior && prior.root !== load.root) {
        warnings.push({
          path: [],
          message: `Plugin "${load.manifest.name}" shadowed: ${load.root} overrides ${prior.root}`,
        })
      }
      byName.set(load.manifest.name, load)
    }
    return { loads: [...byName.values()], errors, warnings }
  })
}

// Discover skill directories inside every config directory.
export const loadSkills = Effect.fn("Discovery.loadSkills")(function* (
  fs: FSUtil.Interface,
  dirs: Array<string>,
  dataRoot: string,
) {
  const collected = yield* collectLoads(fs, dirs, dataRoot)
  return {
    skills: collected.loads.flatMap((load) => load.skills),
    errors: collected.errors,
    warnings: collected.warnings,
  }
})

// Discover MCP servers and map them onto native config entries. Entries
// colliding with user config keys are skipped so user config always wins.
export const loadMcp = Effect.fn("Discovery.loadMcp")(function* (
  fs: FSUtil.Interface,
  dirs: Array<string>,
  dataRoot: string,
  userKeys: Set<string>,
) {
  const collected = yield* collectLoads(fs, dirs, dataRoot)
  const servers: Record<string, ConfigMCPV1.Info> = {}
  const errors: Array<Issue> = [...collected.errors]
  const warnings: Array<Issue> = [...collected.warnings]
  for (const load of collected.loads) {
    if (!load.manifest || !load.mcp || !load.mcp.ok) continue
    const mapped = yield* mapServers(fs, load.root, dataRoot, load.manifest, load.mcp, errors, warnings)
    for (const [key, server] of Object.entries(mapped)) {
      if (userKeys.has(key) || servers[key]) {
        warnings.push({ path: [], message: `MCP server "${key}" skipped: name already in use` })
        continue
      }
      servers[key] = server
    }
  }
  return { servers, errors, warnings }
})

function pluginRoots(fs: FSUtil.Interface, dir: string) {
  return fs.readDirectoryEntries(path.join(dir, PLUGIN_DIR)).pipe(
    Effect.catch(() => Effect.succeed([])),
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.type === "directory" || entry.type === "symlink")
        .map((entry) => path.join(dir, PLUGIN_DIR, entry.name))
        .sort(),
    ),
  )
}

type ContainedPath = { ok: true; path: string } | { ok: false; reason: "missing" | "outside" }

// Resolve a package path through symlinks and confirm it stays inside root.
// Every discovered file and directory goes through this before it is read or
// executed, matching the specification's containment failure boundaries.
function realContained(fs: FSUtil.Interface, root: string, candidate: string): Effect.Effect<ContainedPath> {
  return Effect.gen(function* () {
    const real = yield* fs.realPath(candidate).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (real === undefined) return { ok: false, reason: "missing" } as const
    if (!containsPath(root, real)) return { ok: false, reason: "outside" } as const
    return { ok: true, path: real } as const
  })
}

// Plugin data lives in a writable directory that persists across updates. A
// failure to create it is reported but never fails plugin loading.
function ensurePluginData(fs: FSUtil.Interface, dir: string, manifest: Manifest.Info, warnings: Array<Issue>) {
  return fs.ensureDir(dir).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        warnings.push({ path: [], message: `Plugin "${manifest.name}": data directory unavailable` })
      }),
    ),
  )
}

// Surface plugin issues from any service with one consistent log shape.
export function logIssues(issues: Array<Issue>): Effect.Effect<void> {
  return Effect.forEach(
    issues,
    (issue) => Effect.logWarning("agent plugin issue", { path: issue.path, message: issue.message }),
    { discard: true },
  )
}

function collectSkills(fs: FSUtil.Interface, realRoot: string, manifest: Manifest.Info, warnings: Array<Issue>) {
  return Effect.gen(function* () {
    const skills: Array<DiscoveredSkill> = []
    const skillsDir = path.join(realRoot, "skills")
    if (!(yield* fs.existsSafe(skillsDir))) return skills
    // Present but not a directory: report the invalid component type (§6.2)
    // and keep loading the rest of the plugin.
    if (!(yield* fs.isDir(skillsDir))) {
      warnings.push({ path: [], message: `skills in plugin "${manifest.name}" is not a directory; skills disabled` })
      return skills
    }
    const entries = yield* fs.readDirectoryEntries(skillsDir).pipe(Effect.catch(() => Effect.succeed([])))
    for (const entry of entries) {
      if (entry.type !== "directory" && entry.type !== "symlink") continue
      const skill = yield* collectSkill(fs, realRoot, manifest, path.join(skillsDir, entry.name), warnings)
      if (skill) skills.push(skill)
    }
    return skills
  })
}

function collectSkill(
  fs: FSUtil.Interface,
  realRoot: string,
  manifest: Manifest.Info,
  dir: string,
  warnings: Array<Issue>,
) {
  return Effect.gen(function* () {
    const dirResult = yield* realContained(fs, realRoot, dir)
    if (!dirResult.ok) {
      warnings.push({ path: [], message: `Skill "${dir}" skipped: escapes plugin root` })
      return undefined
    }
    const real = dirResult.path
    const file = path.join(real, SKILL_FILE)
    if (!(yield* fs.isFile(file))) return undefined
    // A discovered SKILL.md that resolves outside the plugin root is skipped.
    const fileResult = yield* realContained(fs, realRoot, file)
    if (!fileResult.ok) {
      warnings.push({ path: [], message: `Skill "${dir}" skipped: SKILL.md escapes plugin root` })
      return undefined
    }
    const md = yield* Effect.tryPromise({
      try: () => ConfigMarkdown.parse(fileResult.path),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!md || !isRecord(md.data)) {
      warnings.push({ path: [], message: `Skill "${dir}" skipped: unreadable frontmatter` })
      return undefined
    }
    const name = md.data["name"]
    // Portable skill names are kebab-case and match their directory, so one
    // plugin cannot shadow another plugin's skill under a foreign name.
    if (typeof name !== "string" || !KEBAB.test(name)) {
      warnings.push({ path: [], message: `Skill "${dir}" skipped: invalid name` })
      return undefined
    }
    if (name !== path.basename(real)) {
      warnings.push({ path: [], message: `Skill "${dir}" skipped: name must match directory` })
      return undefined
    }
    return { plugin: manifest.name, name, dir: real }
  })
}

function readMcpConfig(
  fs: FSUtil.Interface,
  realRoot: string,
  manifest: Manifest.Info,
  errors: Array<Issue>,
  warnings: Array<Issue>,
) {
  return Effect.gen(function* () {
    const file = yield* realContained(fs, realRoot, path.join(realRoot, "mcp.json"))
    if (!file.ok) {
      // Missing mcp.json means no MCP servers; an escaping one disables MCP
      // for the plugin without failing its other components.
      if (file.reason === "outside") {
        errors.push({ path: [], message: `mcp.json in plugin "${manifest.name}" resolves outside the plugin root` })
      }
      return undefined
    }
    // Present but not a regular file: report the invalid component type (§6.2).
    if (!(yield* fs.isFile(file.path))) {
      errors.push({ path: [], message: `mcp.json in plugin "${manifest.name}" is not a regular file` })
      return undefined
    }
    const text = yield* fs.readFileStringSafe(file.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (text === undefined) return undefined
    const decoded = Schema.decodeUnknownExit(Schema.UnknownFromJsonString)(text)
    if (!Exit.isSuccess(decoded)) {
      errors.push({ path: [], message: `Invalid mcp.json in plugin "${manifest.name}": not valid JSON` })
      return undefined
    }
    const parsed = McpConfig.parse(decoded.value, manifest.$schema)
    errors.push(...parsed.errors)
    warnings.push(...parsed.warnings)
    if (!parsed.ok) return undefined
    return parsed
  })
}

function loadExtension(
  fs: FSUtil.Interface,
  realRoot: string,
  dataDir: string,
  manifest: Manifest.Info,
  warnings: Array<Issue>,
) {
  return Effect.gen(function* () {
    const dir = path.join(realRoot, EXTENSION_NAMESPACE)
    if (!(yield* fs.isDir(dir))) return undefined
    const dirResult = yield* realContained(fs, realRoot, dir)
    if (!dirResult.ok) {
      warnings.push({ path: [], message: `Extension "${dir}" skipped: escapes plugin root` })
      return undefined
    }
    const real = dirResult.path
    const options = manifest.extensions?.[EXTENSION_NAMESPACE] ?? {}
    if (options["enabled"] === false) return undefined
    yield* ensurePluginData(fs, dataDir, manifest, warnings)
    let entry: string | undefined
    for (const file of HOOK_FILES) {
      const candidate = path.join(real, file)
      if (yield* fs.isFile(candidate)) {
        entry = candidate
        break
      }
    }
    return { dir: real, entry, options, dataDir }
  })
}

// Discover enabled opencode extensions. The caller decides which extension
// parts to consume; a missing JS entry only means no lifecycle hooks.
export const loadExtensions = Effect.fn("Discovery.loadExtensions")(function* (
  fs: FSUtil.Interface,
  dirs: Array<string>,
  dataRoot: string,
) {
  const collected = yield* collectLoads(fs, dirs, dataRoot)
  const extensions: Array<{ root: string; name: string; extension: ExtensionRef }> = []
  for (const load of collected.loads) {
    if (!load.manifest || !load.extension) continue
    extensions.push({ root: load.root, name: load.manifest.name, extension: load.extension })
  }
  return { extensions, errors: collected.errors, warnings: collected.warnings }
})

function mapServers(
  fs: FSUtil.Interface,
  realRoot: string,
  dataRoot: string,
  manifest: Manifest.Info,
  mcp: McpConfig.Result,
  errors: Array<Issue>,
  warnings: Array<Issue>,
) {
  return Effect.gen(function* () {
    const servers: Record<string, ConfigMCPV1.Info> = {}
    const dataDir = path.join(dataRoot, manifest.name)
    yield* ensurePluginData(fs, dataDir, manifest, warnings)
    const vars = { root: realRoot, data: dataDir }
    for (const [name, result] of Object.entries(mcp.servers)) {
      const key = `${manifest.name}-${name}`
      if (!result.ok || !result.server) {
        errors.push(...result.errors.map((issue) => ({ ...issue, path: [key, ...issue.path] })))
        continue
      }
      const server = result.server
      if (server.type === "stdio") {
        const mapped = yield* mapStdio(fs, vars, key, server, errors)
        if (mapped) servers[key] = mapped
        continue
      }
      if (server.type === "streamable-http") {
        servers[key] = { type: "remote", url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
        continue
      }
      if (server.type === "sse") {
        // Opencode remotes always attempt Streamable HTTP first, so a declared
        // sse transport cannot be honored as the initial attempt. Skip loudly.
        warnings.push({ path: [], message: `MCP server "${key}" skipped: sse transport not supported` })
        continue
      }
    }
    return servers
  })
}

function mapStdio(
  fs: FSUtil.Interface,
  vars: { root: string; data: string },
  key: string,
  server: Extract<McpConfig.Server, { type: "stdio" }>,
  errors: Array<Issue>,
) {
  return Effect.gen(function* () {
    const command = server.command.startsWith("./")
      ? yield* resolveContained(fs, vars.root, server.command, key, errors)
      : server.command
    if (command === undefined) return undefined
    const lexical = resolveCwd(server.cwd, vars)
    if (lexical === undefined) {
      errors.push({ path: [key, "cwd"], message: `MCP server "${key}" skipped: cwd is not a portable form` })
      return undefined
    }
    // The working directory is created when missing, then resolved through
    // symlinks: a ./-entry pointing outside its base is rejected even when
    // the lexical path looks contained.
    yield* fs.ensureDir(lexical).pipe(Effect.catch(() => Effect.void))
    const cwd = yield* fs.realPath(lexical).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (cwd === undefined || (!containsPath(vars.root, cwd) && !containsPath(vars.data, cwd))) {
      errors.push({ path: [key, "cwd"], message: `MCP server "${key}" skipped: cwd escapes its base` })
      return undefined
    }
    return {
      type: "local",
      command: [command, ...expandList(server.args ?? [], vars)],
      cwd,
      environment: {
        ...expandRecord(server.env ?? {}, vars),
        PLUGIN_ROOT: vars.root,
        PLUGIN_DATA: vars.data,
      },
    } satisfies ConfigMCPV1.Info
  })
}

function resolveContained(fs: FSUtil.Interface, realRoot: string, command: string, key: string, errors: Array<Issue>) {
  return Effect.gen(function* () {
    const result = yield* realContained(fs, realRoot, path.resolve(realRoot, command))
    if (!result.ok) {
      const reason = result.reason === "outside" ? "command escapes plugin root" : "command not found"
      errors.push({ path: [key, "command"], message: `MCP server "${key}" skipped: ${reason}` })
      return undefined
    }
    // A bundled command must exist at discovery; bare names resolve through
    // the platform executable search at launch instead.
    if (!(yield* fs.isFile(result.path))) {
      errors.push({ path: [key, "command"], message: `MCP server "${key}" skipped: command not found` })
      return undefined
    }
    return result.path
  })
}
