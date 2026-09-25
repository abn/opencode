# Agent Plugins

Opencode loads [Agent Plugins](https://agent-plugins.org/) v1.0.0 directory
packages from shared ecosystem roots and opencode-owned directories. Shared
roots belong to every harness: `~/.agents/plugins/` globally and
`.agents/plugins/` in each ancestor of the working directory. Opencode-owned
roots live in `agent-plugins/` inside every config directory (global and
project `.opencode` roots). Roots scan global-first; shared roots sort
before opencode-owned ones at the same scope, so explicitly installed
packages win name collisions, and project roots shadow global ones.

A conformant package is a directory with a root `plugin.json` and optional
components:

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
  be kebab-case and match their directory, and the directory and its
  `SKILL.md` are resolved through realpath and contained before being read.
  Plugin skill sources sort before user sources, so a same-named user skill
  always wins.
- **Extension markdown** under `ai.opencode/{agents,commands,modes}/` is
  enumerated and contained by discovery, not by the user-configuration globs
  (those follow symlinks on purpose, and a package must not inherit that).
- **`mcp.json`** maps servers onto native `Mcp.ServerConfig` entries.
  `stdio` entries map to local servers with a plugin-root default cwd and a
  writable per-plugin data directory; `streamable-http` entries map to remote
  servers. `sse` is skipped loudly because opencode remotes always lead with
  streamable HTTP. `./`-relative commands and cwd values are
  containment-checked against the form's own base through realpath before
  any directory is created: a cwd whose nearest existing ancestor resolves
  outside that base is rejected without touching the filesystem. A
  `PLUGIN_DATA` directory that cannot be provisioned disables the package's
  servers rather than handing them a path that would not exist at launch.
  Servers colliding with user config keys are skipped so user config wins.
- **`${PLUGIN_ROOT}`** and **`${PLUGIN_DATA}`** expand in `args`, `env`, and
  `cwd`. `PLUGIN_ROOT`/`PLUGIN_DATA` are also exported to every server and hook
  process; `PLUGIN_DATA` is a writable directory that persists across updates.

## ai.opencode extension

The `ai.opencode` reverse-domain namespace is opencode-specific. Portable
clients ignore it.

- **`plugin.ts`** (or `plugin.js`) default-exports the opencode plugin
  definition (`id`, `effect` or `setup`). It loads as a file-target plugin
  operation with `plugin_root` and `plugin_data` in its options. A missing or
  malformed module id falls back to the manifest name instead of failing.
- **`agents/`, `commands/`, `modes/`** use the same markdown + frontmatter
  format as their config-directory equivalents. Plugin documents sort before
  local documents, so local entries win on name collision.
- **`hooks/hooks.json`** observes tool calls via `PreToolUse`/`PostToolUse`
  entries in the flat or Claude-compatible matcher form. Commands run through
  `sh` with the plugin root as cwd and the tool event payload on stdin; one
  hung command is terminated after 60s and never stalls tool execution. The
  `${CLAUDE_PLUGIN_ROOT}` alias is expanded alongside `${PLUGIN_ROOT}`.

## Architecture

`agent-plugins/service.ts` owns discovery and the container watches. One
Location-scoped service scans the container roots, caches the
contributions (extensions, skills, MCP servers), attaches the watches, and
publishes updates on `changes()`. The config plugins for skills, MCP,
agents, commands, and plugin sources reload from those caches; none of
them scans or watches containers itself. MCP entries are cached unfiltered
and the service filters them per consumer against that consumer's
user-config keys. Each consumer serializes its own
load-then-commit sequence so a late-finishing older scan cannot overwrite a
newer one, and containers that do not exist yet are watched through their
nearest existing parent so a newly created plugins directory is noticed.

## Isolation and precedence

- One broken package, entry, or hook never fails config or the host.
- User config wins every collision with plugin contributions.
- A project package with the same name as a global one shadows it with a
  warning, resolved identically across skills, MCP servers, hooks, agents,
  commands, and modes.
- Container update failures are per-consumer: one failing notify never
  kills the shared watch, and the claimed watch is released so the next
  refresh re-subscribes.
