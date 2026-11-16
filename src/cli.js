#!/usr/bin/env node
// @ts-check
/**
 * neme — publish web games to neme.world.
 *
 *   neme init [dir]       write a starter neme.json
 *   neme publish [dir]    publish the build as a new version (add --preview to hold it back)
 *   neme promote <n>      make version n the live one
 *
 * Plain JavaScript on purpose: it runs from a checkout or from npm with no build.
 */
import { createHash } from 'node:crypto'
import { createReadStream, openAsBlob, realpathSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const DEFAULT_API = 'https://neme.world'
const SKIP_DIRS = new Set(['node_modules'])

/**
 * @typedef {object} Manifest
 * @property {string} slug
 * @property {string} title
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {string} [dir]     Folder holding the built index.html, relative to neme.json. Default ".".
 * @property {string} [entry]   Default "index.html".
 * @property {string} [cover]   Image inside `dir`.
 * @property {string} [aspect]  "16:9" | "4:3" | "1:1" | "3:4" | "9:16"
 * @property {string[]} [controls]  Any of "keyboard", "mouse", "touch", "gamepad".
 * @property {string[]} [embedOn]  Host names of the sites that may embed the game, e.g. ["example.com"].
 * @property {{ max: number } | null} [leaderboard]  Rank reported scores on the game's page; `max` is the highest believable score.
 * @property {string} [license]
 * @property {string} [sourceUrl]
 * @property {string} [credit]
 */

export class CliError extends Error {}

/** @param {string} dir @returns {Promise<Manifest>} */
export async function readManifest(dir) {
  const file = path.join(dir, 'neme.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new CliError(`No neme.json in ${dir}. Run "neme init" to create one.`)
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${/** @type {Error} */ (err).message}`)
  }
  if (typeof manifest?.slug !== 'string' || typeof manifest?.title !== 'string') {
    throw new CliError(`${file} needs at least "slug" and "title".`)
  }
  return manifest
}

/**
 * @typedef {object} LocalFile
 * @property {string} path    Path inside the build, with forward slashes.
 * @property {string} file    Where it is on disk.
 * @property {number} size
 * @property {string} sha256
 */

/** @param {string} file @returns {Promise<string>} */
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Lists every publishable file under `root`, with its size and hash. Dotfiles
 * and node_modules are left out so secrets and dependencies don't get uploaded
 * by accident. Files are hashed from disk, never held in memory whole.
 * @param {string} root
 * @returns {Promise<LocalFile[]>}
 */
export async function collectFiles(root) {
  /** @type {LocalFile[]} */
  const files = []
  /** @param {string} rel */
  async function walk(rel) {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      const file = path.join(root, child)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() && child !== 'neme.json') files.push({ path: child, file, size: (await stat(file)).size, sha256: await sha256Of(file) })
    }
  }
  await walk('')
  return files.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/**
 * @param {string} api
 * @param {string} token
 * @param {string} method
 * @param {string} route
 * @param {{ json?: unknown, body?: Blob }} [o]
 */
async function call(api, token, method, route, o = {}) {
  /** @type {Record<string, string>} */
  const headers = { authorization: `Bearer ${token}` }
  /** @type {BodyInit | undefined} */
  let body
  if (o.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(o.json)
  } else if (o.body) {
    headers['content-type'] = 'application/octet-stream'
    body = o.body
  }
  let res
  try {
    res = await fetch(`${api}/api/v1${route}`, { method, headers, body })
  } catch (err) {
    throw new CliError(`Could not reach ${api}: ${/** @type {Error} */ (err).cause ?? /** @type {Error} */ (err).message}`)
  }
  const data = /** @type {any} */ (res.status === 204 ? {} : await res.json().catch(() => ({})))
  if (!res.ok) throw new CliError(`${data.error ?? `Request failed (${res.status})`}`)
  return data
}

/**
 * Whether the caller already has a game at this slug. Only a clear yes or no is
 * accepted: on any other answer this throws, because guessing "no" would send
 * the details and change a live game during what was meant to be a preview.
 * @param {string} api @param {string} token @param {string} slug
 */
async function gameExists(api, token, slug) {
  let res
  try {
    res = await fetch(`${api}/api/v1/games/${slug}/versions`, { headers: { authorization: `Bearer ${token}` } })
  } catch (err) {
    throw new CliError(`Could not reach ${api}: ${/** @type {Error} */ (err).cause ?? /** @type {Error} */ (err).message}`)
  }
  if (res.status === 200) return true
  if (res.status === 404) return false
  const data = /** @type {any} */ (await res.json().catch(() => ({})))
  throw new CliError(`${data.error ?? `Could not check whether "${slug}" exists (${res.status})`}`)
}

/** @param {number} n */
const size = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

/** How many files are sent at once. */
const PARALLEL = 6

/**
 * Publishes file by file: declare everything, send only what the platform does
 * not already have, then turn the upload into a version.
 * With `preview`, the version is uploaded but not made live: players stay where
 * they are, and the result carries the address where the new build can be tried.
 * @param {{ dir: string, api: string, token: string, preview?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<{ version: number, url: string, live: boolean, warnings: string[], uploaded: number }>}
 */
export async function publish({ dir, api, token, preview = false, log = console.log }) {
  const manifest = await readManifest(dir)
  const buildDir = path.resolve(dir, manifest.dir ?? '.')
  const entry = manifest.entry ?? 'index.html'

  const info = await stat(buildDir).catch(() => null)
  if (!info?.isDirectory()) throw new CliError(`Build folder ${buildDir} does not exist. Did you run your build?`)
  const files = await collectFiles(buildDir)
  if (!files.some((f) => f.path === entry)) throw new CliError(`${buildDir} has no ${entry}. Set "dir" in neme.json to your build output folder.`)
  if (manifest.cover && !files.some((f) => f.path === manifest.cover)) throw new CliError(`Cover "${manifest.cover}" was not found in ${buildDir}.`)

  const total = files.reduce((n, f) => n + f.size, 0)
  log(`${manifest.title}: ${files.length} file${files.length === 1 ? '' : 's'}, ${size(total)}`)

  const { slug, dir: _dir, entry: _entry, ...details } = manifest
  // A preview must leave the live game exactly as players see it, title and cover
  // included. So the details in neme.json are only sent with a preview when the
  // game does not exist yet and has to be created.
  const exists = preview && (await gameExists(api, token, slug))
  if (!exists) await call(api, token, 'PUT', `/games/${slug}`, { json: details })
  else log('  (details in neme.json are applied when you publish without --preview)')
  const begun = await call(api, token, 'POST', `/games/${slug}/uploads`, {
    json: { entry, files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) },
  })

  /** @type {{ sha256: string, size: number }[]} */
  const missing = begun.missing
  const byHash = new Map(files.map((f) => [f.sha256, f]))
  const sending = missing.reduce((n, m) => n + m.size, 0)
  if (missing.length) log(`  uploading ${missing.length} file${missing.length === 1 ? '' : 's'} (${size(sending)}); ${files.length - missing.length} already there`)
  else log('  nothing new to upload')

  const queue = [...missing]
  const send = async () => {
    for (let next = queue.pop(); next; next = queue.pop()) {
      const local = /** @type {LocalFile} */ (byHash.get(next.sha256))
      const route = `/games/${slug}/uploads/${begun.upload}/blobs/${next.sha256}`
      try {
        await call(api, token, 'PUT', route, { body: await openAsBlob(local.file) })
      } catch (err) {
        // One retry covers a dropped connection; anything else is reported with the file's name.
        try {
          await call(api, token, 'PUT', route, { body: await openAsBlob(local.file) })
        } catch (again) {
          throw new CliError(`Could not upload ${local.path}: ${/** @type {Error} */ (again).message}`)
        }
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, send))

  const out = await call(api, token, 'POST', `/games/${slug}/uploads/${begun.upload}/complete`, { json: { activate: !preview } })
  for (const w of [...(begun.warnings ?? []), ...(out.warnings ?? [])]) log(`  warning: ${w}`)
  const saved = out.transferBytes < out.bytes ? ` (${size(out.bytes)} before compression)` : ''
  if (out.live) {
    log(`  v${out.version} is live — ${size(out.transferBytes)} to download${saved}`)
    log(`  ${out.game.url}`)
  } else {
    log(`  v${out.version} is uploaded as a preview — ${size(out.transferBytes)} to download${saved}`)
    log(`  try it:       ${out.previewUrl}`)
    log(`  make it live: neme promote ${out.version}`)
  }
  return { version: out.version, url: out.live ? out.game.url : out.previewUrl, live: out.live, warnings: out.warnings ?? [], uploaded: missing.length }
}

/**
 * Makes an already-uploaded version the live one. Works for a preview, and for going back to an earlier version.
 * @param {{ dir: string, api: string, token: string, version: number, log?: (line: string) => void }} o
 */
export async function promote({ dir, api, token, version, log = console.log }) {
  const { slug, title } = await readManifest(dir)
  const out = await call(api, token, 'POST', `/games/${slug}/activate`, { json: { version } })
  log(`${title}: v${version} is live`)
  log(`  ${out.game.url}`)
  // Promoting moves players to a version; it deliberately leaves the title, cover and other details alone.
  log('  (details in neme.json were not changed; "neme publish" applies them)')
  return { url: out.game.url }
}

/**
 * Lists a game's versions, newest first, saying which one players are on.
 * @param {{ dir: string, api: string, token: string, log?: (line: string) => void }} o
 */
export async function versions({ dir, api, token, log = console.log }) {
  const { slug, title } = await readManifest(dir)
  const out = await call(api, token, 'GET', `/games/${slug}/versions`)
  /** @type {{ version: number, files: number, bytes: number, createdAt: number }[]} */
  const list = out.versions ?? []
  log(`${title}: ${list.length} version${list.length === 1 ? '' : 's'}${out.current ? `, players are on v${out.current}` : ', not published'}`)
  for (const v of [...list].sort((a, b) => b.version - a.version)) {
    log(`  v${v.version}${v.version === out.current ? ' (live)' : ''}  ${new Date(v.createdAt).toISOString().slice(0, 10)}  ${v.files} file${v.files === 1 ? '' : 's'}, ${size(v.bytes)}`)
  }
  return { current: /** @type {number | null} */ (out.current ?? null), versions: list }
}

/**
 * Deletes one version for good. The platform refuses the version players are on.
 * @param {{ dir: string, api: string, token: string, version: number, log?: (line: string) => void }} o
 */
export async function remove({ dir, api, token, version, log = console.log }) {
  const { slug, title } = await readManifest(dir)
  const out = await call(api, token, 'DELETE', `/games/${slug}/versions/${version}`)
  log(`${title}: v${version} is deleted${out.freedBytes ? `, ${size(out.freedBytes)} given back` : ''}`)
  return { freedBytes: /** @type {number} */ (out.freedBytes ?? 0) }
}

/** @param {string} dir @param {(line: string) => void} [log] */
async function init(dir, log = console.log) {
  const file = path.join(dir, 'neme.json')
  if (await stat(file).catch(() => null)) throw new CliError(`${file} already exists.`)
  const name = path.basename(path.resolve(dir))
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-game'
  const hasDist = await stat(path.join(dir, 'dist')).catch(() => null)
  const manifest = {
    slug,
    title: name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: '',
    tags: [],
    dir: hasDist ? 'dist' : '.',
  }
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
  log(`Wrote ${file}. Edit it, then run "neme publish".`)
}

// ── MCP server ───────────────────────────────────────────────────────────────
// `neme mcp` lets a coding agent publish for its developer. It speaks the Model
// Context Protocol over standard input and output: one JSON-RPC message per
// line. The tools are the commands above and nothing more, with the same token.

const str = { type: 'string' }
const TOOLS = [
  {
    name: 'neme_guide',
    description: 'How to make a game that works on neme.world and publish it: the neme.json fields, the rules a build must meet, the SDK (scores, leaderboards, sharing, clips). Read this first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'neme_init',
    description: 'Create a neme.json in a project folder (slug, title, description, tags, dir). Edit it afterwards.',
    inputSchema: { type: 'object', properties: { dir: { ...str, description: 'Project folder. Default: the current folder.' } } },
  },
  {
    name: 'neme_publish',
    description: 'Publish the game described by dir/neme.json to neme.world. With preview true, upload without going live and get a private link to try the build; publish for real only when the developer says so.',
    inputSchema: {
      type: 'object',
      properties: { dir: { ...str, description: 'Folder holding neme.json. Default: the current folder.' }, preview: { type: 'boolean', description: 'Upload without making it live.' } },
    },
  },
  {
    name: 'neme_promote',
    description: 'Make an already-uploaded version live: a preview the developer has approved, or an earlier version to roll back to.',
    inputSchema: { type: 'object', properties: { dir: str, version: { type: 'integer', minimum: 1 } }, required: ['version'] },
  },
  {
    name: 'neme_versions',
    description: 'List a game\'s versions, newest first, and which one players are on. A game keeps a limited number; when a publish is refused for that, older ones have to be deleted.',
    inputSchema: { type: 'object', properties: { dir: { ...str, description: 'Folder holding neme.json. Default: the current folder.' } } },
  },
  {
    name: 'neme_delete_version',
    description: 'Delete one version of a game for good. It cannot be undone, so do it only when the developer has said which version to delete. The version players are on cannot be deleted.',
    inputSchema: { type: 'object', properties: { dir: str, version: { type: 'integer', minimum: 1 } }, required: ['version'] },
  },
  {
    name: 'neme_metrics',
    description: 'The last 30 days of a game: views, plays, time played, shares.',
    inputSchema: { type: 'object', properties: { dir: { ...str, description: 'Folder holding neme.json. Default: the current folder.' } } },
  },
]

/**
 * Runs one tool and returns what it has to say.
 * @param {string} name @param {Record<string, unknown>} args @param {{ api: string, token: string | undefined }} env
 */
async function runTool(name, args, env) {
  /** @type {string[]} */
  const lines = []
  const log = (/** @type {string} */ line) => void lines.push(line)
  const dir = typeof args.dir === 'string' && args.dir ? args.dir : '.'
  if (name === 'neme_guide') {
    const res = await fetch(`${env.api}/llms.txt`).catch(() => null)
    if (!res?.ok) throw new CliError(`Could not read ${env.api}/llms.txt`)
    return res.text()
  }
  if (name === 'neme_init') {
    await init(dir, log)
    return lines.join('\n')
  }
  if (!env.token) throw new CliError('No API token. The developer creates one at https://neme.world/dashboard and sets NEME_TOKEN for this server.')
  if (name === 'neme_publish') await publish({ dir, api: env.api, token: env.token, preview: args.preview === true, log })
  else if (name === 'neme_promote') {
    if (!Number.isInteger(args.version) || /** @type {number} */ (args.version) < 1) throw new CliError('version must be a whole number, 1 or more.')
    await promote({ dir, api: env.api, token: env.token, version: /** @type {number} */ (args.version), log })
  } else if (name === 'neme_versions') await versions({ dir, api: env.api, token: env.token, log })
  else if (name === 'neme_delete_version') {
    if (!Number.isInteger(args.version) || /** @type {number} */ (args.version) < 1) throw new CliError('version must be a whole number, 1 or more.')
    await remove({ dir, api: env.api, token: env.token, version: /** @type {number} */ (args.version), log })
  } else if (name === 'neme_metrics') {
    const { slug } = await readManifest(dir)
    const out = await call(env.api, env.token, 'GET', `/games/${slug}/metrics`)
    return JSON.stringify(out.totals ?? out, null, 2)
  } else throw new CliError(`No such tool: ${name}`)
  return lines.join('\n')
}

/**
 * Answers one message. Returns nothing for a notification.
 * @param {any} msg @param {{ api: string, token: string | undefined, version: string }} env
 */
export async function answerMcp(msg, env) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } }
  }
  // (A message with no id is a notification: it is never answered.)
  if (msg.id === undefined || msg.id === null) return undefined
  const reply = (/** @type {unknown} */ result) => ({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize') {
    return reply({
      protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'neme-world', version: env.version },
      instructions: 'Publishes web games to neme.world. Call neme_guide first. Publish with preview true and show the developer the link; make a version live only when they say so.',
    })
  }
  if (msg.method === 'ping') return reply({})
  if (msg.method === 'tools/list') return reply({ tools: TOOLS })
  if (msg.method === 'tools/call') {
    const name = msg.params?.name
    const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}
    if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } }
    try {
      return reply({ content: [{ type: 'text', text: await runTool(name, args, env) }] })
    } catch (err) {
      // A tool that fails says why, as its result: the agent can read that and try again.
      const text = err instanceof CliError ? err.message : `Unexpected error: ${/** @type {Error} */ (err).message}`
      return reply({ content: [{ type: 'text', text }], isError: true })
    }
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
}

/** @param {{ api: string, token: string | undefined, version: string }} env */
async function serveMcp(env) {
  // Standard output carries the protocol and nothing else; anything for a person goes to standard error.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`)
      continue
    }
    const out = await answerMcp(msg, env)
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`)
  }
}

const HELP = `neme — publish web games to neme.world

Usage
  neme init [dir]         Create a neme.json in dir (default: current folder)
  neme publish [dir]      Publish the game described by dir/neme.json
  neme promote <n> [dir]  Make version n live (a preview, or an earlier version)
  neme versions [dir]     List the game's versions, and which one players are on
  neme delete <n> [dir]   Delete version n for good (not the one players are on)
  neme mcp                Run as an MCP server, so a coding agent can do the above

Options
  --preview               Upload without going live; prints a link to try the build
  --api <url>             Platform address (default: $NEME_API or ${DEFAULT_API})
  --token <token>         API token (default: $NEME_TOKEN). Create one in your dashboard.
  -h, --help              Show this help
  -v, --version           Show the version
`

/** @param {string[]} argv */
export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      api: { type: 'string' }, token: { type: 'string' }, preview: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  })
  const [command, dir = '.'] = positionals
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    return void console.log(pkg.version)
  }
  if (values.help || !command) return void console.log(HELP)

  if (command === 'init') return init(dir)
  if (command === 'mcp') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    return serveMcp({
      api: (values.api ?? process.env.NEME_API ?? DEFAULT_API).replace(/\/+$/, ''), token: values.token ?? process.env.NEME_TOKEN, version: pkg.version,
    })
  }
  if (command === 'publish' || command === 'promote' || command === 'versions' || command === 'delete') {
    const token = values.token ?? process.env.NEME_TOKEN
    if (!token) throw new CliError('No API token. Set NEME_TOKEN or pass --token. Create one at https://neme.world/dashboard')
    const api = (values.api ?? process.env.NEME_API ?? DEFAULT_API).replace(/\/+$/, '')
    if (command === 'publish') {
      await publish({ dir, api, token, preview: values.preview })
      return
    }
    if (command === 'versions') {
      await versions({ dir, api, token })
      return
    }
    // promote <version> [dir], delete <version> [dir]
    const version = Number(positionals[1])
    if (!Number.isInteger(version) || version < 1) {
      throw new CliError(command === 'delete' ? 'Say which version to delete, for example: neme delete 3' : 'Say which version to make live, for example: neme promote 7')
    }
    if (command === 'delete') await remove({ dir: positionals[2] ?? '.', api, token, version })
    else await promote({ dir: positionals[2] ?? '.', api, token, version })
    return
  }
  throw new CliError(`Unknown command "${command}". Try "neme --help".`)
}

// Run only when executed directly (including through an npm bin symlink), not when imported.
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof CliError ? `neme: ${err.message}` : err)
    process.exit(1)
  })
}
