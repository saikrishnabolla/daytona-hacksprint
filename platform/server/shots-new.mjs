// Dev-only: screenshot the new wizard Overview + live-data pages.
import { chromium } from 'playwright-core'

const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:5199'
const OUT = process.env.SHOT_OUT || '/private/var/folders/rj/2kpdsmzs5zxghjjpf4jbhh9h0000gn/T/opencode'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()}`) })
page.on('pageerror', e => errors.push(`PAGEERROR ${e}`))

async function shot(path, name) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  console.log(`${name} -> ${OUT}/${name}.png  |  ${(await page.locator('h1,h2').allInnerTexts()).slice(0, 8).join(' · ')}`)
}

await shot('/', 'new-overview')

// GitHub connect card
const github = page.getByRole('button', { name: /log in with github/i }).first()
if (await github.count()) { await github.click().catch(() => {}); await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/new-overview-github.png`, fullPage: true }); console.log('new-overview-github -> clicked') }
const repo = page.getByRole('button', { name: /acme\//i }).first()
if (await repo.count()) { await repo.click().catch(() => {}); await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/new-overview-picked.png`, fullPage: true }); console.log('new-overview-picked -> selected') }

await shot('/findings', 'new-issues')

// Open the confirmed XSS issue (the one with captured Anchor frames) and screenshot the dialog.
const target = page.getByRole('button', { name: /Cross Site Scripting/i }).first()
if (await target.count()) {
  await target.click().catch(() => {})
  await page.waitForTimeout(1400)
  await page.screenshot({ path: `${OUT}/new-issue-detail.png`, fullPage: true })
  console.log('new-issue-detail -> captured')
}

await shot('/memory', 'new-memory')
await shot('/integrations', 'new-integrations')

console.log('--- console errors ---')
console.log(errors.length ? [...new Set(errors)].slice(0, 12).join('\n') : '(none)')
await browser.close()
