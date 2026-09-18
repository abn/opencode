import { describe, expect, test } from "bun:test"
import { Manifest } from "@/agent-plugins/manifest"
import { McpConfig } from "@/agent-plugins/mcp-config"
import { Paths } from "@/agent-plugins/paths"

const manifest = { $schema: Manifest.SCHEMA, name: "demo" }
const mcpSchema = McpConfig.SCHEMA

describe("agent-plugins.manifest", () => {
  test("accepts a minimal manifest", () => {
    const result = Manifest.parse(manifest)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  test("reports and ignores unknown fields", () => {
    const result = Manifest.parse({ ...manifest, commands: [] })
    expect(result.ok).toBe(true)
    expect(result.warnings.map((issue) => issue.path)).toEqual([["commands"]])
  })

  test("reports and ignores non-object extensions", () => {
    const result = Manifest.parse({ ...manifest, extensions: "nope" })
    expect(result.ok).toBe(true)
    expect(result.warnings.length).toBe(1)
  })

  test("rejects unsupported schema versions", () => {
    const result = Manifest.parse({ ...manifest, $schema: "https://example.com/other.json" })
    expect(result.ok).toBe(false)
    expect(result.manifest).toBeUndefined()
  })

  test.each(["Bad", "-lead", "trail-", "has--double", "too..dots", "", "a".repeat(65), "under_score"])(
    "rejects invalid name %s",
    (name) => {
      expect(Manifest.parse({ ...manifest, name }).ok).toBe(false)
    },
  )

  test.each(["a", "my-plugin", "acme.tools", "lint3r", "a".repeat(64)])("accepts valid name %s", (name) => {
    expect(Manifest.parse({ ...manifest, name }).ok).toBe(true)
  })

  test("rejects unknown author fields and mistyped metadata", () => {
    expect(Manifest.parse({ ...manifest, author: { nickname: "x" } }).ok).toBe(false)
    expect(Manifest.parse({ ...manifest, keywords: "nope" }).ok).toBe(false)
    expect(Manifest.parse({ ...manifest, version: 2 }).ok).toBe(false)
  })

  test("rejects non-object input", () => {
    expect(Manifest.parse([]).ok).toBe(false)
    expect(Manifest.parse("nope").ok).toBe(false)
  })
})

describe("agent-plugins.mcp-config", () => {
  test("rejects unknown top-level fields and version mismatch", () => {
    expect(McpConfig.parse({ $schema: mcpSchema, mcpServers: {}, extra: 1 }, Manifest.SCHEMA).ok).toBe(false)
    expect(McpConfig.parse({ $schema: mcpSchema, mcpServers: {} }, "https://example.com/other.json").ok).toBe(
      false,
    )
  })

  test("isolates invalid entries", () => {
    const result = McpConfig.parse(
      {
        $schema: mcpSchema,
        mcpServers: {
          good: { type: "stdio", command: "serve" },
          bad: { type: "stdio" },
          unknown: { type: "carrier-pigeon" },
        },
      },
      Manifest.SCHEMA,
    )
    expect(result.ok).toBe(true)
    expect(result.servers["good"].ok).toBe(true)
    expect(result.servers["bad"].ok).toBe(false)
    expect(result.servers["unknown"].ok).toBe(false)
  })

  test.each([["serve"], ["./bin/serve"], ["python3.11"]])("accepts command %s", (command) => {
    const result = McpConfig.parse({ $schema: mcpSchema, mcpServers: { s: { type: "stdio", command } } }, Manifest.SCHEMA)
    expect(result.servers["s"].ok).toBe(true)
  })

  test.each([["../escape"], ["sub/dir/serve"], [""], ["sh -c serve"]])("rejects command %s", (command) => {
    const result = McpConfig.parse({ $schema: mcpSchema, mcpServers: { s: { type: "stdio", command } } }, Manifest.SCHEMA)
    expect(result.servers["s"].ok).toBe(false)
  })

  test("rejects reserved env keys and bad cwd forms", () => {
    const base = { type: "stdio", command: "serve" }
    const env = McpConfig.parse(
      { $schema: mcpSchema, mcpServers: { s: { ...base, env: { PLUGIN_ROOT: "/x" } } } },
      Manifest.SCHEMA,
    )
    expect(env.servers["s"].ok).toBe(false)
    const cwd = McpConfig.parse(
      { $schema: mcpSchema, mcpServers: { s: { ...base, cwd: "/absolute" } } },
      Manifest.SCHEMA,
    )
    expect(cwd.servers["s"].ok).toBe(false)
  })

  test("enforces remote url rules", () => {
    const cases: Array<[string, boolean]> = [
      ["https://example.com/mcp", true],
      ["http://localhost:8080/mcp", true],
      ["http://127.0.0.1/mcp", true],
      ["http://[::1]/mcp", true],
      ["http://example.com/mcp", false],
      ["https://user@example.com/mcp", false],
      ["https://example.com/mcp#frag", false],
      ["notaurl", false],
    ]
    for (const [url, ok] of cases) {
      const result = McpConfig.parse(
        { $schema: mcpSchema, mcpServers: { s: { type: "streamable-http", url } } },
        Manifest.SCHEMA,
      )
      expect(result.servers["s"].ok).toBe(ok)
    }
  })

  test("rejects duplicate case-insensitive headers", () => {
    const result = McpConfig.parse(
      {
        $schema: mcpSchema,
        mcpServers: { s: { type: "streamable-http", url: "https://example.com/m", headers: { "X-A": "1", "x-a": "2" } } },
      },
      Manifest.SCHEMA,
    )
    expect(result.servers["s"].ok).toBe(false)
  })
})

describe("agent-plugins.paths", () => {
  test("expands once without rescanning replacements", () => {
    expect(Paths.expandPlaceholders("${PLUGIN_ROOT}/a", { root: "/r", data: "/d" })).toBe("/r/a")
    expect(Paths.expandPlaceholders("${NOPE}", { root: "/r", data: "/d" })).toBe("${NOPE}")
    expect(Paths.expandPlaceholders("${PLUGIN_ROOT}", { root: "/x${PLUGIN_DATA}", data: "/d" })).toBe("/x${PLUGIN_DATA}")
  })

  test("classifies cwd forms", () => {
    expect(Paths.classifyCwd("./a")).toBe("plugin-relative")
    expect(Paths.classifyCwd("${PLUGIN_ROOT}")).toBe("plugin-root")
    expect(Paths.classifyCwd("${PLUGIN_ROOT}/a")).toBe("plugin-root")
    expect(Paths.classifyCwd("${PLUGIN_DATA}/a")).toBe("plugin-data")
    expect(Paths.classifyCwd("/abs")).toBe("invalid")
    expect(Paths.classifyCwd("rel")).toBe("invalid")
  })

  test("contains sibling-prefix escapes", () => {
    expect(Paths.containsPath("/a/b", "/a/b/c")).toBe(true)
    expect(Paths.containsPath("/a/b", "/a/bc")).toBe(false)
    expect(Paths.containsPath("/a/b", "/a/b/../bc")).toBe(false)
  })

  test("resolves omitted cwd to the plugin root", () => {
    expect(Paths.resolveCwd(undefined, { root: "/r", data: "/d" })).toBe("/r")
    expect(Paths.resolveCwd("/abs", { root: "/r", data: "/d" })).toBeUndefined()
    expect(Paths.resolveCwd("./../out", { root: "/r", data: "/d" })).toBeUndefined()
    expect(Paths.resolveCwd("./${PLUGIN_ROOT}/bin", { root: "/r", data: "/d" })).toBeUndefined()
  })

  test("keeps plugin-data cwd inside the data directory", () => {
    expect(Paths.resolveCwd("${PLUGIN_DATA}/state", { root: "/r", data: "/d" })).toBe("/d/state")
    expect(Paths.resolveCwd("${PLUGIN_DATA}/../escape", { root: "/r", data: "/d" })).toBeUndefined()
    expect(Paths.resolveCwd("${PLUGIN_ROOT}", { root: "/r", data: "/d" })).toBe("/r")
    expect(Paths.resolveCwd("./data", { root: "/r", data: "/d" })).toBe("/r/data")
  })

  test("does not rescan replacement text", () => {
    expect(Paths.expandPlaceholders("${PLUGIN_ROOT}", { root: "/x${PLUGIN_DATA}", data: "/d" })).toBe("/x${PLUGIN_DATA}")
    expect(Paths.expandPlaceholders("${PLUGIN_ROOT} ${PLUGIN_DATA}", { root: "/r", data: "/d" })).toBe("/r /d")
    expect(Paths.expandPlaceholders("x${PLUGIN_ROOT} ${NOPE} ${PLUGIN_DATA}y", { root: "/r", data: "/d" })).toBe(
      "x/r ${NOPE} /dy",
    )
  })
})
