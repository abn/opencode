export * as ConfigAgentPluginsPlugin from "./agent-plugins.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Cause, Exit, Effect, PubSub, Scope, Semaphore, Stream } from "effect"
import path from "path"
import { AgentPlugins } from "../../agent-plugins/discovery.js"
import { ShellHooks } from "../../agent-plugins/shell-hooks.js"
import { AgentPluginsService } from "../../agent-plugins/service.js"
import { Config } from "../../config.js"

export const Plugin = define({
  id: "opencode.config.agent-plugins",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const shared = yield* AgentPluginsService.Service
    const lock = Semaphore.makeUnsafe(1)
    // Hook registrations live in a replaced child scope so every rescan
    // disposes the previous observers instead of stacking duplicates.
    let scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

    const refresh = Effect.fn("ConfigAgentPluginsPlugin.refresh")(
      function* () {
        yield* shared.refresh()
        const { extensions } = yield* shared.extensions()
        const next = yield* Scope.make()
        const registered = yield* Effect.forEach(
          extensions,
          (ext) =>
            Effect.gen(function* () {
              const vars = { root: ext.root, data: ext.extension.dataDir }
              const shell = yield* ShellHooks.loadFile(fs, ext.root, ext.extension.dir, vars, ext.name)
              if (!shell) return
              yield* AgentPlugins.logIssues(shell.warnings)
              if (!shell.hooks) return
              yield* ShellHooks.register(ctx.tool.hook, shell.hooks, vars, ext.name).pipe(
                Effect.provideService(Scope.Scope, next),
              )
            }).pipe(Effect.catchDefect(() => Effect.void)),
        ).pipe(Effect.exit)
        // Interrupts are not failures: closing a scope on shutdown must not
        // be reported as a broken refresh, and the partial scope still dies.
        if (!Exit.isSuccess(registered)) {
          yield* Scope.close(next, registered)
          if (!Cause.hasInterrupts(registered.cause)) {
            yield* Effect.logError("agent plugins shell hooks failed to refresh", { cause: registered.cause })
          }
          return
        }
        yield* Scope.close(scope, Exit.void)
        scope = next
      },
      (effect) => lock.withPermit(effect),
    )

    const changes = yield* PubSub.sliding<void>(1)
    const notify = () => PubSub.publish(changes, undefined)
    yield* config.changes().pipe(
      Stream.filterEffect((update) =>
        Effect.map(config.entries(), (entries) => isAgentPluginPath(entries, update.path)),
      ),
      Stream.runForEach(() => notify()),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* ctx.event
      .subscribe({ types: ["config.updated"] })
      .pipe(Stream.runForEach(() => notify()), Effect.forkScoped({ startImmediately: true }))
    yield* shared.changes().pipe(
      Stream.runForEach(() => notify()),
      Effect.forkScoped({ startImmediately: true }),
    )
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() =>
        refresh().pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logError("agent plugins hooks refresh failed", { cause }),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh()
  }),
})

// Matches anything at or under <root>/agent-plugins. No file-suffix check:
// directory-level events such as renames carry no per-file paths.
function isAgentPluginPath(entries: Entry[], file: string) {
  if (AgentPlugins.isSharedPath(file)) return true
  return entries.some(
    (entry) =>
      entry.type === "directory" && FSUtil.contains(path.join(entry.path, AgentPlugins.PLUGIN_DIR), file),
  )
}
