// Dev-only: drive one run through the multi-run API and print each step.
const base = 'http://127.0.0.1:8787'
const post = (path, body = '{}') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
const get = path => fetch(base + path)
const j = r => r.json()

await post('/api/runs/cleanup')
await new Promise(r => setTimeout(r, 3000))

const { demoRepoPath } = await j(await get('/api/targets'))
console.log('repo path:', demoRepoPath)
const created = await j(await post('/api/runs', JSON.stringify({ entries: [{ path: demoRepoPath, label: 'demo-repo' }] })))
const run = created.runs[0]
console.log('created:', run.runId, run.status)

for (const step of ['scan', 'verify', 'propose', 'apply-fix', 'retest', 'memory', 'trace']) {
  const res = await post(`/api/runs/${run.runId}/${step}`)
  const body = await j(res).catch(() => ({}))
  const v = body.verification
  console.log(`step ${step} -> HTTP ${res.status}` + (v ? ` | ${JSON.stringify({ ok: v.ok, confirmed: v.confirmed, blocked: v.blocked, normalSearchWorks: v.normalSearchWorks, error: v.error })}` : ''))
}

const state = await j(await get('/api/runs'))
const final = state.runs.find(r => r.runId === run.runId)
console.log('FINAL', final.status, '| version', final.target?.version,
  '| findings', final.findings.length,
  '| confirmed', final.findings.filter(f => f.status === 'Confirmed').length,
  '| stages', JSON.stringify(final.stages))

console.log('\n--- proofs ---')
console.log(JSON.stringify(final.proofs, null, 2))
console.log('\n--- verification.evidence ---')
console.log(JSON.stringify(final.verification?.evidence, null, 2))
console.log('\n--- retest.evidence ---')
console.log(JSON.stringify(final.retest?.evidence, null, 2))
console.log('\n--- memory ---')
console.log(JSON.stringify({ id: final.memory?.id, status: final.memory?.status, persisted: final.memory?.persisted, record: final.memory?.record }, null, 2))
console.log('\n--- trace ---')
console.log(JSON.stringify({ accepted: final.trace?.accepted, rejected: final.trace?.rejected, traceId: final.trace?.traceId, project: final.trace?.project, spans: final.trace?.spans }, null, 2))

// Confirm the captured proof frames are actually served as PNGs.
for (const [kind, path] of Object.entries(final.proofs || {})) {
  const res = await get(path)
  console.log(`proof ${kind} -> HTTP ${res.status} ${res.headers.get('content-type')} ${(await res.arrayBuffer()).byteLength} bytes`)
}

