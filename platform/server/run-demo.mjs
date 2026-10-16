/**
 * End-to-end smoke test for the demo spine.
 *
 *   node server/run-demo.mjs [--target juice-shop] [--no-cleanup]
 *
 * Boots the target + ZAP in Daytona, runs a scoped scan, prints the findings, then
 * deletes the sandboxes unless --no-cleanup is passed.
 */
import { loadConfig } from './config.mjs'
import { createDaytonaAdapter } from './daytona.mjs'

const args = process.argv.slice(2)
const targetApp = args.includes('--target') ? args[args.indexOf('--target') + 1] : process.env.TARGET_APP || 'juice-shop'
const keep = args.includes('--no-cleanup')

const config = loadConfig()
if (!config.DAYTONA_API_KEY) {
  console.error('DAYTONA_API_KEY is missing from .env.server')
  process.exit(1)
}

const adapter = createDaytonaAdapter({
  targetApp,
  onLog: ({ role, text, tone }) => console.log(`[${role.padEnd(7)}] ${tone === 'muted' ? '' : '• '}${text}`),
})

let failed = false
try {
  console.log(`\n== Provisioning ${targetApp} + ZAP ==\n`)
  const provisioned = await adapter.provision({ runId: `demo-${Date.now()}` })
  console.log('\nTarget:', provisioned.target)
  console.log('Scanner:', provisioned.scanner)

  console.log('\n== Scanning ==\n')
  const result = await adapter.scan()
  console.log(`\n${result.alerts.length} alerts:`)
  const byRisk = result.alerts.reduce((acc, alert) => { acc[alert.risk] = (acc[alert.risk] || 0) + 1; return acc }, {})
  console.table(Object.entries(byRisk).map(([risk, count]) => ({ risk, count })))
  for (const alert of result.alerts.slice(0, 12)) {
    console.log(`  [${alert.risk}] rule ${alert.pluginId} · ${alert.alert} · ${alert.method} ${alert.url}`)
  }
  console.log('\nProof payload for browser verification:', result.proof)
} catch (error) {
  failed = true
  console.error('\nDemo failed:', error.message)
} finally {
  if (!keep) {
    console.log('\n== Cleaning up owned sandboxes ==\n')
    try { console.log(await adapter.cleanup()) } catch (error) { console.error('Cleanup failed:', error.message); failed = true }
  } else {
    console.log('\nKeeping sandboxes running (--no-cleanup). Clean up later with the /api/run/cleanup endpoint.')
  }
}
process.exit(failed ? 1 : 0)
