/** Drive the full repair loop through the orchestrator API. */
const base = 'http://127.0.0.1:8787'
const targetApp = process.argv[2] || 'synthetic-help-center'

async function call(method, path, body) {
  const started = Date.now()
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  console.log(`\n=== ${method} ${path} -> ${res.status} (${((Date.now() - started) / 1000).toFixed(1)}s) ===`)
  return json
}

const provisioned = await call('POST', '/api/run/provision', { targetApp })
console.log('target:', provisioned.target)
if (!provisioned.target) process.exit(1)

const scan = await call('POST', '/api/run/scan')
for (const f of scan.findings || []) console.log(`  [${f.severity}] ${f.pluginId} ${f.title} · ${f.endpoint}`)

const verify = await call('POST', '/api/run/verify')
console.log('verify:', JSON.stringify({ confirmed: verify.verification?.confirmed, expected: verify.verification?.evidence?.expectedDialog, observed: verify.verification?.evidence?.observedDialog, viewer: verify.verification?.viewerUrl }, null, 2))

const proposal = await call('POST', '/api/run/propose', {})
console.log('proposal:', JSON.stringify(proposal.proposal, null, 2)?.slice(0, 1200))

const fixed = await call('POST', '/api/run/apply-fix')
console.log('apply-fix:', JSON.stringify(fixed, null, 2)?.slice(0, 600))

const retest = await call('POST', '/api/run/retest')
console.log('retest:', JSON.stringify(retest.verification, null, 2)?.slice(0, 800))

const memory = await call('POST', '/api/run/memory', { valid: !retest.verification?.vulnerable })
console.log('memory:', JSON.stringify(memory.memory, null, 2)?.slice(0, 600))

const trace = await call('POST', '/api/run/trace', {})
console.log('trace:', JSON.stringify(trace.trace, null, 2)?.slice(0, 600))

await call('POST', '/api/run/cleanup')
console.log('\nloop complete')
