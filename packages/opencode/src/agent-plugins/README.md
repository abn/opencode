# Agent Plugins

Opencode loads [Agent Plugins](https://agent-plugins.org/) v1.0.0 directory
packages from an `agent-plugins/` directory inside every config directory
(global and project). A conformant package is a directory with a root
`plugin.json` and optional components:

```text
my-plugin/
├── plugin.json
├── skills/
│   └── greet/
│       └── SKILL.md
├── mcp.json
└── ai.opencode/            # opencode-specific behavior
    ├── plugin.ts           # optional JS lifecycle hooks
    ├── agents/             # optional agent markdown files
    ├── commands/           # optional command markdown files
    ├── modes/              # optional mode markdown files
    └── hooks/
        └── hooks.json      # optional shell hook observers
```

## Portable core

- **`plugin.json`** must use the canonical `$schema` and declare a valid
  `name`. Unknown top-level fields are reported and ignored; schema violations
  are fatal to the package, never to the host.
- **`skills/`** holds one skill per immediate child directory. Skill names must
  be kebab-case and match their directory. Skills load before user skills, so a
  same-named user skill always wins.
- **`mcp.json`** maps servers onto native opencode entries. `stdio` entries map
  to local servers with a plugin-root default cwd and a writable per-plugin
  data directory; `streamable-http` entries map to remote servers. `sse` is
  skipped loudly because opencode remotes always lead with streamable HTTP.
  `./`-relative commands and cwd values are containment-checked via realpath.
- **`${PLUGIN_ROOT}`** and **`${PLUGIN_DATA}`** expand in `args`, `env`, and
  `cwd`. `PLUGIN_ROOT`/`PLUGIN_DATA` are also exported to every server and hook
  process; `PLUGIN_DATA` is a writable directory that persists across updates.

## ai.opencode extension

The `ai.opencode` reverse-domain namespace is opencode-specific. Portable
clients ignore it.

- **`plugin.ts`** default-exports the opencode plugin module shape (`server`,
  `id`). The module receives `plugin_root` and `plugin_data` in its options and
  may register any of the lifecycle hooks from `@opencode-ai/plugin`.
- **`agents/`, `commands/`, `modes/`** use the same markdown + frontmatter
  format as their config-directory equivalents.
- **`hooks/hooks.json`** observes tool calls via `PreToolUse`/`PostToolUse`
  entries in the flat or Claude-compatible matcher form. Commands run through
  `sh` with the plugin root as cwd and the event payload on stdin; one hung
  command is terminated after 60s and never stalls tool execution. The
  `${CLAUDE_PLUGIN_ROOT}` alias is expanded alongside `${PLUGIN_ROOT}`.

## Isolation and precedence

- One broken package, entry, or hook never fails config or the host.
- User config wins every collision with plugin contributions.
- A project package with the same name as a global one shadows it with a
  warning, resolved identically across skills, MCP servers, hooks, agents,
  commands, and modes.