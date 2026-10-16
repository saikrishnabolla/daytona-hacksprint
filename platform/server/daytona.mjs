import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daytona } from '@daytonaio/sdk'
import { resolveTarget } from './targets.mjs'

const run = promisify(execFile)
const scannerSource = new URL('./fixture/scan.py', import.meta.url)
const ZAP_IMAGE = process.env.ZAP_IMAGE || 'ghcr.io/zaproxy/zaproxy:stable'
const ZAP_START = 'nohup /zap/zap.sh -daemon -host 127.0.0.1 -port 8080 -config api.disablekey=true -config api.addrs.addr.name=127.0.0.1 -config api.addrs.addr.regex=false -config connection.timeoutInSecs=10 -config ascan.maxScanDurationInMins=4 > /tmp/zap.log 2>&1 &'

/** Pack a local checkout into a gzip tarball for offline upload into a sandbox. */
async function packDirectory(dir) {
  const archive = join(tmpdir(), `owned-repo-${Date.now()}.tgz`)
  await run('tar', ['-czf', archive, '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'dist', '-C', dir, '.'])
  const buffer = await readFile(archive)
  await rm(archive, { force: true })
  return buffer
}

export function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }

export function applySourceFix(source, patch) {
  if (!patch) throw new Error('This target has no source patch')
  if (!source.includes(patch.before)) throw new Error('Current source does not contain the vulnerable line')
  if (patch.vulnerableVersion && !source.includes(patch.vulnerableVersion)) throw new Error('Source does not match the expected vulnerable version')
  let next = source.replace(patch.before, patch.after)
  if (patch.vulnerableVersion && patch.fixedVersion) next = next.replace(patch.vulnerableVersion, patch.fixedVersion)
  return next
}

export function createDaytonaAdapter({ onLog = () => {}, apiKey = process.env.DAYTONA_API_KEY, apiUrl = process.env.DAYTONA_API_URL, target: region = process.env.DAYTONA_TARGET, client, targetApp, spec: suppliedSpec } = {}) {
  const spec = suppliedSpec || resolveTarget(targetApp)
  let daytona = client
  let worker, targetUrl, runId
  let version = spec.patch?.vulnerableVersion || ''
  const logs = { target: [], scanner: [] }

  function log(role, message, tone = 'muted') {
    const entry = { text: String(message), tone, time: new Date().toISOString() }
    logs[role].push(entry)
    if (logs[role].length > 120) logs[role].shift()
    onLog({ role, ...entry })
  }

  function getClient() {
    if (!daytona) {
      if (!apiKey) throw new Error('DAYTONA_API_KEY is required')
      daytona = new Daytona({ apiKey, ...(apiUrl ? { apiUrl } : {}), ...(region ? { target: region } : {}) })
    }
    return daytona
  }

  async function execute(role, command, timeout = 60) {
    const result = await worker.process.executeCommand(command, undefined, undefined, timeout)
    if (result.result) for (const line of result.result.trim().split('\n').slice(-30)) log(role, line)
    if (result.exitCode !== 0) throw new Error(`${role} command failed (exit ${result.exitCode}): ${(result.result || '').slice(-800)}`)
    return result.result || ''
  }

  function healthCommand() {
    const url = `http://127.0.0.1:${spec.port}${spec.health.path}`
    const js = `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(2);return r.text()}).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))`
    return `node -e ${shellQuote(js)}`
  }

  async function startApp() {
    await execute('target', `bash -c ${shellQuote(spec.start)}`, 120)
    for (let attempt = 0; attempt < 60; attempt++) {
      const health = await worker.process.executeCommand(healthCommand(), undefined, undefined, 8)
      if (health.exitCode === 0) {
        const raw = health.result.trim()
        if (spec.health.field) {
          try { const data = JSON.parse(raw); if (data[spec.health.field]) { log('target', `Health check passed · ${data[spec.health.field]}`, 'green'); return data[spec.health.field] } }
          catch { log('target', `Health check responded · ${raw.slice(0, 60)}`, 'green'); return spec.patch?.vulnerableVersion || spec.label }
        } else { log('target', 'Health check passed', 'green'); return spec.patch?.vulnerableVersion || spec.label }
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error(`${spec.label} did not become healthy on port ${spec.port}`)
  }

  function describe() {
    return {
      runId,
      targetApp: spec.id,
      target: worker ? { id: worker.id, url: targetUrl, version, name: spec.label, scope: spec.scope } : null,
      scanner: worker ? { id: worker.id, name: 'owasp-zap', image: ZAP_IMAGE } : null,
      sandboxes: worker ? [{ id: worker.id, role: 'worker', name: spec.label, version: version || 'running', status: 'Running', services: ['app', 'owasp-zap'] }] : [],
      note: 'The app and OWASP ZAP run together in one isolated sandbox and communicate over localhost.',
    }
  }

  async function provision({ runId: suppliedRunId = `run-${Date.now()}` } = {}) {
    if (worker) return describe()
    runId = String(suppliedRunId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)
    const base = { labels: { project: 'daytona-hacksprint', run: runId, ownership: 'synthetic-demo' }, autoStopInterval: 30, autoDeleteInterval: 60, ttlMinutes: 120, public: true }
    try {
      log('target', `Provisioning isolated worker for ${spec.label} (app + OWASP ZAP)…`)
      worker = await getClient().create({ ...base, name: `hs-worker-${runId}`, image: spec.image, ...(spec.resources ? { resources: spec.resources } : {}) }, { timeout: 1200, onSnapshotCreateLogs: chunk => log('target', String(chunk).slice(-300)) })
      log('target', `Daytona sandbox ready · ${worker.id}`, 'green')
      try { await worker.waitUntilStarted(180) } catch { /* already started */ }

      if (spec.files?.length) {
        await execute('target', `mkdir -p ${spec.appDir}`)
        for (const file of spec.files) await worker.fs.uploadFile(Buffer.from(await readFile(file.source, 'utf8')), `${spec.appDir}/${file.path}`)
      }
      if (spec.localDir) {
        log('target', `Uploading local checkout · ${spec.localDir}`, 'muted')
        await worker.fs.uploadFile(await packDirectory(spec.localDir), '/tmp/owned-repo.tgz')
        await execute('target', `bash -c ${shellQuote(`rm -rf ${spec.appDir} && mkdir -p ${spec.appDir} && tar -xzf /tmp/owned-repo.tgz -C ${spec.appDir}`)}`, 120)
      }
      for (const command of spec.prepare ?? []) { log('target', `$ ${command}`, 'muted'); await execute('target', `bash -c ${shellQuote(command)}`, 900) }

      version = await startApp()
      targetUrl = (await worker.getPreviewLink(spec.port)).url.replace(/\/$/, '')
      log('target', `Owned target available · ${new URL(targetUrl).hostname}`, 'blue')

      log('scanner', 'Starting OWASP ZAP daemon in the same sandbox (localhost scan)…')
      await execute('scanner', `bash -c ${shellQuote(ZAP_START)}`)
      await worker.fs.uploadFile(Buffer.from(await readFile(scannerSource, 'utf8')), '/tmp/owned-scan.py')
      return describe()
    } catch (error) {
      log('target', `Provisioning stopped: ${error.message}`, 'yellow')
      throw error
    }
  }

  async function scan() {
    if (!worker || !targetUrl) throw new Error('Provision the owned target first')
    const localUrl = `http://127.0.0.1:${spec.port}`
    const rules = spec.scan.rules.join(',')
    const seeds = (spec.scan.seeds || [spec.scan.seed || '/']).filter(Boolean)
    log('scanner', `Scanning ${spec.label} on localhost · rules ${rules}`, 'blue')
    const env = {
      OWNED_TARGET_URL: localUrl,
      OWNED_TARGET_HOST: '127.0.0.1',
      ZAP_SCAN_SEEDS: seeds.join(','),
      ZAP_SCAN_INCLUDE: spec.scan.include,
      ZAP_SCAN_RULES: rules,
      ZAP_SCAN_SECONDS: String(spec.scan.maxSeconds),
      ...(spec.login?.requestData ? {
        OWNED_LOGIN_PATH: spec.login.path,
        OWNED_LOGIN_REQUEST: spec.login.requestData,
        OWNED_LOGIN_USER: spec.login.email || '',
        OWNED_LOGIN_PASS: spec.login.password || '',
        OWNED_LOGIN_INDICATOR: spec.login.indicator || '',
      } : {}),
    }
    const output = await worker.process.executeCommand('python3 /tmp/owned-scan.py', undefined, env, spec.scan.maxSeconds + 180)
    if (output.result) for (const line of output.result.trim().split('\n')) log('scanner', line, 'blue')
    if (output.exitCode !== 0) {
      const daemonLog = await worker.process.executeCommand('tail -n 25 /tmp/zap.log', undefined, undefined, 10)
      log('scanner', (daemonLog.result || '').slice(-2000), 'yellow')
      throw new Error(`Scoped ZAP scan failed: ${(output.result || '').slice(-1200)}`)
    }
    const bytes = await worker.fs.downloadFile('/tmp/owned-zap-report.json')
    const report = JSON.parse(Buffer.from(bytes).toString('utf8'))
    // Present alerts against the public preview URL so the UI shows a reachable host.
    const publicHost = new URL(targetUrl)
    for (const alert of report.alerts) { try { const url = new URL(alert.url); alert.url = `${publicHost.protocol}//${publicHost.host}${url.pathname}${url.search}` } catch { /* leave as-is */ } }
    log('scanner', `${report.alerts.length} scanner alerts collected`, report.alerts.length ? 'yellow' : 'green')
    return { alerts: report.alerts, report, logs: getLogs(), version, target: getTarget(), proof: spec.proof, login: spec.login }
  }

  async function applyFix() {
    if (!spec.patch) throw new Error(`${spec.label} does not declare a patch`)
    if (!worker) throw new Error('Provision the owned target first')
    if (spec.patch.fixedVersion && version === spec.patch.fixedVersion) return { ...getTarget(), diff: spec.patch, alreadyApplied: true }
    const path = `${spec.appDir}/${spec.patch.file}`
    const original = Buffer.from(await worker.fs.downloadFile(path)).toString('utf8')
    const fixed = applySourceFix(original, spec.patch)
    await worker.fs.uploadFile(Buffer.from(fixed), path)
    if (spec.patch.fixedVersion) version = spec.patch.fixedVersion
    log('target', `Applied source patch: ${spec.patch.file}`, 'blue')
    version = await startApp()
    return { ...getTarget(), diff: spec.patch, beforeVersion: spec.patch.vulnerableVersion || 'vulnerable', afterVersion: version }
  }

  function getTarget() { if (!worker || !targetUrl) throw new Error('Owned target is not ready'); return { id: worker.id, url: targetUrl, version, app: spec.id, scope: spec.scope } }
  function getLogs() { return { target: [...logs.target], scanner: [...logs.scanner] } }
  function getScope() { return { app: spec.id, label: spec.label, scope: spec.scope, proof: spec.proof, login: spec.login, canPatch: Boolean(spec.patch) } }
  async function refreshLogs() {
    if (worker) {
      const result = await worker.process.executeCommand('tail -n 14 /tmp/app.log 2>/dev/null', undefined, undefined, 10)
      if (result.result) logs.target = result.result.trim().split('\n').map(text => ({ text, tone: 'muted', time: new Date().toISOString() }))
    }
    return getLogs()
  }
  async function cleanup() {
    if (!worker) return { deleted: 0 }
    try { await getClient().delete(worker) } finally { worker = null; targetUrl = null }
    return { deleted: 1 }
  }
  return { provision, scan, getTarget, getState: describe, getScope, getLogs, refreshLogs, log, applyFix, cleanup, getSandboxes: () => ({ worker }) }
}

/**
 * Delete sandboxes left behind by previous runs. The in-memory run map does not survive a
 * restart, so those sandboxes are unreachable and consume the org's disk quota.
 */
export async function purgeOrphanSandboxes({ onLog = () => {}, apiKey = process.env.DAYTONA_API_KEY, apiUrl = process.env.DAYTONA_API_URL, target: region = process.env.DAYTONA_TARGET, client } = {}) {
  if (!apiKey && !client) return { deleted: 0, skipped: true }
  const daytona = client || new Daytona({ apiKey, ...(apiUrl ? { apiUrl } : {}), ...(region ? { target: region } : {}) })
  let deleted = 0
  try {
    for await (const sandbox of daytona.list({ labels: { project: 'daytona-hacksprint' } })) {
      try { await daytona.delete(sandbox); deleted += 1; onLog({ role: 'system', text: `Removed orphaned sandbox ${sandbox.id}`, tone: 'muted' }) }
      catch { /* leave it; it may be mid-teardown */ }
    }
  } catch { /* listing failed; nothing to do */ }
  return { deleted }
}
