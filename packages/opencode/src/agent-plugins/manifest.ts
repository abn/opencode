export * as Manifest from "./manifest"

import { isRecord } from "@/util/record"

export { isRecord }

// Canonical identifier for Agent Plugins 1.0.0 manifests. Clients select
// local validation rules from this value and never fetch it over the network.
export const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"

const KNOWN_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
])

export interface Issue {
  path: Array<string>
  message: string
}

export interface Author {
  name?: string
  email?: string
  url?: string
}

export interface Info {
  $schema: string
  name: string
  version?: string
  description?: string
  author?: Author
  homepage?: string
  repository?: string
  license?: string
  keywords?: Array<string>
  extensions?: Record<string, Record<string, unknown>>
}

export interface Result {
  ok: boolean
  manifest?: Info
  errors: Array<Issue>
  warnings: Array<Issue>
}

// Parse and validate a root plugin.json value. Unknown top-level fields and a
// non-object extensions field are warnings (report and ignore); every other
// violation is fatal to the plugin.
export function parse(input: unknown): Result {
  const errors: Array<Issue> = []
  const warnings: Array<Issue> = []
  const record = asRecord(input)
  if (!record) return fail("plugin.json must contain a top-level object", errors, warnings)

  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push({ path: [key], message: `Unknown field "${key}" ignored` })
  }

  const schema = readString(record, "$schema", errors)
  if (schema === undefined) return fail('Missing or invalid required field "$schema"', errors, warnings)
  if (schema !== SCHEMA) {
    errors.push({ path: ["$schema"], message: `Unsupported plugin version "${schema}"` })
    return { ok: false, errors, warnings }
  }

  const name = readString(record, "name", errors)
  if (name === undefined) return fail('Missing or invalid required field "name"', errors, warnings)
  const nameError = checkName(name)
  if (nameError) {
    errors.push({ path: ["name"], message: nameError })
    return { ok: false, errors, warnings }
  }

  const manifest: Info = { $schema: schema, name }
  for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
    const value = readOptionalString(record, field, errors)
    if (value === undefined && fieldPresent(record, field)) return fail(`Invalid field "${field}"`, errors, warnings)
    if (value !== undefined) manifest[field] = value
  }

  const author = readAuthor(record, errors)
  if (author === null) return fail('Invalid field "author"', errors, warnings)
  if (author) manifest.author = author

  const keywords = readKeywords(record, errors)
  if (keywords === null) return fail('Invalid field "keywords"', errors, warnings)
  if (keywords) manifest.keywords = keywords

  const extensions = readExtensions(record, warnings)
  if (extensions) manifest.extensions = extensions

  if (errors.length > 0) return { ok: false, errors, warnings }
  return { ok: true, manifest, errors, warnings }
}

function fail(message: string, errors: Array<Issue>, warnings: Array<Issue>): Result {
  if (errors.length === 0) errors.push({ path: [], message })
  return { ok: false, errors, warnings }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  return value
}

function fieldPresent(record: Record<string, unknown>, field: string): boolean {
  return record[field] !== undefined
}

function readString(record: Record<string, unknown>, field: string, errors: Array<Issue>): string | undefined {
  const value = record[field]
  if (typeof value !== "string" || value.length === 0) {
    errors.push({ path: [field], message: `Field "${field}" must be a non-empty string` })
    return undefined
  }
  return value
}

function readOptionalString(record: Record<string, unknown>, field: string, errors: Array<Issue>): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    errors.push({ path: [field], message: `Field "${field}" must be a string` })
    return undefined
  }
  return value
}

// Metadata URLs, emails, versions, and licenses are validated by type only;
// unrecognized values never reject a manifest. The author object itself is
// strict: only name, email, and url may appear.
//
// The return uses three states: undefined means the field is absent, null
// means it is present but invalid (fatal), and a value means it parsed.
function readAuthor(record: Record<string, unknown>, errors: Array<Issue>): Author | undefined | null {
  const value = record["author"]
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    errors.push({ path: ["author"], message: 'Field "author" must be an object' })
    return null
  }
  const author: Author = {}
  for (const field of ["name", "email", "url"] as const) {
    const entry = value[field]
    if (entry === undefined) continue
    if (typeof entry !== "string") {
      errors.push({ path: ["author", field], message: `Field "author.${field}" must be a string` })
      return null
    }
    author[field] = entry
  }
  for (const key of Object.keys(value)) {
    if (key !== "name" && key !== "email" && key !== "url") {
      errors.push({ path: ["author", key], message: `Unknown author field "${key}"` })
      return null
    }
  }
  return author
}

// Same three-state convention as readAuthor: undefined absent, null invalid,
// value parsed.
function readKeywords(record: Record<string, unknown>, errors: Array<Issue>): Array<string> | undefined | null {
  const value = record["keywords"]
  if (value === undefined) return undefined
  if (!isStringArray(value)) {
    errors.push({ path: ["keywords"], message: 'Field "keywords" must be an array of strings' })
    return null
  }
  return value
}

export function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
}

// Non-object extensions is non-fatal: report, ignore, keep loading. Member
// namespaces we do not implement pass through untouched; validation inside an
// implemented namespace belongs to that namespace, not the portable core.
function readExtensions(
  record: Record<string, unknown>,
  warnings: Array<Issue>,
): Record<string, Record<string, unknown>> | undefined {
  const value = record["extensions"]
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    warnings.push({ path: ["extensions"], message: 'Field "extensions" must be an object, ignored' })
    return undefined
  }
  const extensions: Record<string, Record<string, unknown>> = {}
  for (const [namespace, data] of Object.entries(value)) {
    if (!isRecord(data)) {
      warnings.push({ path: ["extensions", namespace], message: `Extension "${namespace}" must be an object, ignored` })
      continue
    }
    extensions[namespace] = data
  }
  return extensions
}

function checkName(name: string): string | undefined {
  if (name.length < 1 || name.length > 64) return "Plugin name must be between 1 and 64 characters"
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name))
    return 'Plugin name must use only a-z, 0-9, "-" and ".", starting and ending alphanumeric'
  if (name.includes("--") || name.includes("..")) return 'Plugin name must not contain "--" or ".."'
  return undefined
}
