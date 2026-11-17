// Starts the MCP server given on the command line, asks what it is and what tools it has, and checks the answer.
//   node .github/smoke.mjs node src/cli.js mcp
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [command, ...args] = process.argv.slice(2)
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, NEME_TOKEN: '' } })
const expected = ['neme_guide', 'neme_init', 'neme_publish', 'neme_promote', 'neme_versions', 'neme_delete_version', 'neme_metrics']
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

let buffer = ''
const answers = new Map()
const timer = setTimeout(() => fail('no answer within 20 seconds'), 20_000)
function fail(why) {
  console.error(`smoke test failed: ${why}`)
  child.kill()
  process.exit(1)
}
child.on('error', (err) => fail(err.message))
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    answers.set(msg.id, msg.result)
    if (answers.has(1) && answers.has(2)) check()
  }
})
function check() {
  clearTimeout(timer)
  const info = answers.get(1).serverInfo
  const tools = answers.get(2).tools.map((t) => t.name)
  if (info.name !== 'neme-world') fail(`server calls itself ${info.name}`)
  if (info.version !== version) fail(`server says version ${info.version}, package.json says ${version}`)
  for (const name of expected) if (!tools.includes(name)) fail(`tool ${name} is missing`)
  console.log(`ok: ${info.name} ${info.version}, ${tools.length} tools`)
  child.kill()
  process.exit(0)
}
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })}\n`)
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
