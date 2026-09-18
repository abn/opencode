export * as Paths from "./paths"

import path from "node:path"

export const PLUGIN_ROOT_VAR = "${PLUGIN_ROOT}"
export const PLUGIN_DATA_VAR = "${PLUGIN_DATA}"

// A plugin-relative path begins with ./ and resolves against the plugin root.
function isPluginRelative(value: string): boolean {
  return value.startsWith("./")
}

export type CwdForm = "plugin-relative" | "plugin-root" | "plugin-data" | "invalid"

// Classify an MCP server cwd value. Only three forms are portable; anything
// else makes that server entry invalid. A ./-relative value must be literal:
// placeholders have no meaning there and would be silently misread as a path.
export function classifyCwd(value: string): CwdForm {
  if (isPluginRelative(value)) return value.includes("$") ? "invalid" : "plugin-relative"
  if (value === PLUGIN_ROOT_VAR || value.startsWith(`${PLUGIN_ROOT_VAR}/`)) return "plugin-root"
  if (value === PLUGIN_DATA_VAR || value.startsWith(`${PLUGIN_DATA_VAR}/`)) return "plugin-data"
  return "invalid"
}

export interface Vars {
  root: string
  data: string
}

// Expand ${PLUGIN_ROOT} and ${PLUGIN_DATA} in a single left-to-right pass
// over the original text. Replacement text is inserted, never rescanned, so
// expansion is non-recursive and unrecognized text stays literal.
export function expandPlaceholders(value: string, vars: Vars): string {
  return value.replace(/\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g, (match) =>
    match === PLUGIN_ROOT_VAR ? vars.root : vars.data,
  )
}

export function expandList(values: Array<string>, vars: Vars): Array<string> {
  return values.map((value) => expandPlaceholders(value, vars))
}

export function expandRecord(record: Record<string, string>, vars: Vars): Record<string, string> {
  const expanded: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) expanded[key] = expandPlaceholders(value, vars)
  return expanded
}

// Lexical containment check: the candidate must resolve inside root. Callers
// handling untrusted packages must realpath both root and candidate first so
// symlinks cannot escape the package.
export function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(root, candidate))
  if (relative === "") return true
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

// Resolve an MCP server cwd to an absolute directory. Omitted cwd means the
// plugin root. Returns undefined for non-portable forms or escapes. A
// ./-relative value with a placeholder is already classified as invalid.
export function resolveCwd(cwd: string | undefined, vars: Vars): string | undefined {
  if (cwd === undefined) return path.resolve(vars.root)
  const form = classifyCwd(cwd)
  if (form === "invalid") return undefined
  if (form === "plugin-data") {
    const resolved = path.resolve(expandPlaceholders(cwd, vars))
    if (!containsPath(vars.data, resolved)) return undefined
    return resolved
  }
  const expanded = form === "plugin-relative" ? path.join(vars.root, cwd) : expandPlaceholders(cwd, vars)
  const resolved = path.resolve(expanded)
  if (!containsPath(vars.root, resolved)) return undefined
  return resolved
}
