import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Directory } from "@opencode/schema/config"
import { Config } from "@opencode/core/config"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { AgentPluginsService } from "@opencode/core/agent-plugins/service"
import { Bus } from "@opencode/core/bus"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { Manifest } from "@opencode/core/agent-plugins/manifest"
import { location } from "../fixture/location"
import { withTempDir } from "../fixture/tmpdir"
import { host } from "../plugin/host"

const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

function writeFiles(root: string, files: Record<string, string>) {
  return Effect.promise(async () => {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content)
    }
  })
}

// Isolated home, data root, and location so shared ecosystem roots resolve to
// the fixture instead of the developer's real ones.
function site(root: string) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Skill.node,
      Bus.node,
      FSUtil.node,
      Global.node,
      Location.node,
      Watcher.node,
      AgentPluginsService.node,
      Config.node,
    ]),
    [
      Watcher.node.replace(Watcher.testLayer),
      Config.node.replace(Config.testLayer([new Directory({ type: "directory", path: AbsolutePath.make(root) })])),
      Global.node.replace(
        Global.layerWith({
          home: root,
          data: path.join(root, "data"),
          config: path.join(root, "config"),
          cache: path.join(root, "cache"),
        }),
      ),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(root) }))),
      ),
    ],
  )
}

const pluginSkills = Effect.fnUntraced(function* (root: string) {
  const layer = site(root)
  const service = yield* Skill.Service.pipe(Effect.provide(layer))
  const pluginHost = host({
    skill: {
      list: () => Effect.die("unused skill.list"),
      transform: service.transform,
      reload: service.reload,
    },
  })
  yield* ConfigSkillPlugin.Plugin.effect(pluginHost).pipe(
    Effect.provide(layer),
    Effect.provideService(SkillDiscovery.Service, SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) })),
  )
  return yield* service.list()
})

describe("agent-plugins.skills", () => {
  test("lets user skills override plugin skills", async () => {
    await Effect.runPromise(
      withTempDir((tmp) =>
        Effect.gen(function* () {
          yield* writeFiles(tmp.path, {
            "skills/dup/SKILL.md": skillFile("dup", "User skill."),
            "agent-plugins/demo/plugin.json": JSON.stringify({ $schema: Manifest.SCHEMA, name: "demo" }),
            "agent-plugins/demo/skills/dup/SKILL.md": skillFile("dup", "Plugin skill."),
            "agent-plugins/demo/skills/solo/SKILL.md": skillFile("solo", "Plugin only skill."),
          })

          const skills = yield* pluginSkills(tmp.path)
          const dup = skills.find((skill) => skill.id === "dup")
          expect(dup?.description).toBe("User skill.")
          expect(dup?.path).toContain(path.join("skills", "dup", "SKILL.md"))
          const solo = skills.find((skill) => skill.id === "solo")
          expect(solo?.description).toBe("Plugin only skill.")
        }),
      ).pipe(Effect.scoped),
    )
  })

  // Discovery validates exactly one SKILL.md per skill directory. Rescanning
  // that directory in the consumer would pick up nested and symlinked files
  // discovery never approved, so only the approved file may register.
  test("registers only the contained SKILL.md, not nested or symlinked ones", async () => {
    await Effect.runPromise(
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const outside = path.join(tmp.path, "outside")
          yield* writeFiles(tmp.path, {
            "agent-plugins/demo/plugin.json": JSON.stringify({ $schema: Manifest.SCHEMA, name: "demo" }),
            "agent-plugins/demo/skills/solo/SKILL.md": skillFile("solo", "Plugin only skill."),
            "agent-plugins/demo/skills/solo/nested/SKILL.md": skillFile("nested", "Nested skill."),
            "outside/SKILL.md": skillFile("outside", "Escaped skill."),
          })
          yield* Effect.promise(() =>
            fs.symlink(outside, path.join(tmp.path, "agent-plugins", "demo", "skills", "solo", "vendor")),
          )

          const skills = yield* pluginSkills(tmp.path)
          expect(skills.map((skill) => skill.id)).toEqual([Skill.ID.make("solo")])
        }),
      ).pipe(Effect.scoped),
    )
  })
})
