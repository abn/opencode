export * as ConfigMcpPlugin from "./mcp.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import type { ServerConfig } from "@opencode/schema/mcp"
import { Effect, Semaphore, Stream } from "effect"
import { AgentPlugins } from "../../agent-plugins/discovery.js"
import { AgentPluginsService } from "../../agent-plugins/service.js"
import { Config } from "../../config.js"
import { Mcp } from "../../mcp/index.js"

export const Plugin = define({
  id: "opencode.config.mcp",
  effect: Effect.fn(function* (ctx) {
    yield* register(ctx.event.subscribe({ types: ["config.updated"] }))
  }),
})

export const register = Effect.fn("ConfigMCPPlugin.register")(function* (
  events: Stream.Stream<{ readonly type: string }, unknown>,
) {
  const config = yield* Config.Service
  const mcp = yield* Mcp.Service
  const shared = yield* AgentPluginsService.Service
  const lock = Semaphore.makeUnsafe(1)
  const loaded = { entries: [] as Entry[], pluginServers: {} as Record<string, ServerConfig> }

  // Agent Plugins servers are rediscovered on every refresh so the transform
  // below always reads current data when state replays it.
  const refreshDiscovered = Effect.fn("ConfigMCPPlugin.refreshDiscovered")(function* () {
    const documents = loaded.entries.filter((entry): entry is Document => entry.type === "document")
    const userKeys = new Set(documents.flatMap((document) => Object.keys(document.info.mcp?.servers ?? {})))
    yield* shared.refresh()
    const { servers, issues } = yield* shared.mcp(userKeys)
    yield* AgentPlugins.logIssues(issues)
    loaded.pluginServers = servers
  })

  // Two trigger fibers (config events, container updates) must not interleave
  // their read-filter-commit sequences: a later refresh that commits first
  // would otherwise be overwritten by an earlier generation. The whole
  // sequence, not just the service scan, runs under this lock.
  const refresh = Effect.fn("ConfigMCPPlugin.refresh")(
    function* () {
      loaded.entries = yield* config.entries()
      yield* refreshDiscovered()
      yield* mcp.reload()
    },
    (effect) => lock.withPermit(effect),
  )

  yield* events.pipe(
    Stream.filter((event) => event.type === "config.updated"),
    Stream.runForEach(() =>
      refresh().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload MCP config", { cause }))),
    ),
    Effect.ignore,
    Effect.forkScoped({ startImmediately: true }),
  )
  // Container updates from the shared service reload MCP data through the
  // same debounced path the other consumers use.
  yield* shared.changes().pipe(
    Stream.debounce("100 millis"),
    Stream.runForEach(() =>
      refresh().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload MCP config", { cause }))),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )

  // Subscribe before the initial load so updates racing it trigger a rebuild.
  yield* refresh()
  yield* mcp.transform((editor) => {
    const documents = loaded.entries.filter((entry): entry is Document => entry.type === "document")
    // Global timeout defaults merge in config order; each server can override them.
    const timeout = Object.assign(
      {},
      ...documents.flatMap((entry) => (entry.info.mcp?.timeout ? [entry.info.mcp.timeout] : [])),
    )
    const servers = new Map<string, ServerConfig>()
    for (const document of documents) {
      for (const [name, server] of Object.entries(document.info.mcp?.servers ?? {})) {
        servers.set(name, server)
      }
    }
    for (const [name, server] of servers) {
      if (editor.get(name)) continue
      editor.set(name, { ...server, timeout: { ...timeout, ...server.timeout } })
    }
    // Agent Plugins servers fill only names user config did not claim. The
    // editor guard and the userKeys filter in the shared service both
    // resolve toward user config, so this stays correct no matter which
    // transform runs first.
    for (const [name, server] of Object.entries(loaded.pluginServers)) {
      if (editor.get(name)) continue
      editor.set(name, server)
    }
  })
})
