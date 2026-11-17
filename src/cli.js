#!/usr/bin/env node
// @ts-check
/**
 * neme — publish web games to neme.world.
 *
 *   neme init [dir]       write a starter neme.json
 *   neme publish [dir]    publish the build as a new version (add --preview to hold it back)
 *   neme promote <n>      make version n the live one
 *
 * With no API token, "neme publish" still works: the game goes online for a day at a temporary
 * address, and the command prints a link that keeps it (see `access`).
 *
 * Plain JavaScript on purpose: it runs from a checkout or from npm with no build.
 */
import { createHash } from 'node:crypto'
import { createReadStream, openAsBlob, realpathSync } from 'node:fs'
import { access as canAccess, constants, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const DEFAULT_API = 'https://neme.world'
/**
 * Where the tool remembers the games this user published without an account, so that publishing
 * again goes to the same game. It is kept with the user's own settings and never in the project:
 * a project is often someone else's repository, and a file found there could point the upload
 * at their game and hand out their link.
 *
 * Usually the settings folder is nowhere near the project. Where it would be inside it (a
 * container whose home folder is the checkout), a folder of the user's own under the system's
 * temporary folder is used instead, and only if it is theirs alone. Null when there is nowhere
 * safe: then nothing is remembered, and nothing found is believed.
 * @param {string} project The project folder, resolved.
 * @returns {Promise<string | null>}
 */
async function trialsFile(project) {
  const inside = (/** @type {string} */ dir) => dir === project || dir.startsWith(project + path.sep)
  const resolved = async (/** @type {string} */ dir) => {
    // (As far as it exists: a link part-way along the path is followed, so the comparison is of real places.)
    let at = path.resolve(dir)
    const tail = []
    for (;;) {
      const real = await realpath(at).catch(() => null)
      if (real) return path.join(real, ...tail)
      const up = path.dirname(at)
      if (up === at) return path.resolve(dir)
      tail.unshift(path.basename(at))
      at = up
    }
  }
  const usual = await resolved(process.env.NEME_STATE_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'neme-world'))
  if (!inside(usual)) return path.join(usual, 'trials.json')
  let uid = -1
  try {
    uid = userInfo().uid
  } catch {
    // no user to name the folder after
  }
  const own = await resolved(path.join(tmpdir(), `neme-world-${uid === -1 ? 'user' : uid}`))
  if (inside(own)) return null
  try {
    await mkdir(own, { mode: 0o700 }).catch((err) => {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err
    })
    const info = await lstat(own)
    // Someone else's folder, a link, or one others can write to is not a place to keep an upload key.
    if (!info.isDirectory() || (uid !== -1 && info.uid !== uid) || (info.mode & 0o022) !== 0) return null
    return path.join(own, 'trials.json')
  } catch {
    return null
  }
}
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

/** @param {number} ts */
const when = (ts) => `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/**
 * @typedef {object} Trial
 * @property {string} api
 * @property {string} slug       The temporary address the platform gave the game.
 * @property {string} token      The upload key for this one game, good while it is online.
 * @property {string} claimUrl   Opening this and signing up keeps the game.
 * @property {number} expiresAt  When the game goes offline unless claimed.
 * @property {number} keepUntil  Until when it can still be claimed.
 */

/**
 * @param {unknown} t @param {string} api
 * @returns {t is Trial} A record this tool wrote for this platform: every field of the kind it writes. (The claim
 *   link is the platform's own answer, at the address the platform calls itself, which need not be the one it was reached at.)
 */
function isTrial(t, api) {
  const r = /** @type {Record<string, unknown> | null} */ (t && typeof t === 'object' ? t : null)
  return !!r && r.api === api && typeof r.token === 'string' && /^neme_[A-Za-z0-9_-]{20,}$/.test(r.token)
    && typeof r.slug === 'string' && /^tmp-[a-z0-9]{6,36}$/.test(r.slug)
    && typeof r.claimUrl === 'string' && /^https?:\/\/[^/\s]+\/claim\/[A-Za-z0-9_-]{32}$/.test(r.claimUrl)
    && typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt) && typeof r.keepUntil === 'number' && Number.isFinite(r.keepUntil)
}

/** @param {string | null} file @returns {Promise<Record<string, unknown>>} What is remembered, by platform and project folder. */
async function readTrials(file) {
  if (!file) return {}
  try {
    const all = JSON.parse(await readFile(file, 'utf8'))
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch {
    return {} // nothing remembered yet (the usual case), or not readable: then there is no such game
  }
}

/** @param {string} file @param {string} key @param {Trial} trial */
async function rememberTrial(file, key, trial) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const all = await readTrials(file)
  // (Records whose game can no longer be claimed are dropped as it goes.)
  for (const [k, v] of Object.entries(all)) {
    const until = /** @type {{ keepUntil?: unknown }} */ (v)?.keepUntil
    if (typeof until !== 'number' || until < Date.now()) delete all[k]
  }
  all[key] = trial
  // Written beside and moved into place: readable by its owner only, and never through a link someone put there.
  const fresh = `${file}.${process.pid}.tmp`
  await writeFile(fresh, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(fresh, file)
}

/**
 * Who a command acts as: the developer, by their API token, or (with none) the game this folder
 * published without an account. `start` allows beginning such a game when there is neither.
 * @param {{ dir: string, api: string, token?: string, start?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<{ token: string, slug?: string, trial: Trial | null }>}
 */
export async function access({ dir, api, token, start = false, log = console.log }) {
  if (token) return { token, trial: null }
  const project = await realpath(dir).catch(() => path.resolve(dir))
  const key = `${api} ${project}`
  const file = await trialsFile(project)
  const saved = (await readTrials(file))[key]
  if (isTrial(saved, api)) {
    if (saved.expiresAt > Date.now()) {
      log(`No API token: carrying on with the game this folder published without an account (${saved.slug}).`)
      return { token: saved.token, slug: saved.slug, trial: saved }
    }
    throw new CliError(
      `The game this folder published without an account went offline on ${when(saved.expiresAt)}. `
      + `To keep it, open ${saved.claimUrl} (until ${when(saved.keepUntil)}), then set NEME_TOKEN to publish with your account. `
      + `To start again without an account, run "neme forget" here.`,
    )
  }
  const noToken = `No API token. Set NEME_TOKEN or pass --token. Create one at ${api}/dashboard`
  if (!start) throw new CliError(noToken)
  const manifest = await readManifest(dir)
  // Checked before a game is started: one that could not be remembered would be started again on
  // every publish, and only so many can be started in a day.
  let writable = false
  if (file) {
    writable = await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).then(() => canAccess(path.dirname(file), constants.W_OK)).then(() => true, () => false)
  }
  if (!writable) {
    throw new CliError(`Publishing without an account needs somewhere to remember the game, and ${file ? path.dirname(file) : 'a folder of your own outside the project'} cannot be written. Set NEME_STATE_DIR to a folder outside the project, or sign up: ${noToken}`)
  }
  let res
  try {
    res = await fetch(`${api}/api/v1/trials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: manifest.slug }) })
  } catch (err) {
    throw new CliError(`Could not reach ${api}: ${/** @type {Error} */ (err).cause ?? /** @type {Error} */ (err).message}`)
  }
  const data = /** @type {any} */ (await res.json().catch(() => ({})))
  // (A platform that does not offer this answers as it always has: a token is needed.)
  if (res.status === 404 || res.status === 405) throw new CliError(noToken)
  /** @type {Trial} */
  const trial = { api, slug: data.slug, token: data.token, claimUrl: data.claimUrl, expiresAt: data.expiresAt, keepUntil: data.keepUntil }
  if (!res.ok || !isTrial(trial, api)) throw new CliError(`${data.error ?? `Could not publish without an account (${res.status}).`} ${noToken}`)
  log('No API token, so this is published without an account: online for a day, yours to keep with the link below.')
  try {
    await rememberTrial(/** @type {string} */ (file), key, trial)
  } catch (err) {
    // The game exists and its link must not be lost with it: said now, in case nothing later is.
    log(`  (Could not remember this game for next time: ${/** @type {Error} */ (err).message}. Keep this link, it is the only way to keep the game: ${trial.claimUrl})`)
  }
  return { token: trial.token, slug: trial.slug, trial }
}

/**
 * Forgets the game this folder published without an account, so that the next publish starts another.
 * The game itself is not touched: it stays online for its day and can still be claimed with its link.
 * @param {{ dir: string, api: string, log?: (line: string) => void }} o
 */
export async function forget({ dir, api, log = console.log }) {
  const project = await realpath(dir).catch(() => path.resolve(dir))
  const key = `${api} ${project}`
  const file = await trialsFile(project)
  const all = await readTrials(file)
  const saved = all[key]
  if (!file || !isTrial(saved, api)) return void log('Nothing to forget: this folder has no game published without an account.')
  delete all[key]
  const fresh = `${file}.${process.pid}.tmp`
  await writeFile(fresh, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(fresh, file)
  log(`Forgotten. The game is untouched: it can still be claimed at ${saved.claimUrl} until ${when(saved.keepUntil)}.`)
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
 * With `trial` (a game published without an account), it goes to the address the platform gave it,
 * and the result says how to keep it.
 * @param {{ dir: string, api: string, token: string, preview?: boolean, trial?: Trial | null, log?: (line: string) => void }} o
 * @returns {Promise<{ version: number, url: string, live: boolean, warnings: string[], uploaded: number, claimUrl?: string }>}
 */
export async function publish({ dir, api, token, preview: held = false, trial = null, log = console.log }) {
  // A game without an account has no held-back versions: what is online for it is what its page shows.
  const preview = held && !trial
  if (held && trial) log('  (a game published without an account has no private previews: this goes online at its temporary address)')
  const manifest = await readManifest(dir)
  const buildDir = path.resolve(dir, manifest.dir ?? '.')
  const entry = manifest.entry ?? 'index.html'

  const info = await stat(buildDir).catch(() => null)
  if (!info?.isDirectory()) throw new CliError(`Build folder ${buildDir} does not exist. Did you run your build?`)
  // What is published is the project's own build and nothing beside it. A neme.json is often
  // someone else's (a repository that was cloned), and one saying "dir": ".." would otherwise
  // put whatever sits next to the project online.
  const [projectReal, buildReal] = await Promise.all([realpath(dir), realpath(buildDir)])
  if (buildReal !== projectReal && !buildReal.startsWith(projectReal + path.sep)) {
    throw new CliError(`"dir" in neme.json points outside this folder (${buildReal}). Put neme.json in the folder that contains your build.`)
  }
  const files = await collectFiles(buildDir)
  if (!files.some((f) => f.path === entry)) throw new CliError(`${buildDir} has no ${entry}. Set "dir" in neme.json to your build output folder.`)
  if (manifest.cover && !files.some((f) => f.path === manifest.cover)) throw new CliError(`Cover "${manifest.cover}" was not found in ${buildDir}.`)

  const total = files.reduce((n, f) => n + f.size, 0)
  log(`${manifest.title}: ${files.length} file${files.length === 1 ? '' : 's'}, ${size(total)}`)

  const { slug: ownSlug, dir: _dir, entry: _entry, ...details } = manifest
  const slug = trial?.slug ?? ownSlug
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
  if (trial) {
    log(`  Published without an account: online until ${when(trial.expiresAt)}, in no list, at a temporary address.`)
    log(`  To keep it, open this link and sign up (you choose its address then; neme.json asks for "${ownSlug}"):`)
    log(`  ${trial.claimUrl}`)
  }
  return {
    version: out.version, url: out.live ? out.game.url : out.previewUrl, live: out.live, warnings: out.warnings ?? [], uploaded: missing.length,
    ...(trial ? { claimUrl: trial.claimUrl } : {}),
  }
}

/**
 * Makes an already-uploaded version the live one. Works for a preview, and for going back to an earlier version.
 * @param {{ dir: string, api: string, token: string, version: number, slug?: string, log?: (line: string) => void }} o
 */
export async function promote({ dir, api, token, version, slug: as, log = console.log }) {
  const { slug: own, title } = await readManifest(dir)
  const slug = as ?? own
  const out = await call(api, token, 'POST', `/games/${slug}/activate`, { json: { version } })
  log(`${title}: v${version} is live`)
  log(`  ${out.game.url}`)
  // Promoting moves players to a version; it deliberately leaves the title, cover and other details alone.
  log('  (details in neme.json were not changed; "neme publish" applies them)')
  return { url: out.game.url }
}

/**
 * Lists a game's versions, newest first, saying which one players are on.
 * @param {{ dir: string, api: string, token: string, slug?: string, log?: (line: string) => void }} o
 */
export async function versions({ dir, api, token, slug: as, log = console.log }) {
  const { slug: own, title } = await readManifest(dir)
  const slug = as ?? own
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
 * @param {{ dir: string, api: string, token: string, version: number, slug?: string, log?: (line: string) => void }} o
 */
export async function remove({ dir, api, token, version, slug: as, log = console.log }) {
  const { slug: own, title } = await readManifest(dir)
  const slug = as ?? own
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
    description: 'Publish the game described by dir/neme.json to neme.world. With preview true, upload without going live and get a private link to try the build; publish for real only when the developer says so. Works with no NEME_TOKEN too: the game then goes online for a day at a temporary address, and the result ends with a claim link. Give the developer that link: opening it and signing up keeps the game.',
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
  if (!TOOLS.some((t) => t.name === name)) throw new CliError(`No such tool: ${name}`)
  // With no token, publishing begins (or carries on) a game without an account; the other tools work on that game.
  const who = await access({ dir, api: env.api, token: env.token, start: name === 'neme_publish', log })
  const { token, slug } = who
  if (name === 'neme_publish') await publish({ dir, api: env.api, token, preview: args.preview === true, trial: who.trial, log })
  else if (name === 'neme_promote') {
    if (!Number.isInteger(args.version) || /** @type {number} */ (args.version) < 1) throw new CliError('version must be a whole number, 1 or more.')
    await promote({ dir, api: env.api, token, slug, version: /** @type {number} */ (args.version), log })
  } else if (name === 'neme_versions') await versions({ dir, api: env.api, token, slug, log })
  else if (name === 'neme_delete_version') {
    if (!Number.isInteger(args.version) || /** @type {number} */ (args.version) < 1) throw new CliError('version must be a whole number, 1 or more.')
    await remove({ dir, api: env.api, token, slug, version: /** @type {number} */ (args.version), log })
  } else if (name === 'neme_metrics') {
    const own = (await readManifest(dir)).slug
    const out = await call(env.api, token, 'GET', `/games/${slug ?? own}/metrics`)
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
      instructions: 'Publishes web games to neme.world. Call neme_guide first. Publish with preview true and show the developer the link; make a version live only when they say so. If no NEME_TOKEN is set, neme_publish still works: the game is online for a day at a temporary, unlisted address, so publish it live and give the developer both links it returns, the game and the claim link that keeps it.',
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
  neme forget [dir]       Forget the game this folder published without an account
  neme mcp                Run as an MCP server, so a coding agent can do the above

No account yet? "neme publish" works without a token: the game is online for a day at a
temporary address, and the command prints a link that keeps it once you sign up.

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
  if (command === 'forget') return forget({ dir, api: (values.api ?? process.env.NEME_API ?? DEFAULT_API).replace(/\/+$/, '') })
  if (command === 'mcp') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    return serveMcp({
      api: (values.api ?? process.env.NEME_API ?? DEFAULT_API).replace(/\/+$/, ''), token: values.token ?? process.env.NEME_TOKEN, version: pkg.version,
    })
  }
  if (command === 'publish' || command === 'promote' || command === 'versions' || command === 'delete') {
    const api = (values.api ?? process.env.NEME_API ?? DEFAULT_API).replace(/\/+$/, '')
    // (promote and delete take the version first: "neme promote 7 [dir]".)
    const folder = command === 'publish' || command === 'versions' ? dir : positionals[2] ?? '.'
    const who = await access({ dir: folder, api, token: values.token ?? process.env.NEME_TOKEN, start: command === 'publish' })
    const { token, slug } = who
    if (command === 'publish') {
      await publish({ dir, api, token, preview: values.preview, trial: who.trial })
      return
    }
    if (command === 'versions') {
      await versions({ dir, api, token, slug })
      return
    }
    // promote <version> [dir], delete <version> [dir]
    const version = Number(positionals[1])
    if (!Number.isInteger(version) || version < 1) {
      throw new CliError(command === 'delete' ? 'Say which version to delete, for example: neme delete 3' : 'Say which version to make live, for example: neme promote 7')
    }
    if (command === 'delete') await remove({ dir: folder, api, token, slug, version })
    else await promote({ dir: folder, api, token, slug, version })
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
