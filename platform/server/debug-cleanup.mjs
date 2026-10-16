import { Daytona } from '@daytonaio/sdk'
import { loadConfig } from './config.mjs'

const config = loadConfig()
const daytona = new Daytona({ apiKey: config.DAYTONA_API_KEY })
const only = process.env.ONLY_LABEL !== 'false'

let removed = 0
for await (const sandbox of daytona.list(only ? { labels: { project: 'daytona-hacksprint' } } : {})) {
  console.log('deleting', sandbox.id, sandbox.name)
  try { await daytona.delete(sandbox); removed++ } catch (error) { console.log('  failed:', error.message) }
}
console.log(`removed ${removed}`)
