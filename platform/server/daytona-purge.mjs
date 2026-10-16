// Dev-only: list and delete orphaned Daytona sandboxes that eat the org disk quota.
import { loadConfig } from './config.mjs'
import { Daytona } from '@daytonaio/sdk'

const config = loadConfig()
const daytona = new Daytona({ apiKey: config.DAYTONA_API_KEY, ...(config.DAYTONA_API_URL ? { apiUrl: config.DAYTONA_API_URL } : {}), ...(config.DAYTONA_TARGET ? { target: config.DAYTONA_TARGET } : {}) })

const purge = process.argv.includes('--purge')
const sandboxes = []
for await (const sb of daytona.list()) sandboxes.push(sb)
console.log(`found ${sandboxes.length} sandbox(es)`)
for (const sb of sandboxes) {
  const labels = sb.labels || {}
  console.log(`- ${sb.id} | ${sb.state || sb.status || '?'} | project=${labels.project || '-'} run=${labels.run || '-'} | disk=${sb.disk ?? sb.resources?.disk ?? '?'}`)
}
if (purge) {
  for (const sb of sandboxes) {
    try { await daytona.delete(sb); console.log(`deleted ${sb.id}`) } catch (error) { console.log(`delete ${sb.id} failed: ${error.message}`) }
  }
}
process.exit(0)
