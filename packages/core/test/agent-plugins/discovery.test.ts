import { describe, expect, test } from "bun:test"
import { mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { AgentPlugins } from "@opencode/core/agent-plugins/discovery"
import { Manifest } from "@opencode/core/agent-plugins/manifest"

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
        const load = yield* AgentPlugins.loadPluginDir(fs, root, path.join(root, "data-root"))
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
        const found = yield* AgentPlugins.loadSkills(
          fs,
          [path.join(configDir, "agent-plugins")],
          path.join(configDir, "data"),
        )
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
        const found = yield* AgentPlugins.loadMcp(
          fs,
          [path.join(configDir, "agent-plugins")],
          dataRoot,
          new Set(["demo-remote"]),
        )
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
        const load = yield* AgentPlugins.loadPluginDir(fs, root, path.join(root, "data-root"))
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
        const found = yield* AgentPlugins.loadExtensions(
          fs,
          [path.join(configDir, "agent-plugins")],
          path.join(configDir, "data"),
        )
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

  it("exposes agent, command, and mode markdown under the extension directory", () =>
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
        const found = yield* AgentPlugins.loadExtensions(
          fs,
          [path.join(configDir, "agent-plugins")],
          path.join(configDir, "data"),
        )
        expect(found.extensions.map((ext) => ext.name)).toEqual(["demo"])
        // The config agent/command integrations scan these fixed locations
        // under the extension directory with their own markdown loaders.
        const dir = found.extensions[0].extension.dir
        expect(yield* fs.isFile(path.join(dir, "agents/reviewer.md"))).toBe(true)
        expect(yield* fs.isFile(path.join(dir, "commands/deploy.md"))).toBe(true)
        expect(yield* fs.isFile(path.join(dir, "modes/quick.md"))).toBe(true)
      } finally {
        yield* cleanup(configDir)
      }
    }))

  it("rejects fixed files that resolve outside the plugin root", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const root = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/escapey/plugin.json": JSON.stringify({ ...manifest, name: "escapey" }),
          "agent-plugins/escapey/skills/leak/SKILL.md": skill.replace("name: greet", "name: leak"),
        }),
      )
      const outside = yield* Effect.promise(() =>
        fixture({
          "SKILL.md": skill.replace("name: greet", "name: leak"),
          "mcp.json": JSON.stringify({
            $schema: mcpSchema,
            mcpServers: { escaped: { type: "stdio", command: "sh" } },
          }),
        }),
      )
      try {
        const plugin = path.join(root, "agent-plugins", "escapey")
        yield* Effect.promise(() => rm(path.join(plugin, "skills", "leak", "SKILL.md")))
        yield* Effect.promise(() =>
          symlink(path.join(outside, "SKILL.md"), path.join(plugin, "skills", "leak", "SKILL.md")),
        )
        yield* Effect.promise(() => symlink(path.join(outside, "mcp.json"), path.join(plugin, "mcp.json")))

        const skills = yield* AgentPlugins.loadSkills(fs, [path.join(root, "agent-plugins")], path.join(root, "data"))
        expect(skills.skills).toEqual([])
        expect(skills.warnings.some((issue) => issue.message.includes("escapes plugin root"))).toBe(true)

        const mcp = yield* AgentPlugins.loadMcp(
          fs,
          [path.join(root, "agent-plugins")],
          path.join(root, "data"),
          new Set(),
        )
        expect(mcp.servers).toEqual({})
        expect(mcp.errors.some((issue) => issue.message.includes("outside the plugin root"))).toBe(true)
      } finally {
        yield* cleanup(root)
        yield* cleanup(outside)
      }
    }))

  it("rejects a plugin.json that resolves outside the plugin root", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const root = yield* Effect.promise(() => fixture({ "plugin.json": "" }))
      const outside = yield* Effect.promise(() => fixture({ "plugin.json": JSON.stringify(manifest) }))
      try {
        yield* Effect.promise(() => rm(path.join(root, "plugin.json")))
        yield* Effect.promise(() => symlink(path.join(outside, "plugin.json"), path.join(root, "plugin.json")))
        const load = yield* AgentPlugins.loadPluginDir(fs, root, path.join(root, "data"))
        expect(load.manifest).toBeUndefined()
        expect(load.errors.some((issue) => issue.message.includes("outside the plugin root"))).toBe(true)
      } finally {
        yield* cleanup(root)
        yield* cleanup(outside)
      }
    }))

  it("reports fixed locations present as the wrong kind", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const root = yield* Effect.promise(() =>
        fixture({
          "plugin.json": JSON.stringify(manifest),
          // skills as a file, mcp.json as a directory: both invalid components.
          skills: "not a directory",
        }),
      )
      try {
        yield* Effect.promise(() => mkdir(path.join(root, "mcp.json")))
        const load = yield* AgentPlugins.loadPluginDir(fs, root, path.join(root, "data"))
        expect(load.skills).toEqual([])
        expect(
          load.warnings.some((issue) => issue.message.includes("skills") && issue.message.includes("not a directory")),
        ).toBe(true)
        expect(load.mcp).toBeUndefined()
        expect(load.errors.some((issue) => issue.message.includes("not a regular file"))).toBe(true)
      } finally {
        yield* cleanup(root)
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
        const found = yield* AgentPlugins.loadSkills(
          fs,
          [path.join(first, "agent-plugins"), path.join(second, "agent-plugins")],
          path.join(second, "data"),
        )
        expect(found.skills.map((skill) => skill.name)).toEqual(["new"])
        expect(found.warnings.some((issue) => issue.message.includes("shadowed"))).toBe(true)
      } finally {
        yield* cleanup(first)
        yield* cleanup(second)
      }
    }))

describe("agent-plugins.roots", () => {
  test("orders shared before owned at the same scope, global-first, with dedupe", () => {
    expect(
      AgentPlugins.containerRoots(
        "/home/u",
        "/home/u/proj/sub",
        ["/home/u/.config/opencode", "/home/u/proj/.opencode"],
        "/home/u/.config/opencode",
      ),
    ).toEqual([
      path.join("/home/u", ".agents", "plugins"),
      path.join("/home/u/.config/opencode", "agent-plugins"),
      path.join("/", ".agents", "plugins"),
      path.join("/home", ".agents", "plugins"),
      path.join("/home/u/proj", ".agents", "plugins"),
      path.join("/home/u/proj/sub", ".agents", "plugins"),
      path.join("/home/u/proj/.opencode", "agent-plugins"),
    ])
  })

  test("matches shared roots structurally", () => {
    expect(AgentPlugins.isSharedPath(path.join("/home/u", ".agents", "plugins", "demo", "plugin.json"))).toBe(true)
    expect(AgentPlugins.isSharedPath(path.join("/x", "agent-plugins", "demo"))).toBe(false)
    expect(AgentPlugins.isSharedPath(path.join("/home/u", ".agents", "skills", "demo"))).toBe(false)
    expect(AgentPlugins.isSharedPath(path.join("/home/u", "x.agents", "plugins"))).toBe(false)
  })

  it("prefers project roots over the shared global root on name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const home = yield* Effect.promise(() =>
        fixture({
          ".agents/plugins/demo/plugin.json": JSON.stringify(manifest),
          ".agents/plugins/demo/skills/old/SKILL.md": `---
name: old
description: Old.
---

Old.
`,
        }),
      )
      const project = yield* Effect.promise(() =>
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
        const containers = AgentPlugins.containerRoots(home, project, [project], undefined)
        expect(containers[0]).toBe(path.join(home, ".agents", "plugins"))
        expect(containers.at(-1)).toBe(path.join(project, "agent-plugins"))
        const found = yield* AgentPlugins.loadSkills(fs, containers, path.join(project, "data"))
        expect(found.skills.map((skill) => skill.name)).toEqual(["new"])
        expect(found.warnings.some((issue) => issue.message.includes("shadowed"))).toBe(true)
      } finally {
        yield* cleanup(home)
        yield* cleanup(project)
      }
    }))
})

  it("rejects a cwd that escapes through an existing symlink without creating anything outside", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      // The link target must already exist: nearestExisting has to resolve it,
      // which is the case the earlier lexical check missed.
      const outside = yield* Effect.promise(() => fixture({ "keep": "x" }))
      const configDir = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/bin/srv": "#!/bin/sh\nexit 0\n",
          "agent-plugins/demo/mcp.json": JSON.stringify({
            $schema: mcpSchema,
            mcpServers: { escape: { type: "stdio", command: "./bin/srv", cwd: "./link/created" } },
          }),
        }),
      )
      try {
        yield* Effect.promise(() => symlink(outside, path.join(configDir, "agent-plugins", "demo", "link")))
        const found = yield* AgentPlugins.loadMcp(
          fs,
          [path.join(configDir, "agent-plugins")],
          path.join(configDir, "data"),
          new Set(),
        )
        expect(found.servers["demo-escape"]).toBeUndefined()
        expect(found.errors.some((issue) => issue.message.includes("escapes its base"))).toBe(true)
        // Containment is verified before mkdir, so nothing materializes outside.
        expect(yield* fs.existsSafe(path.join(outside, "created"))).toBe(false)
      } finally {
        yield* cleanup(configDir)
        yield* cleanup(outside)
      }
    }))

  it("checks each cwd form against its own base, not root-or-data", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const configDir = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/bin/srv": "#!/bin/sh\nexit 0\n",
          "agent-plugins/demo/mcp.json": JSON.stringify({
            $schema: mcpSchema,
            mcpServers: {
              // ${PLUGIN_DATA} must stay in the data dir, not reach the package.
              dataEscape: { type: "stdio", command: "./bin/srv", cwd: "${PLUGIN_DATA}/../../agent-plugins/demo" },
              // A package-rooted cwd must stay in the package, not the data dir.
              rootEscape: { type: "stdio", command: "./bin/srv", cwd: "${PLUGIN_ROOT}/../../../data/demo" },
              // ${PLUGIN_ROOT}/data is a legal package-rooted cwd.
              allowed: { type: "stdio", command: "./bin/srv", cwd: "${PLUGIN_ROOT}/data" },
            },
          }),
        }),
      )
      try {
        const found = yield* AgentPlugins.loadMcp(
          fs,
          [path.join(configDir, "agent-plugins")],
          path.join(configDir, "data"),
          new Set(),
        )
        expect(found.servers["demo-dataEscape"]).toBeUndefined()
        expect(found.servers["demo-rootEscape"]).toBeUndefined()
        expect(found.servers["demo-allowed"]?.type).toBe("local")
        expect(found.errors.some((issue) => issue.path[0] === "demo-dataEscape")).toBe(true)
        expect(found.errors.some((issue) => issue.path[0] === "demo-rootEscape")).toBe(true)
      } finally {
        yield* cleanup(configDir)
      }
    }))

  it("skips a package whose data directory cannot be provisioned", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const configDir = yield* Effect.promise(() =>
        fixture({
          // data is a regular file, so the per-plugin data dir cannot exist
          "data": "not a directory",
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/bin/srv": "#!/bin/sh\nexit 0\n",
          "agent-plugins/demo/mcp.json": JSON.stringify({
            $schema: mcpSchema,
            mcpServers: { local: { type: "stdio", command: "./bin/srv" } },
          }),
        }),
      )
      try {
        const found = yield* AgentPlugins.loadMcp(
          fs,
          [path.join(configDir, "agent-plugins")],
          path.join(configDir, "data"),
          new Set(),
        )
        expect(found.servers).toEqual({})
        expect(found.warnings.some((issue) => issue.message.includes("data directory unavailable"))).toBe(true)
      } finally {
        yield* cleanup(configDir)
      }
    }))

  it("skips extension markdown that symlinks outside the plugin root", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const outside = yield* Effect.promise(() =>
        fixture({
          "secret.md": `---
description: Leaked.
---

Leaked.
`,
        }),
      )
      const configDir = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/ai.opencode/agents/keep.md": `---
description: Kept.
---

Kept.
`,
        }),
      )
      try {
        yield* Effect.promise(() =>
          symlink(
            path.join(outside, "secret.md"),
            path.join(configDir, "agent-plugins", "demo", "ai.opencode", "agents", "leak.md"),
          ),
        )
        const found = yield* AgentPlugins.loadExtensions(
          fs,
          [path.join(configDir, "agent-plugins")],
          path.join(configDir, "data"),
        )
        const files = found.extensions[0]?.extension.markdown.find((group) => group.dir === "agents")?.files ?? []
        expect(files.some((file) => file.endsWith("leak.md"))).toBe(false)
        expect(files.some((file) => file.endsWith("keep.md"))).toBe(true)
        expect(found.warnings.some((issue) => issue.message.includes("outside the plugin root"))).toBe(true)
      } finally {
        yield* cleanup(configDir)
        yield* cleanup(outside)
      }
    }))

  it("accepts a missing cwd under plugin data and creates it there", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const configDir = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/bin/srv": "#!/bin/sh\nexit 0\n",
          "agent-plugins/demo/mcp.json": JSON.stringify({
            $schema: mcpSchema,
            mcpServers: { data: { type: "stdio", command: "./bin/srv", cwd: "${PLUGIN_DATA}/state" } },
          }),
        }),
      )
      try {
        const dataRoot = path.join(configDir, "data")
        const found = yield* AgentPlugins.loadMcp(fs, [path.join(configDir, "agent-plugins")], dataRoot, new Set())
        const local = found.servers["demo-data"]
        expect(local?.type).toBe("local")
        if (local?.type === "local") expect(local.cwd).toBe(path.join(dataRoot, "demo", "state"))
        expect(yield* fs.isDir(path.join(dataRoot, "demo", "state"))).toBe(true)
      } finally {
        yield* cleanup(configDir)
      }
    }))

  it("rejects an extension entry symlinked outside the plugin root", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const outside = yield* Effect.promise(() => fixture({ "plugin.ts": "export default {}\n" }))
      const configDir = yield* Effect.promise(() =>
        fixture({
          "agent-plugins/demo/plugin.json": JSON.stringify(manifest),
          "agent-plugins/demo/ai.opencode/keep": "x",
        }),
      )
      try {
        yield* Effect.promise(() =>
          symlink(path.join(outside, "plugin.ts"), path.join(configDir, "agent-plugins", "demo", "ai.opencode", "plugin.ts")),
        )
        const found = yield* AgentPlugins.loadExtensions(fs, [path.join(configDir, "agent-plugins")], path.join(configDir, "data"))
        expect(found.extensions[0]?.extension.entry).toBeUndefined()
      } finally {
        yield* cleanup(configDir)
        yield* cleanup(outside)
      }
    }))
})
