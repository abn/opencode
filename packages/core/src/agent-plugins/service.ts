export * as AgentPluginsService from "./service.js"

import path from "path"
import { Context, Effect, Layer, PubSub, Semaphore, Stream } from "effect"
import type { ServerConfig } from "@opencode/schema/mcp"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { AgentPlugins } from "./discovery.js"
import type { DiscoveredExtension, DiscoveredSkill } from "./discovery.js"
import type { Issue } from "./manifest.js"
import { Config } from "../config.js"
import { Watcher } from "../filesystem/watcher.js"
import { Location } from "../location.js"

export interface Extensions {
  readonly extensions: Array<DiscoveredExtension>
  readonly issues: Array<Issue>
}

export interface Skills {
  readonly skills: Array<DiscoveredSkill>
  readonly issues: Array<Issue>
}

export interface McpServers {
  readonly servers: Record<string, ServerConfig>
  readonly issues: Array<Issue>
}

export interface Interface {
  /** Rescans every container root and repopulates the cached contributions. */
  readonly refresh: () => Effect.Effect<void>
  readonly extensions: () => Effect.Effect<Extensions>
  readonly skills: () => Effect.Effect<Skills>
  /**
   * Cached server entries filtered against the caller's user-config keys;
   * collisions are reported as issues instead of skipped silently.
   */
  readonly mcp: (userKeys: ReadonlySet<string>) => Effect.Effect<McpServers>
  /** Fires once per container update observed by the service's watches. */
  readonly changes: () => Stream.Stream<void>
}

interface Snapshot {
  readonly extensions: Array<DiscoveredExtension>
  readonly skills: Array<DiscoveredSkill>
  readonly servers: Record<string, ServerConfig>
}

const empty: Snapshot = { extensions: [], skills: [], servers: {} }

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentPluginsService") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const watcher = yield* Watcher.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const lock = Semaphore.makeUnsafe(1)
    const lifetime = yield* Effect.scope
    const feed = yield* PubSub.unbounded<void>()
    const watched = new Set<string>()
    const parents = new Set<string>()
    // Readers only ever see a complete scan: refresh swaps one snapshot.
    const snapshot = { value: empty }
    // Single-flight refresh: concurrent consumers share one scan instead of
    // each rescanning every container. A caller that arrives while a scan runs
    // queues exactly one follow-up scan, so no change is lost and a burst of
    // trigger fibers costs one scan (plus one for a change mid-scan).
    const state = { requested: 0, completed: 0 }
    const dataRoot = path.join(global.data, "agent-plugins")
    const notify = () => PubSub.publish(feed, undefined).pipe(Effect.asVoid)

    const scan = Effect.fn("AgentPluginsService.scan")(function* () {
      const entries = yield* config.entries()
      const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
      const containers = AgentPlugins.containerRoots(global.home, location.directory, directories, global.config)
      const loaded = yield* AgentPlugins.load(fs, containers, dataRoot)
      yield* AgentPlugins.logIssues([...loaded.errors, ...loaded.warnings])
      snapshot.value = {
        extensions: loaded.extensions,
        skills: loaded.skills,
        servers: loaded.servers,
      }
      yield* AgentPlugins.watchContainers(watcher, lifetime, fs, watched, parents, containers, notify)
    })

    // One scan per trigger wave: every consumer reloads from these caches
    // instead of rescanning the same containers itself.
    const refresh = Effect.fn("AgentPluginsService.refresh")(function* () {
      const ticket = ++state.requested
      if (state.completed >= ticket) return
      yield* lock.withPermit(
        Effect.gen(function* () {
          if (state.completed >= ticket) return
          const target = state.requested
          yield* scan()
          state.completed = target
        }),
      )
    })

    return Service.of({
      refresh,
      extensions: () => Effect.sync(() => ({ extensions: snapshot.value.extensions, issues: [] })),
      skills: () => Effect.sync(() => ({ skills: snapshot.value.skills, issues: [] })),
      mcp: (userKeys) =>
        Effect.sync(() => {
          const servers: Record<string, ServerConfig> = Object.create(null)
          const issues: Array<Issue> = []
          for (const [key, server] of Object.entries(snapshot.value.servers)) {
            if (userKeys.has(key)) {
              issues.push({ path: [], message: `MCP server "${key}" skipped: name already in use` })
              continue
            }
            if (Object.hasOwn(servers, key)) continue
            servers[key] = server
          }
          return { servers, issues } satisfies McpServers
        }),
      changes: () => Stream.fromPubSub(feed),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Watcher.node, Location.node, Global.node],
})
