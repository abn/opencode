export * as AgentPlugins from "./discovery.js"

import path from "path"
import { Cause, Effect, Exit, Scope, Schema, Stream } from "effect"
import type { ServerConfig } from "@opencode/schema/mcp"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigMarkdown } from "../config/markdown.js"
import { Watcher } from "../filesystem/watcher.js"
import { isRecord, Manifest } from "./manifest.js"
import { McpConfig } from "./mcp-config.js"
import { containsPath, classifyCwd, expandList, expandRecord, resolveCwd } from "./paths.js"
import type { Issue } from "./manifest.js"

// Convention directory scanned inside every config directory, mirroring how
// commands, agents, and skills are discovered. No config schema change needed.
export const PLUGIN_DIR = "agent-plugins"

// Shared ecosystem roots belong to every harness, not to one client's
// config directories. The global root lives under the user's home; project
// roots live under .agents in each ancestor directory.
// A file belongs to a shared plugin root when .agents/plugins appears as
// consecutive path segments. Watch filters use this structurally because
// shared roots sit outside the config directories they match against.
export function isSharedPath(file: string): boolean {
  const segments = file.split(path.sep)
  return segments.some((segment, index) => segment === ".agents" && segments[index + 1] === "plugins")
}

// Ordered plugin container roots, global-first. The shared ecosystem root
// sorts before opencode-owned config directories so explicitly installed
// packages win name collisions; project roots sort after global ones so a
// project package shadows a global one. Later roots override earlier ones.
export function containerRoots(
  home: string,
  locationDir: string | undefined,
  configDirs: Array<string>,
  globalConfigDir: string | undefined,
): Array<string> {
  const roots: Array<string> = []
  const push = (root: string) => {
    const key = path.normalize(root)
    if (roots.some((item) => path.normalize(item) === key)) return
    roots.push(root)
  }
  const ancestors = locationDir === undefined ? [] : walkUp(locationDir)
  // A config directory belongs to the project when it sits inside an ancestor
  // of the location. The global config directory always stays global, even
  // when the project happens to live under the home directory.
  const project = (dir: string) => {
    if (globalConfigDir !== undefined && path.normalize(dir) === path.normalize(globalConfigDir)) return false
    return ancestors.some((ancestor) => dir === ancestor || dir.startsWith(ancestor + path.sep))
  }
  // Global scope first, then each project scope from the outermost ancestor
  // inward. Shared roots sort before opencode-owned ones at the same scope, so
  // explicitly installed packages win, and later roots override earlier ones.
  push(path.join(home, ".agents", "plugins"))
  for (const dir of configDirs) if (!project(dir)) push(path.join(dir, PLUGIN_DIR))
  for (const ancestor of ancestors) push(path.join(ancestor, ".agents", "plugins"))
  for (const dir of configDirs) if (project(dir)) push(path.join(dir, PLUGIN_DIR))
  return roots
}

function walkUp(start: string): Array<string> {
  const ancestors: Array<string> = []
  let dir = path.resolve(start)
  while (true) {
    ancestors.unshift(dir)
    const parent = path.dirname(dir)
    if (parent === dir) return ancestors
    dir = parent
  }
}

// Reverse-domain namespace owning opencode-specific behavior. Portable
// clients ignore it; opencode ignores namespaces it does not implement.
export const EXTENSION_NAMESPACE = "ai.opencode"

const HOOK_FILES = ["plugin.ts", "plugin.js"]

export interface ExtensionMarkdown {
  readonly dir: "agents" | "commands" | "modes"
  readonly files: Array<string>
}

export interface ExtensionRef {
  dir: string
  entry: string | undefined
  options: Record<string, unknown>
  dataDir: string
  /** Contained markdown files per component kind, resolved by discovery. */
  markdown: Array<ExtensionMarkdown>
}

const SKILL_FILE = "SKILL.md"
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface DiscoveredSkill {
  plugin: string
  name: string
  dir: string
  /** Resolved `SKILL.md`, already contained against the plugin root. */
  file: string
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

export interface DiscoveredExtension {
  root: string
  name: string
  extension: ExtensionRef
}

// Load and validate one plugin directory: manifest, fixed skills/ location,
// and mcp.json. Failures stay inside the returned issues; the effect never
// fails for invalid plugin content.
export const loadPluginDir = Effect.fn("AgentPlugins.loadPluginDir")(function* (
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

// Collect every plugin load across container roots, then keep one load per
// plugin name. Containers arrive global-first, so a project package shadows
// a global one with the same name instead of loading twice.
function collectLoads(fs: FSUtil.Interface, containers: Array<string>, dataRoot: string) {
  return Effect.gen(function* () {
    const seen: Array<PluginLoad> = []
    const errors: Array<Issue> = []
    const warnings: Array<Issue> = []
    for (const container of containers) {
      for (const root of yield* pluginRoots(fs, container)) {
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

// One pass over every container root. The shared service scans once per
// trigger wave and every consumer reads its caches, so this is the only place
// that loads packages. The targeted helpers below stay for callers that need a
// single component and reuse this pass.
export const load = Effect.fn("AgentPlugins.load")(function* (
  fs: FSUtil.Interface,
  containers: Array<string>,
  dataRoot: string,
  userKeys?: Set<string>,
) {
  const collected = yield* collectLoads(fs, containers, dataRoot)
  const errors: Array<Issue> = [...collected.errors]
  const warnings: Array<Issue> = [...collected.warnings]
  const extensions: Array<DiscoveredExtension> = []
  const skills: Array<DiscoveredSkill> = []
  const servers: Record<string, ServerConfig> = Object.create(null)
  for (const plugin of collected.loads) {
    if (!plugin.manifest) continue
    if (plugin.extension) {
      extensions.push({ root: plugin.root, name: plugin.manifest.name, extension: plugin.extension })
    }
    skills.push(...plugin.skills)
    if (!plugin.mcp?.ok) continue
    const mapped = yield* mapServers(fs, plugin.root, dataRoot, plugin.manifest, plugin.mcp, errors, warnings)
    for (const [key, server] of Object.entries(mapped)) {
      if ((userKeys?.has(key) ?? false) || Object.hasOwn(servers, key)) {
        warnings.push({ path: [], message: `MCP server "${key}" skipped: name already in use` })
        continue
      }
      servers[key] = server
    }
  }
  return { extensions, skills, servers, errors, warnings }
})

// Discover skill directories inside every container root. See
// containerRoots for the root order.
export const loadSkills = (fs: FSUtil.Interface, containers: Array<string>, dataRoot: string) =>
  load(fs, containers, dataRoot).pipe(
    Effect.map(({ skills, errors, warnings }) => ({ skills, errors, warnings })),
  )

// Discover MCP servers and map them onto native server configs. When
// userKeys is given, entries colliding with those keys are skipped so user
// config always wins; the shared service omits it and filters per consumer.
export const loadMcp = (fs: FSUtil.Interface, containers: Array<string>, dataRoot: string, userKeys?: Set<string>) =>
  load(fs, containers, dataRoot, userKeys).pipe(
    Effect.map(({ servers, errors, warnings }) => ({ servers, errors, warnings })),
  )

function pluginRoots(fs: FSUtil.Interface, container: string) {
  return fs.readDirectoryEntries(container).pipe(
    Effect.catch(() => Effect.succeed([])),
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.type === "directory" || entry.type === "symlink")
        .map((entry) => path.join(container, entry.name))
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

// Create a directory only when doing so cannot write outside base. The
// nearest existing ancestor is resolved through realpath first: mkdir
// follows symlinks, so a lexical check alone would let a link planted in
// the package materialize directories somewhere else on disk.
const ensureContainedDir = Effect.fn("AgentPlugins.ensureContainedDir")(function* (
  fs: FSUtil.Interface,
  base: string,
  target: string,
) {
  // The base may not exist yet (the data root is created on first use), so
  // create it first and resolve it through realpath before checking targets.
  yield* fs.ensureDir(base).pipe(Effect.catch(() => Effect.void))
  const realBase = yield* fs.realPath(base).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (realBase === undefined) return undefined
  const existing = yield* fs.realPath(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (existing !== undefined) return containsPath(realBase, existing) ? existing : undefined
  const parent = yield* nearestExisting(fs, target)
  if (parent === undefined) return undefined
  const realParent = yield* fs.realPath(parent).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (realParent === undefined || !containsPath(realBase, realParent)) return undefined
  const created = yield* fs
    .ensureDir(target)
    .pipe(Effect.andThen(fs.realPath(target)), Effect.catch(() => Effect.succeed(undefined)))
  if (created === undefined || !containsPath(realBase, created)) return undefined
  return created
})

// Plugin data lives in a writable directory that persists across updates
// (§9.1: created before launch, writable, stable across updates). Returns
// the resolved directory, or undefined when it cannot be provisioned.
function ensurePluginData(
  fs: FSUtil.Interface,
  dir: string,
  manifest: Manifest.Info,
  warnings: Array<Issue>,
): Effect.Effect<boolean> {
  return ensureContainedDir(fs, path.dirname(dir), dir).pipe(
    Effect.map((data) => data !== undefined),
    Effect.tap((ready) =>
      Effect.sync(() => {
        if (ready) return
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

// Watch every existing container root, forwarding updates into notify.
// Watches start on first sighting and are never torn down individually:
// every watch dies with the caller's scope.
//
// A container that does not exist yet has its nearest existing parent
// watched instead, so a plugins directory created after boot is noticed
// rather than staying invisible until an unrelated reload. The parent
// watch is claimed once and released when its stream ends, exactly like
// a container watch.
//
// The seen-set update is synchronous: callers run from fibers that race
// (initial load vs debounced updates), so the claim must happen before any
// yield or two fibers can subscribe the same container.
export const watchContainers = Effect.fn("AgentPlugins.watchContainers")(function* <A, E, R>(
  watcher: Watcher.Interface,
  scope: Scope.Scope,
  fs: FSUtil.Interface,
  seen: Set<string>,
  parentSeen: Set<string>,
  containers: Array<string>,
  notify: () => Effect.Effect<A, E, R>,
) {
  for (const container of containers) {
    if (seen.has(container)) continue
    seen.add(container)
    if (!(yield* fs.isDir(container))) {
      seen.delete(container)
      // Watch for the container's creation with a non-recursive entries
      // watch on the nearest existing ancestor, naming just the missing
      // component. A recursive watch here would either sit on a huge
      // directory (the walk can reach the filesystem root) or re-enter on
      // unrelated writes; the root itself is never watched.
      const pending = yield* missingComponent(fs, container)
      if (!pending || parentSeen.has(pending.key)) continue
      parentSeen.add(pending.key)
      const parentUpdates = yield* watcher.subscribe({
        path: pending.parent,
        type: "entries",
        names: [pending.name],
      })
      yield* parentUpdates.pipe(
        Stream.runForEach(() =>
          notify().pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logError("agent plugins notify failed", { cause }),
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => parentSeen.delete(pending.key))),
        Effect.catchCause((cause) =>
          Effect.logError("agent plugins parent watch failed", { parent: pending.key, cause }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      continue
    }
    const updates = yield* watcher.subscribe({ path: container, type: "directory" })
    // One failing notify must not end the stream: the container would stay
    // in seen forever and its updates would go unheard. Per-event failures
    // are logged; a dead stream releases the claim so the next refresh
    // re-subscribes.
    yield* updates.pipe(
      Stream.runForEach(() =>
        notify().pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logError("agent plugins notify failed", { cause }),
          ),
        ),
      ),
      Effect.ensuring(Effect.sync(() => seen.delete(container))),
      Effect.catchCause((cause) => Effect.logError("agent plugins watch failed", { container, cause })),
      Effect.forkIn(scope, { startImmediately: true }),
    )
  }
})

function collectSkills(fs: FSUtil.Interface, realRoot: string, manifest: Manifest.Info, warnings: Array<Issue>) {
  return Effect.gen(function* () {
    const skills: Array<DiscoveredSkill> = []
    const skillsDir = yield* realContained(fs, realRoot, path.join(realRoot, "skills"))
    if (!skillsDir.ok && skillsDir.reason === "missing") return skills
    if (!skillsDir.ok) {
      warnings.push({ path: [], message: `skills in plugin "${manifest.name}" escapes the plugin root; skills disabled` })
      return skills
    }
    // Present but not a directory: report the invalid component type (§6.2)
    // and keep loading the rest of the plugin.
    if (!(yield* fs.isDir(skillsDir.path))) {
      warnings.push({ path: [], message: `skills in plugin "${manifest.name}" is not a directory; skills disabled` })
      return skills
    }
    const entries = yield* fs.readDirectoryEntries(skillsDir.path).pipe(Effect.catch(() => Effect.succeed([])))
    for (const entry of entries) {
      if (entry.type !== "directory" && entry.type !== "symlink") continue
      const skill = yield* collectSkill(fs, realRoot, manifest, path.join(skillsDir.path, entry.name), warnings)
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
    if (!(yield* fs.isFile(fileResult.path))) return undefined
    // Read the resolved path the containment check just approved, not the
    // candidate that could be swapped underneath us in between.
    const content = yield* fs.readFileStringSafe(fileResult.path).pipe(Effect.orElseSucceed(() => undefined))
    const md = content
      ? yield* Effect.try({
          try: () => ConfigMarkdown.parseOption(content),
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))
      : undefined
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
    return { plugin: manifest.name, name, dir: real, file: fileResult.path }
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
    const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown))(text)
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
    if (!(yield* ensurePluginData(fs, dataDir, manifest, warnings))) return undefined
    let entry: string | undefined
    for (const file of HOOK_FILES) {
      // A symlinked entry that resolves outside the plugin root is skipped
      // like every other package path (§4.1).
      const candidate = yield* realContained(fs, realRoot, path.join(real, file))
      if (!candidate.ok) continue
      if (yield* fs.isFile(candidate.path)) {
        entry = candidate.path
        break
      }
    }
    // Agent, command, and mode markdown is enumerated here rather than by
    // the consumers' config globs: those follow symlinks on purpose for user
    // configuration, and a package must not get that treatment (§4.1). Every
    // file is contained before a consumer ever sees its path.
    const groups: Array<{ dir: ExtensionMarkdown["dir"]; sources: string[] }> = [
      { dir: "agents", sources: ["{agent,agents}/**/*.md"] },
      { dir: "commands", sources: ["{command,commands}/**/*.md"] },
      { dir: "modes", sources: ["{mode,modes}/*.md"] },
    ]
    const markdown = yield* Effect.forEach(
      groups,
      (group) =>
        Effect.gen(function* () {
          const files = yield* Effect.forEach(
            group.sources,
            (pattern) =>
              fs
                .scan(pattern, { cwd: real, absolute: true, dot: true, symlink: true })
                .pipe(Effect.orElseSucceed(() => [] as string[])),
          ).pipe(Effect.map((items) => items.flat().toSorted()))
          const contained: Array<string> = []
          for (const file of files) {
            const result = yield* realContained(fs, realRoot, file)
            if (!result.ok) {
              warnings.push({
                path: [group.dir, path.relative(real, file)],
                message: `Extension file skipped: resolves outside the plugin root`,
              })
              continue
            }
            if (yield* fs.isFile(result.path)) contained.push(result.path)
          }
          return { dir: group.dir, files: contained } satisfies ExtensionMarkdown
        }),
    )
    return { dir: real, entry, options, dataDir, markdown }
  })
}

// Discover enabled opencode extensions. The caller decides which extension
// parts to consume; a missing JS entry only means no lifecycle hooks.
export const loadExtensions = (fs: FSUtil.Interface, containers: Array<string>, dataRoot: string) =>
  load(fs, containers, dataRoot).pipe(
    Effect.map(({ extensions, errors, warnings }) => ({ extensions, errors, warnings })),
  )

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
    const servers: Record<string, ServerConfig> = Object.create(null)
    const dataDir = path.join(dataRoot, manifest.name)
    // §9.1 requires a writable PLUGIN_DATA before a subprocess starts, so a
    // data directory we cannot provision disables this package's servers
    // rather than handing them a path that will not exist at launch.
    if (!(yield* ensurePluginData(fs, dataDir, manifest, warnings))) return servers
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
    // The base is whichever directory this cwd form is allowed to live in;
    // the check is against that base only, never "root OR data", so a
    // ${PLUGIN_DATA} cwd cannot land in the package and vice versa.
    const base = resolveCwdBase(server.cwd, vars)
    const cwd = yield* ensureContainedDir(fs, base, lexical)
    if (cwd === undefined || !(yield* fs.isDir(cwd))) {
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
    } satisfies ServerConfig
  })
}

// The trusted directory a cwd form must stay inside: the plugin data
// directory for ${PLUGIN_DATA} forms, the plugin root for everything else.
function resolveCwdBase(cwd: string | undefined, vars: { root: string; data: string }): string {
  return cwd !== undefined && classifyCwd(cwd) === "plugin-data" ? vars.data : vars.root
}

// Walk up from the target to its nearest existing ancestor so containment
// can be verified through realpath on real directory content.
function nearestExisting(fs: FSUtil.Interface, target: string): Effect.Effect<string | undefined> {
  const walk = (candidate: string): Effect.Effect<string | undefined> =>
    Effect.gen(function* () {
      if (yield* fs.existsSafe(candidate)) return candidate
      const parent = path.dirname(candidate)
      return parent === candidate ? undefined : yield* walk(parent)
    })
  return walk(target)
}

// The existing directory to watch, plus the single missing component name to
// watch for inside it. Returns undefined at the filesystem root: watching
// "/" for every plugin creation would be a permanent, unbounded watch.
function missingComponent(
  fs: FSUtil.Interface,
  target: string,
): Effect.Effect<{ readonly key: string; readonly parent: string; readonly name: string } | undefined> {
  return Effect.gen(function* () {
    const parent = yield* nearestExisting(fs, path.dirname(target))
    if (parent === undefined || path.resolve(parent) === path.parse(parent).root) return undefined
    const name = path.basename(target)
    return { key: `${parent}/${name}`, parent, name }
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
