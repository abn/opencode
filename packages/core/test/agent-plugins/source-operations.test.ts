import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Directory } from "@opencode/schema/config"
import { Config } from "@opencode/core/config"
import { AbsolutePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Manifest } from "@opencode/core/agent-plugins/manifest"
import { tempGlobalLayer } from "../fixture/global"
import { tempLocationLayer } from "../fixture/location"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const LocationReplace = Location.node.replace(tempLocationLayer)
const GlobalReplace = Global.node.replace(tempGlobalLayer)

const config = Config.testLayer([])

const it = testEffect(
  Layer.merge(
    config,
    AppNodeBuilder.build(LayerNode.group([ConfigPluginSource.node, FSUtil.node]), [
      LocationReplace,
      Watcher.node.replace(Watcher.testLayer),
      GlobalReplace,
      Config.node.replace(config),
    ]),
  ),
)

describe("agent-plugins.operations", () => {
  it.effect("emits file operations for extension entries with manifest fallback", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fs.mkdir(path.join(tmp.path, "agent-plugins", "demo", "ai.opencode"), { recursive: true }).then(() =>
            fs.writeFile(
              path.join(tmp.path, "agent-plugins", "demo", "plugin.json"),
              JSON.stringify({ $schema: Manifest.SCHEMA, name: "demo" }),
            ),
          ).then(() =>
            fs.writeFile(
              path.join(tmp.path, "agent-plugins", "demo", "ai.opencode", "plugin.ts"),
              "export default { effect: () => undefined }\n",
            ),
          ),
        )
        const config = yield* Config.Test
        yield* config.setEntries([new Directory({ type: "directory", path: AbsolutePath.make(tmp.path) })])
        const sources = yield* ConfigPluginSource.Service
        const operations = yield* sources.operations()
        const operation = operations.find(
          (entry): entry is Extract<typeof entry, { type: "add" }> =>
            entry.type === "add" && entry.target.endsWith(path.join("ai.opencode", "plugin.ts")),
        )
        expect(operation).toBeDefined()
        expect(operation?.options).toMatchObject({
          plugin_root: path.join(tmp.path, "agent-plugins", "demo"),
          plugin_data: expect.stringContaining(path.join("agent-plugins", "demo")),
        })
        expect(operation?.fallbackId).toBe("demo")
      }),
    ),
  )
})
