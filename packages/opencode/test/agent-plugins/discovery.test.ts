import { describe, expect } from "bun:test"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginDiscovery } from "../../src/agent-plugins/discovery"
import { Manifest } from "../../src/agent-plugins/manifest"
import { ConfigAgent } from "../../src/config/agent"
import { ConfigCommand } from "../../src/config/command"

const { effect: it } = testEffect(LayerNode.compile(FSUtil.node))

async function fixture(files: Record<string, string>) {
  const root = path.join(tmpdir(), `agent-plugin-${crypto.randomUUID()}`)
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(path.join(root, name), content)
  }
  return root
}

function cleanup(root: string) {
  return Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore)
}

const manifest = {
  $schema: Manifest.SCHEMA,
  name: "demo",
  version: "1.0.0",
}

const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

const skill = `---
name: greet
description: Greet the user.
---

Greet the user.
`

describe("agent-plugins.discovery", () => {
  it("loads manifest and skills with per-skill isolation", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const root = yield* Effect.promise(() =>
        fixture({
          "plugin.json": JSON.stringify(manifest),
          "skills/greet/SKILL.md": skill,
          "skills/BAD/SKILL.md": skill.replace("name: greet", "name: BAD"),
          "skills/mismatch/SKILL.md": skill.replace("name: greet", "name: other"),
        }),
      )
      try {
        const load = yield* PluginDiscovery.loadPluginDir(fs, root, path.join(root, "data-root"))
        expect(load.manifest?.name).toBe("demo")
        expect(load.skills.map((skill) => skill.name)).toEqual(["greet"])
        expect(load.warnings.length).toBe(2)
        expect(load.errors).toEqual([])
      } finally {
        yield* cleanup(root)
      }
    }))

  it("discovers skills from convention directories", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const configDir = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/skills/greet/SKILL.md": skill,
        }),
      )
      try {
        const found = yield* PluginDiscovery.loadSkills(fs, [configDir], path.join(configDir, "data"))
        expect(found.skills.map((skill) => skill.name)).toEqual(["greet"])
        expect(found.errors).toEqual([])
      } finally {
        yield* cleanup(configDir)
      }
    }))

  it("maps mcp servers onto native entries with user keys winning", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const configDir = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/mcp.json": JSON.stringify({
            $schema: mcpSchema,
            mcpServers: {
              local: { type: "stdio", command: "./bin/srv", env: { DATA: "${PLUGIN_DATA}/x" } },
              remote: { type: "streamable-http", url: "http://localhost:8931/mcp" },
              broken: { type: "stdio", command: "../escape" },
              legacy: { type: "sse", url: "https://example.com/sse" },
              ghost: { type: "stdio", command: "./bin/ghost" },
            },
          }),
          "agent-plugins/demo/bin/srv": "#!/bin/sh\nexit 0\n",
        }),
      )
      try {
        const dataRoot = path.join(configDir, "data")
        const found = yield* PluginDiscovery.loadMcp(fs, [configDir], dataRoot, new Set(["demo-remote"]))
        const local = found.servers["demo-local"]
        expect(local?.type).toBe("local")
        if (local?.type === "local") {
          expect(local.command[0]).toBe(path.join(configDir, "agent-plugins/demo/bin/srv"))
          expect(local.cwd).toBe(path.join(configDir, "agent-plugins/demo"))
          expect(local.environment?.["PLUGIN_DATA"]).toBe(path.join(dataRoot, "demo"))
          expect(local.environment?.["DATA"]).toBe(path.join(dataRoot, "demo/x"))
        }
        expect(found.servers["demo-remote"]).toBeUndefined()
        expect(found.servers["demo-broken"]).toBeUndefined()
        expect(found.servers["demo-legacy"]).toBeUndefined()
        expect(found.servers["demo-ghost"]).toBeUndefined()
        expect(found.errors.length).toBeGreaterThan(0)
        expect(found.warnings.length).toBeGreaterThan(0)
      } finally {
        yield* cleanup(configDir)
      }
    }))

  it("rejects invalid manifests without throwing", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const root = yield* Effect.promise(() =>
        fixture({ "plugin.json": JSON.stringify({ $schema: Manifest.SCHEMA, name: "Bad_Name" }) }),
      )
      try {
        const load = yield* PluginDiscovery.loadPluginDir(fs, root, path.join(root, "data-root"))
        expect(load.manifest).toBeUndefined()
        expect(load.skills).toEqual([])
        expect(load.errors.length).toBeGreaterThan(0)
      } finally {
        yield* cleanup(root)
      }
    }))

  it("discovers enabled extensions with entries", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const configDir = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify({
            ...manifest,
            extensions: { "ai.opencode": { setting: true } },
          }),
          "agent-plugins/demo/ai.opencode/plugin.ts": "export default { server: async () => ({}) }\n",
          "agent-plugins/off/plugin.json": JSON.stringify({
            ...manifest,
            name: "off",
            extensions: { "ai.opencode": { enabled: false } },
          }),
          "agent-plugins/off/ai.opencode/plugin.ts": "export default { server: async () => ({}) }\n",
          "agent-plugins/plain/plugin.json": JSON.stringify({ ...manifest, name: "plain" }),
        }),
      )
      try {
        const found = yield* PluginDiscovery.loadExtensions(fs, [configDir], path.join(configDir, "data"))
        expect(found.extensions.map((ext) => ext.name)).toEqual(["demo"])
        const ext = found.extensions[0]
        expect(ext.extension.entry).toBe(path.join(configDir, "agent-plugins/demo/ai.opencode/plugin.ts"))
        expect(ext.extension.options).toMatchObject({ setting: true })
        expect(ext.extension.dataDir).toBe(path.join(configDir, "data/demo"))
        expect(found.errors).toEqual([])
      } finally {
        yield* cleanup(configDir)
      }
    }))

  it("exposes agents and commands through existing loaders", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const configDir = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/ai.opencode/agents/reviewer.md": `---
description: Reviews code.
mode: subagent
---

Review code.
`,
          "agent-plugins/demo/ai.opencode/commands/deploy.md": `---
description: Deploys the app.
---

Deploy $ARGUMENTS.
`,
          "agent-plugins/demo/ai.opencode/modes/quick.md": `---
description: Quick answers.
---

Be brief.
`,
        }),
      )
      try {
        const found = yield* PluginDiscovery.loadExtensions(fs, [configDir], path.join(configDir, "data"))
        expect(found.extensions.map((ext) => ext.name)).toEqual(["demo"])
        const agents = yield* Effect.promise(() => ConfigAgent.load(found.extensions[0].extension.dir))
        expect(Object.keys(agents)).toEqual(["reviewer"])
        const modes = yield* Effect.promise(() => ConfigAgent.loadMode(found.extensions[0].extension.dir))
        expect(Object.keys(modes)).toEqual(["quick"])
        const commands = yield* Effect.promise(() => ConfigCommand.load(found.extensions[0].extension.dir))
        expect(Object.keys(commands)).toEqual(["deploy"])
      } finally {
        yield* cleanup(configDir)
      }
    }))

  it("shadows duplicate plugin names across directories", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const first = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/skills/old/SKILL.md": `---
name: old
description: Old.
---

Old.
`,
        }),
      )
      const second = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/skills/new/SKILL.md": `---
name: new
description: New.
---

New.
`,
        }),
      )
      try {
        const found = yield* PluginDiscovery.loadSkills(fs, [first, second], path.join(second, "data"))
        expect(found.skills.map((skill) => skill.name)).toEqual(["new"])
        expect(found.warnings.some((issue) => issue.message.includes("shadowed"))).toBe(true)
      } finally {
        yield* cleanup(first)
        yield* cleanup(second)
      }
    }))
})
