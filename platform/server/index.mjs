/**
 * Orchestrator API for the pentest workspace.
 *
 * This is the glue that was missing: it loads server credentials, drives one or more
 * Daytona sandboxes in parallel, the ZAP scans, the Anchor browser verifier, SurrealDB
 * memory, Arize traces, and the Bedrock fix assistant, then serves them to the React app
 * over HTTP + SSE.
 *
 * A "run" is one target in one sandbox (app + ZAP colocated). POST /api/runs fans out to
 * N sandboxes; /api/run/* still drives a single "primary" run for the simple flow.
 *
 * Run with:  node server/index.mjs   (or: npm run server)
 */
import { createServer } from 'node:http'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadConfig, redact } from './config.mjs'
import { createDaytonaAdapter } from './daytona.mjs'
import { createSponsors } from './sponsors.mjs'
import { createAws } from './aws.mjs'
import { listTargets, createRepoTarget, defaultRepoPath } from './targets.mjs'

const config = loadConfig()
config.allowedTargetOrigins = []
const port = Number(process.env.API_PORT || 8787)

const sponsors = createSponsors(config)
const aws = createAws(config)

const runs = new Map()
const proofShots = new Map() // `${runId}:${kind}` -> PNG Buffer captured from the live Anchor session (cache)
const PROOF_DIR = join(tmpdir(), 'pentest-proofs')
let primaryId = null
let runSeq = 0

const logBuffer = []
const sseClients = new Set()

function recordLog(entry) {
  const line = { ...entry, time: entry.time || new Date().toISOString() }
  logBuffer.push(line)
  if (logBuffer.length > 800) logBuffer.shift()
  const payload = `data: ${JSON.stringify(line)}\n\n`
  for (const client of sseClients) client.write(payload)
}

const STAGE_KEYS = ['daytona', 'zap', 'anchor', 'bedrock', 'surrealdb', 'arize']
const freshStages = () => Object.fromEntries(STAGE_KEYS.map(key => [key, 'pending']))

function emptyState() {
  return {
    runId: null, label: null, status: 'idle', targetApp: null, target: null, scanner: null,
    findings: [], report: null, verification: null, memory: null, trace: null, proposal: null,
    stages: freshStages(), timings: {}, proofs: {}, error: null, startedAt: null, updatedAt: new Date().toISOString(),
  }
}

function createRun({ label, targetApp, spec = null }) {
  const id = `run-${Date.now().toString(36)}-${runSeq++}`
  const run = {
    id,
    label: label || targetApp,
    targetApp,
    spec,
    adapter: null,
    state: { ...emptyState(), runId: id, label: label || targetApp, targetApp },
  }
  runs.set(id, run)
  return run
}

function createRunFromEntry(entry = {}) {
  if (entry.path) {
    const spec = createRepoTarget({ path: entry.path, label: entry.label, id: entry.id })
    return createRun({ label: entry.label || spec.label, targetApp: spec.id, spec })
  }
  const targetApp = entry.targetApp || entry.id || process.env.TARGET_APP || 'juice-shop'
  return createRun({ label: entry.label || targetApp, targetApp })
}

const touch = (run, patch = {}) => Object.assign(run.state, patch, { updatedAt: new Date().toISOString() })
// Record real start/end wall-clock windows per stage so Arize spans carry actual durations.
// A stage can run more than once (e.g. anchor: verify, then retest), so each key holds a list.
function setStage(run, key, value) {
  const now = new Date().toISOString()
  const timings = { ...(run.state.timings || {}) }
  const windows = [...(timings[key] || [])]
  if (value === 'active') {
    windows.push({ startedAt: now, endedAt: null })
  } else {
    const open = windows.find(window => !window.endedAt)
    if (open) open.endedAt = now
    else if (!windows.length) windows.push({ startedAt: now, endedAt: now })
    else windows[windows.length - 1] = { ...windows[windows.length - 1], endedAt: windows[windows.length - 1].endedAt || now }
  }
  timings[key] = windows
  touch(run, { stages: { ...run.state.stages, [key]: value }, timings })
}
const describeRun = run => (run ? { ...run.state } : emptyState())
const primaryRun = () => runs.get(primaryId) || null

// Keep captured proof frames out of the JSON payloads; the UI loads them from /api/proof/...
// Frames are written to disk as well as cached so they survive cleanup and server restarts.
async function storeProof(run, kind, base64) {
  if (!base64) return null
  const buffer = Buffer.from(base64, 'base64')
  proofShots.set(`${run.id}:${kind}`, buffer)
  await mkdir(PROOF_DIR, { recursive: true }).catch(() => {})
  await writeFile(join(PROOF_DIR, `${run.id}-${kind}.png`), buffer).catch(() => {})
  const url = `/api/proof/${run.id}/${kind}`
  touch(run, { proofs: { ...(run.state.proofs || {}), [kind]: url } })
  return url
}

function requirePrimary() {
  const run = primaryRun()
  if (!run) throw Object.assign(new Error('Provision a target first'), { status: 409 })
  return run
}

/** Map raw ZAP alerts to the Finding shape the UI already renders. */
const RISK = { High: 'High', Medium: 'Medium', Low: 'Low', Informational: 'Low' }
function toFindings(alerts = []) {
  return alerts.map((alert, index) => {
    const endpoint = `${alert.method || 'GET'} ${(() => { try { const url = new URL(alert.url); return url.pathname + url.search } catch { return alert.url } })()}`
    return {
      id: `zap-${alert.pluginId}-${index}`,
      pluginId: String(alert.pluginId),
      title: alert.alert || alert.name || `Alert ${alert.pluginId}`,
      endpoint,
      severity: RISK[alert.risk] || 'Low',
      status: 'Needs verification',
      confidence: alert.confidence || 'Medium',
      description: String(alert.description || '').replace(/<[^>]+>/g, '').slice(0, 600),
      impact: String(alert.solution || '').replace(/<[^>]+>/g, '').slice(0, 600),
      evidence: alert.evidence || '',
      request: alert.message?.requestHeader || `${alert.method || 'GET'} ${alert.url} HTTP/1.1`,
      response: (alert.message?.responseHeader || '') + '\n\n' + (alert.message?.responseBody || alert.evidence || ''),
      cwe: alert.cweid ? `CWE-${alert.cweid}` : null,
      trace: [
        { id: `${alert.pluginId}-1`, title: 'Scanner flagged endpoint', time: new Date().toISOString(), tool: 'OWASP ZAP · active scan', result: `Rule ${alert.pluginId} · ${alert.confidence || 'Medium'} confidence`, state: 'complete' },
        { id: `${alert.pluginId}-2`, title: 'Awaiting independent verification', time: new Date().toISOString(), tool: 'Anchor Browser · verifier', result: 'Not yet replayed in a clean browser session.', state: 'pending' },
      ],
    }
  })
}

// --- Run steps ------------------------------------------------------------

async function provisionRun(run) {
  const adapter = run.adapter || (run.adapter = createDaytonaAdapter({
    onLog: entry => recordLog({ runId: run.id, runLabel: run.label, ...entry }),
    targetApp: run.targetApp,
    spec: run.spec,
  }))
  touch(run, { status: 'provisioning', startedAt: new Date().toISOString(), error: null })
  setStage(run, 'daytona', 'active')
  try {
    const described = await adapter.provision({ runId: run.id })
    const scope = adapter.getScope()
    const origin = new URL(adapter.getTarget().url).origin
    if (!config.allowedTargetOrigins.includes(origin)) config.allowedTargetOrigins.push(origin)
    touch(run, { status: 'provisioned', target: described.target, scanner: described.scanner, scope, sandboxes: described.sandboxes })
    setStage(run, 'daytona', 'done')
    return { ...described, scope, runId: run.id }
  } catch (error) {
    setStage(run, 'daytona', 'error')
    touch(run, { status: 'error', error: error.message })
    throw error
  }
}

async function scanRun(run) {
  const adapter = run.adapter
  if (!adapter) throw Object.assign(new Error('Provision a target first'), { status: 409 })
  touch(run, { status: 'scanning', error: null })
  setStage(run, 'zap', 'active')
  try {
    const result = await adapter.scan()
    const findings = toFindings(result.alerts)
    touch(run, {
      status: 'scanned', findings, target: adapter.getState().target,
      report: { scanner: result.report.scanner, version: result.report.version, ruleIds: result.report.ruleIds, alertCount: findings.length, authenticated: result.report.authenticated },
    })
    setStage(run, 'zap', 'done')
    return { findings, report: run.state.report, proof: result.proof, login: result.login }
  } catch (error) {
    setStage(run, 'zap', 'error')
    touch(run, { status: 'error', error: error.message })
    throw error
  }
}

async function verifyRun(run, body = {}) {
  const adapter = run.adapter
  if (!adapter) throw Object.assign(new Error('Provision a target first'), { status: 409 })
  const scope = adapter.getScope()
  const proof = body.proof || scope.proof
  if (!proof) throw Object.assign(new Error('This target has no browser proof payload'), { status: 409 })
  const payload = body.payload || proof.payload
  touch(run, { status: 'verifying', error: null })
  setStage(run, 'anchor', 'active')
  try {
    const raw = await sponsors.verifyXss(adapter.getTarget().url, payload, { parameter: proof.parameter, expectedDialog: proof.expectedDialog, path: proof.path, login: scope.login })
    const { screenshotBase64, ...verification } = raw
    const proofUrl = await storeProof(run, 'verify', screenshotBase64)
    verification.proof = proofUrl
    const findings = run.state.findings.map(finding => finding.pluginId === '40012' && verification.confirmed
      ? { ...finding, status: 'Confirmed', trace: finding.trace.map(step => step.id.endsWith('-2') ? { ...step, title: 'Browser confirmed the proof', result: `Observed alert "${verification.evidence?.expectedDialog}" in a clean Anchor session.`, state: 'complete', evidence: proofUrl || verification.viewerUrl || 'browser session' } : step) }
      : finding)
    touch(run, { verification, findings, target: adapter.getTarget() })
    setStage(run, 'anchor', verification.confirmed ? 'done' : 'error')
    return { verification, findings }
  } catch (error) {
    setStage(run, 'anchor', 'error')
    touch(run, { status: 'error', error: error.message })
    throw error
  }
}

async function retestRun(run) {
  const adapter = run.adapter
  if (!adapter) throw Object.assign(new Error('Provision a target first'), { status: 409 })
  const scope = adapter.getScope()
  if (!scope.proof) throw Object.assign(new Error('This target has no browser proof payload'), { status: 409 })
  setStage(run, 'anchor', 'active')
  const raw = await sponsors.retestXss(adapter.getTarget().url, scope.proof.payload, { parameter: scope.proof.parameter, expectedDialog: scope.proof.expectedDialog, path: scope.proof.path, login: scope.login })
  const { screenshotBase64, ...result } = raw
  result.proof = await storeProof(run, 'retest', screenshotBase64)
  touch(run, { retest: result, status: 'retested' })
  setStage(run, 'anchor', result?.blocked ? 'done' : 'active')
  return { verification: result }
}

async function applyFixRun(run) {
  const adapter = run.adapter
  if (!adapter) throw Object.assign(new Error('Provision a target first'), { status: 409 })
  const result = await adapter.applyFix()
  touch(run, { status: 'patched', target: adapter.getState().target })
  return result
}

async function proposeRun(run, body = {}) {
  const adapter = run.adapter
  const finding = run.state.findings.find(item => item.id === body.findingId) || run.state.findings[0] || null
  if (!finding) throw Object.assign(new Error('Run a scan before requesting a fix'), { status: 409 })
  setStage(run, 'bedrock', 'active')
  const evidence = { finding: { title: finding.title, endpoint: finding.endpoint, severity: finding.severity, description: finding.description }, request: finding.request, response: finding.response, verification: run.state.verification, report: run.state.report }
  const source = adapter ? adapter.getScope() : null
  const proposal = await aws.proposeFix(evidence, body.source ?? source)
  touch(run, { proposal: { findingId: finding.id, ...proposal } })
  setStage(run, 'bedrock', proposal?.ok === false ? 'error' : 'done')
  return { proposal: run.state.proposal }
}

async function memoryRun(run, body = {}) {
  const finding = run.state.findings.find(item => item.id === body.findingId)
    || run.state.findings.find(item => item.status === 'Confirmed')
    || run.state.findings[0] || null
  const identity = {
    appVersion: body.appVersion || run.state.target?.version || 'unknown',
    scope: run.state.target?.scope || 'owned-target',
    account: body.account || 'demo-user',
    testConfig: body.testConfig || 'scan-default-v1',
    testId: body.testId || (finding ? `${finding.pluginId}-01` : 'scan-01'),
  }
  const record = { identity, valid: body.valid !== false, finding: finding ? { id: finding.id, title: finding.title, endpoint: finding.endpoint, severity: finding.severity, status: finding.status } : null, verification: run.state.verification, recordedAt: new Date().toISOString() }
  setStage(run, 'surrealdb', 'active')
  const memory = await sponsors.recordMemory(record)
  touch(run, { memory })
  setStage(run, 'surrealdb', memory?.ok === false ? 'error' : 'done')
  return { memory }
}

async function traceRun(run, body = {}) {
  setStage(run, 'arize', 'active')
  const spans = body.spans || buildSpans(run)
  const trace = await sponsors.traceRun(spans)
  // Keep the exact spans we sent so the UI can render the real trace, not a synthesized summary.
  touch(run, { trace: { ...trace, spans: summarizeSpans(spans) } })
  setStage(run, 'arize', trace?.ok === false ? 'error' : 'done')
  return { trace: run.state.trace }
}

async function cleanupRun(run) {
  const result = run.adapter ? await run.adapter.cleanup() : { deleted: 0 }
  run.adapter = null
  touch(run, { status: 'cleaned', target: null, scanner: null, sandboxes: [] })
  return result
}

const STEPS = {
  provision: run => provisionRun(run),
  scan: run => scanRun(run),
  verify: (run, body) => verifyRun(run, body),
  retest: run => retestRun(run),
  'apply-fix': run => applyFixRun(run),
  propose: (run, body) => proposeRun(run, body),
  memory: (run, body) => memoryRun(run, body),
  trace: (run, body) => traceRun(run, body),
  cleanup: run => cleanupRun(run),
}

/** Summarize the exact spans sent to Arize so the UI can render the real trace. */
function summarizeSpans(spans = []) {
  return spans.map(span => ({
    name: span.name,
    kind: span.kind || 'TOOL',
    startTime: span.startTime ?? span.startedAt ?? null,
    endTime: span.endTime ?? span.endedAt ?? null,
    attributes: span.attributes || {},
    ok: span.ok !== false && !span.error,
  }))
}

const STAGE_SPANS = [
  ['daytona', 'daytona.provision', 'TOOL'],
  ['zap', 'zap.active-scan', 'TOOL'],
  ['anchor', 'anchor.verify-xss', 'TOOL'],
  ['bedrock', 'bedrock.propose-fix', 'LLM'],
  ['surrealdb', 'surrealdb.remember', 'TOOL'],
  ['arize', 'arize.trace-run', 'TOOL'],
]
// A repeated stage emits a second span with its real name (the anchor stage verifies, then re-tests).
const REPEAT_NAMES = { anchor: ['anchor.verify-xss', 'anchor.retest-xss'] }

/** Build Arize spans from the real per-stage timings captured while the run executed. */
function buildSpans(run) {
  const timings = run.state.timings || {}
  const now = new Date().toISOString()
  const start = run.state.startedAt || now
  const spans = [{
    name: 'run.orchestrate',
    kind: 'CHAIN',
    startTime: start,
    endTime: now,
    attributes: { 'run.id': run.id, 'target.app': run.targetApp, findings: run.state.findings.length, 'target.version': run.state.target?.version || 'unknown' },
  }]
  for (const [key, baseName, kind] of STAGE_SPANS) {
    const windows = timings[key] || []
    windows.forEach((window, index) => {
      if (!window?.startedAt) return
      const repeat = REPEAT_NAMES[key]
      const name = index === 0 ? baseName : (repeat?.[index] || `${baseName} #${index + 1}`)
      spans.push({
        name,
        kind,
        startTime: window.startedAt,
        endTime: window.endedAt || now,
        attributes: { 'stage': key, 'target.app': run.targetApp, 'run.id': run.id },
      })
    })
  }
  return spans
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// --- Route handlers -------------------------------------------------------

async function handleCreateRuns(body = {}) {
  const entries = Array.isArray(body.entries) && body.entries.length ? body.entries : [{ targetApp: body.targetApp || process.env.TARGET_APP || 'juice-shop' }]
  const created = entries.slice(0, 6).map(createRunFromEntry)
  if (created.length) primaryId = created[0].id
  recordLog({ role: 'system', tone: 'blue', text: `Provisioning ${created.length} sandbox(es) in parallel…` })
  await Promise.allSettled(created.map(run => provisionRun(run)))
  return { runs: created.map(describeRun) }
}

async function handleListDirs(body, req) {
  const requested = new URL(req.url, 'http://localhost').searchParams.get('path') || defaultRepoPath() || homedir()
  const target = resolve(requested)
  let dirs = []
  try {
    const entries = await readdir(target, { withFileTypes: true })
    dirs = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, path: join(target, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw Object.assign(new Error(`Cannot read ${target}: ${error.code || error.message}`), { status: 400 })
  }
  return { path: target, parent: dirname(target), dirs: dirs.slice(0, 400), demoRepoPath: defaultRepoPath() }
}

const routes = {
  'GET /api/health': async () => ({
    ok: true,
    service: 'pentest-orchestrator',
    targetApp: primaryRun()?.targetApp ?? null,
    runs: runs.size,
    configured: {
      daytona: Boolean(config.DAYTONA_API_KEY),
      anchor: Boolean(config.ANCHOR_API_KEY),
      arize: Boolean(config.ARIZE_API_KEY && config.ARIZE_SPACE_ID),
      surrealdb: Boolean(config.SURREAL_MEMORY_API_KEY && config.SURREAL_MEMORY_HOST && config.SURREAL_MEMORY_CONTEXT_ID),
      bedrock: Boolean(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY),
    },
  }),

  'GET /api/targets': async () => ({ targets: listTargets(), default: process.env.TARGET_APP || 'juice-shop', demoRepoPath: defaultRepoPath() }),

  'GET /api/fs/dirs': handleListDirs,

  'GET /api/integrations': async () => {
    const [sponsorStatus, awsStatus] = await Promise.all([
      sponsors.probe(),
      aws.probe().catch(error => ({ aws: { ok: false, error: redact(error.message, config) } })),
    ])
    return { daytona: { ok: Boolean(config.DAYTONA_API_KEY), region: config.DAYTONA_TARGET || 'default' }, ...sponsorStatus, aws: awsStatus.aws, bedrock: awsStatus.bedrock }
  },

  'GET /api/run/state': async () => describeRun(primaryRun()),
  'GET /api/run/logs': async () => ({ logs: logBuffer, state: describeRun(primaryRun()) }),

  'GET /api/runs': async () => ({ runs: [...runs.values()].map(describeRun) }),
  'POST /api/runs': handleCreateRuns,
  'POST /api/runs/cleanup': async () => {
    const settled = await Promise.allSettled([...runs.values()].map(run => cleanupRun(run)))
    const deleted = settled.reduce((sum, item) => sum + (item.status === 'fulfilled' ? (item.value?.deleted || 0) : 0), 0)
    return { deleted }
  },

  'POST /api/run/provision': async body => {
    const run = createRunFromEntry(body.path ? { path: body.path, label: body.label } : { targetApp: body.targetApp })
    primaryId = run.id
    return provisionRun(run)
  },
  'POST /api/run/scan': async () => scanRun(requirePrimary()),
  'POST /api/run/verify': async body => verifyRun(requirePrimary(), body),
  'POST /api/run/retest': async () => retestRun(requirePrimary()),
  'POST /api/run/apply-fix': async () => applyFixRun(requirePrimary()),
  'POST /api/run/propose': async body => proposeRun(requirePrimary(), body),
  'POST /api/run/memory': async body => memoryRun(requirePrimary(), body),
  'POST /api/run/trace': async body => traceRun(requirePrimary(), body),
  'POST /api/run/cleanup': async () => { const run = primaryRun(); return run ? cleanupRun(run) : { deleted: 0 } },

  'GET /api/run/events': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    res.write(`data: ${JSON.stringify({ text: 'log stream connected', role: 'system', tone: 'muted', time: new Date().toISOString() })}\n\n`)
    sseClients.add(res)
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000)
    req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res) })
    return undefined
  },
}

async function runStepRoute(body = {}, req, res, params = {}) {
  const run = runs.get(params.id)
  if (!run) throw Object.assign(new Error(`Unknown run ${params.id}`), { status: 404 })
  const step = STEPS[params.step]
  if (!step) throw Object.assign(new Error(`Unknown step ${params.step}`), { status: 404 })
  return step(run, body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const key = `${req.method} ${url.pathname}`

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
    return res.end()
  }

  // Captured proof frames (PNG) from the live Anchor session.
  if (req.method === 'GET') {
    const proof = url.pathname.match(/^\/api\/proof\/([^/]+)\/([a-z-]+)$/)
    if (proof) {
      const buffer = proofShots.get(`${proof[1]}:${proof[2]}`)
        || await readFile(join(PROOF_DIR, `${proof[1]}-${proof[2]}.png`)).catch(() => null)
      if (!buffer) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify({ error: 'No proof captured for that run' }))
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Content-Length': buffer.length })
      return res.end(buffer)
    }
  }

  let handler = routes[key]
  let params = {}
  if (!handler && req.method === 'POST') {
    const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/([a-z-]+)$/)
    if (match) { handler = runStepRoute; params = { id: match[1], step: match[2] } }
  }

  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    return res.end(JSON.stringify({ error: `No route for ${key}` }))
  }

  try {
    if (key === 'GET /api/run/events') return handler(req, res)
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {}
    const result = await handler(body, req, res, params)
    const payload = JSON.stringify(result)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(payload) })
    res.end(payload)
  } catch (error) {
    const status = error.status || 500
    const message = redact(error.message, config)
    recordLog({ role: 'system', tone: 'yellow', text: `Request failed: ${message}` })
    const run = primaryRun()
    if (run) touch(run, { error: message, status: 'error' })
    const payload = JSON.stringify({ error: message, status })
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(payload) })
    res.end(payload)
  }
})

server.listen(port, () => {
  console.log(`Pentest orchestrator listening on http://127.0.0.1:${port}`)
  console.log(`Target default: ${process.env.TARGET_APP || 'juice-shop'} · credentials for: ${Object.entries({ daytona: config.DAYTONA_API_KEY, anchor: config.ANCHOR_API_KEY, arize: config.ARIZE_API_KEY, surrealdb: config.SURREAL_MEMORY_API_KEY, bedrock: config.AWS_ACCESS_KEY_ID }).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`)
})
