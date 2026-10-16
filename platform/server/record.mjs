// Dev-only: drive a full demo through the UI and capture the stages.
import { chromium } from 'playwright-core'

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5199/'
const OUT = process.env.SHOT_OUT || '/private/var/folders/rj/2kpdsmzs5zxghjjpf4jbhh9h0000gn/T/opencode'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.on('pageerror', e => console.log('pageerror:', String(e)))
page.on('console', m => { if (m.type() === 'error') console.log('console.error:', m.text()) })

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/rec-00-idle.png`, fullPage: true })

const runButton = page.getByRole('button', { name: /full demo/i }).first()
if (!(await runButton.count())) { console.log('no Run button found'); await browser.close(); process.exit(1) }
await runButton.click()
console.log('clicked Run full demo')

for (let i = 1; i <= 17; i++) {
  await page.waitForTimeout(10000)
  await page.screenshot({ path: `${OUT}/rec-${String(i).padStart(2, '0')}.png`, fullPage: true })
  const badges = await page.locator('.lr-badge').allInnerTexts()
  console.log(`t≈${i * 10}s status=[${badges.join(', ')}]`)
}

await page.screenshot({ path: `${OUT}/rec-final.png`, fullPage: true })
console.log('final ->', `${OUT}/rec-final.png`)
await browser.close()
