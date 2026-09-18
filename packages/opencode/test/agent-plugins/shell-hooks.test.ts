import { describe, expect } from "bun:test"
import { chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { ShellHooks } from "../../src/agent-plugins/shell-hooks"

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

const vars = { root: "/plugin", data: "/data" }

describe("agent-plugins.shell-hooks", () => {
  it("parses flat and matcher formats with warnings", () =>
    Effect.gen(function* () {
      const parsed = ShellHooks.parse({
        hooks: {
          PreToolUse: [
            { type: "command", command: "flat.sh" },
            { matcher: "Write|Edit", hooks: [{ type: "command", command: "nested.sh" }] },
            { type: "command" },
          ],
          Nope: [{ type: "command", command: "x.sh" }],
          Stop: [{ type: "command", command: "stop.sh" }],
        },
      })
      expect(parsed.preToolUse).toEqual([{ command: "flat.sh" }, { command: "nested.sh", matcher: "Write|Edit" }])
      expect(parsed.postToolUse).toEqual([])
      expect(parsed.warnings.length).toBe(3)
    }))

  it("rejects non-object files without throwing", () =>
    Effect.gen(function* () {
      expect(ShellHooks.parse(undefined).warnings.length).toBe(1)
      expect(ShellHooks.parse({ hooks: [] }).warnings.length).toBe(1)
    }))

  it("expands root aliases quoted and matches tools", () =>
    Effect.gen(function* () {
      expect(ShellHooks.expand("${PLUGIN_ROOT}/a ${CLAUDE_PLUGIN_ROOT}/b ${NOPE}", vars)).toBe(
        "'/plugin'/a '/plugin'/b ${NOPE}",
      )
      expect(ShellHooks.matches(undefined, "Write")).toBe(true)
      expect(ShellHooks.matches("Write|Edit", "Edit")).toBe(true)
      expect(ShellHooks.matches("Write", "Read")).toBe(false)
      expect(ShellHooks.matches("[invalid", "[invalid")).toBe(true)
    }))

  it("times out hung commands instead of stalling", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        ShellHooks.run("sleep 30", {}, { root: tmpdir(), data: tmpdir() }, 200),
      )
      expect(result.exit).toBe(124)
      expect(result.stderr).toContain("timed out")
    }))

  it("runs commands with payload on stdin", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        ShellHooks.run("cat", { hello: "world" }, { root: tmpdir(), data: tmpdir() }),
      )
      expect(result.exit).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ hello: "world" })
    }))

  it("observes tool calls without mutating them", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        fixture({ "hook.sh": "#!/bin/sh\ncat > ${PLUGIN_DATA}/marker\n" }),
      )
      try {
        const data = path.join(root, "data")
        yield* Effect.promise(() => Bun.$`mkdir -p ${data}`.quiet())
        yield* Effect.promise(() => chmod(path.join(root, "hook.sh"), 0o755))
        const hooks = ShellHooks.build(
          ShellHooks.parse({ hooks: { PreToolUse: [{ type: "command", command: "./hook.sh" }] } }),
          { root, data },
          "demo",
        )
        const before = hooks["tool.execute.before"]
        expect(before).toBeDefined()
        const output = { args: { path: "a.txt" } }
        yield* Effect.promise(() =>
          before!({ tool: "Edit", sessionID: "s", callID: "c" }, output),
        )
        expect(output).toEqual({ args: { path: "a.txt" } })
        const marker = yield* Effect.promise(() => Bun.file(path.join(data, "marker")).text())
        expect(JSON.parse(marker).tool).toBe("Edit")
      } finally {
        yield* cleanup(root)
      }
    }))

  it("loads hook files with isolation", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const root = yield* Effect.promise(() =>
        fixture({
          "ai.opencode/hooks/hooks.json": JSON.stringify({
            hooks: { PostToolUse: [{ type: "command", command: "notify.sh" }] },
          }),
        }),
      )
      try {
        const loaded = yield* ShellHooks.loadFile(fs, path.join(root, "ai.opencode"), { root, data: root }, "demo")
        expect(loaded?.hooks?.["tool.execute.after"]).toBeDefined()
        expect(loaded?.hooks?.["tool.execute.before"]).toBeDefined()
        const missing = yield* ShellHooks.loadFile(fs, path.join(root, "missing"), { root, data: root }, "demo")
        expect(missing).toBeUndefined()
      } finally {
        yield* cleanup(root)
      }
    }))
})
