// Dev-only: walk the wizard through every step and screenshot each.
import { chromium } from 'playwright-core'

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5199/'
const OUT = process.env.SHOT_OUT || '/private/var/folders/rj/2kpdsmzs5zxghjjpf4jbhh9h0000gn/T/opencode'
const API = process.env.API_URL || 'http://127.0.0.1:8787'

await fetch(`${API}/api/runs/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
await new Promise(r => setTimeout(r, 2500))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } })
page.on('pageerror', e => console.log('pageerror:', String(e)))
page.on('console', m => { if (m.type() === 'error') console.log('console.error:', m.text()) })

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/wiz-1-repo.png`, fullPage: true })
console.log('step 1 (select repo) captured')

async function clickAndWait(name) {
  const button = page.getByRole('button', { name }).first()
  await button.waitFor({ state: 'visible', timeout: 15000 })
  for (let i = 0; i < 200; i++) { if (await button.isEnabled()) break; await page.waitForTimeout(2000) }
  await button.click()
  console.log(`clicked "${name}"`)
}
async function waitEnabled(name) {
  const button = page.getByRole('button', { name }).first()
  for (let i = 0; i < 220; i++) { if (await button.count() && await button.isEnabled()) return true; await page.waitForTimeout(2000) }
  return false
}

await clickAndWait(/^Run tests$/i)
console.log('provisioning… waiting for scans')
const scansReady = await waitEnabled(/^Next$/i)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/wiz-2-agents.png`, fullPage: true })
console.log(`step 2 (agents) captured — ready=${scansReady}`)

await clickAndWait(/^Next$/i)
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/wiz-3-issues.png`, fullPage: true })
console.log('step 3 (issues) captured')

await clickAndWait(/Fix \d+ issue/i)
console.log('fixing… waiting for retest')
const fixReady = await waitEnabled(/^Next$/i)
await page.waitForTimeout(6000)
await page.screenshot({ path: `${OUT}/wiz-4-fix.png`, fullPage: true })
console.log(`step 4 (fix & verify) captured — ready=${fixReady}`)

await clickAndWait(/^Next$/i)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/wiz-5-report.png`, fullPage: true })
console.log('step 5 (report) captured')

await browser.close()
