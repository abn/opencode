import { Effect, Layer, Stream } from "effect"
import { AgentPluginsService } from "@opencode/core/agent-plugins/service"

// Empty discovery for harnesses that exercise config plugins without plugin
// packages: the service is still a real dependency, so tests that do not care
// about discovery get a deterministic no-op instead of scanning real homes.
export const emptyAgentPlugins = Layer.succeed(
  AgentPluginsService.Service,
  AgentPluginsService.Service.of({
    refresh: () => Effect.void,
    extensions: () => Effect.succeed({ extensions: [], issues: [] }),
    skills: () => Effect.succeed({ skills: [], issues: [] }),
    mcp: () => Effect.succeed({ servers: {}, issues: [] }),
    changes: () => Stream.never,
  }),
)
