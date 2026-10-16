import { createHash, randomBytes } from 'node:crypto'

const IDENTITY_FIELDS = ['appVersion', 'scope', 'account', 'testConfig', 'testId']
const ANCHOR_BASE = 'https://api.anchorbrowser.io/v1'

// Daytona serves an interstitial "Preview URL Warning" to browsers before proxying to the
// sandbox. Accepting it sets this cookie; without it a browser only ever sees the warning
// page, so the browser verifier would never reach the app.
const PREVIEW_COOKIE = 'daytona-preview-page-accepted'

async function seedPreviewConsent(page, url) {
  try {
    await page.context().addCookies([{
      name: PREVIEW_COOKIE, value: 'true', domain: url.hostname, path: '/',
      httpOnly: true, secure: url.protocol === 'https:', sameSite: 'None',
    }])
  } catch { /* non-Daytona target: there is no interstitial to accept */ }
}

async function passPreviewWarning(page) {
  const title = await page.title().catch(() => '')
  const button = page.locator('button:has-text("I Understand")')
  const present = (await button.count().catch(() => 0)) > 0
  if (!present && !/preview/i.test(title)) return false
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
    button.first().click({ timeout: 10000 }).catch(() => {}),
  ])
  await page.waitForTimeout(300)
  return true
}

// Sign in with the demo credentials so the verifier can reach authenticated areas.
async function performLogin(page, target, login) {
  const loginUrl = new URL(login.path, target.origin)
  await page.goto(loginUrl.toString(), { waitUntil: 'networkidle', timeout: 25000 })
  await passPreviewWarning(page)
  if (login.emailField) await page.fill(login.emailField, login.email)
  if (login.passwordField) await page.fill(login.passwordField, login.password)
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
    login.submit ? page.click(login.submit, { timeout: 10000 }).catch(() => {}) : Promise.resolve(),
  ])
  await page.waitForTimeout(300)
}

export function memoryIdentity(identity) {
  const normalized = Object.fromEntries(IDENTITY_FIELDS.map(key => {
    if (typeof identity?.[key] !== 'string' || !identity[key].trim()) throw new Error(`Missing memory identity: ${key}`)
    return [key, identity[key]]
  }))
  return { identity: normalized, id: `proof-${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}` }
}

export function createSponsors(config = {}) {
  const fetcher = config.fetch ?? globalThis.fetch
  const host = config.SURREAL_MEMORY_ENDPOINT ?? config.SURREAL_MEMORY_HOST
  const context = config.SURREAL_MEMORY_CONTEXT ?? config.SURREAL_MEMORY_CONTEXT_ID
  const memoryBase = host && context ? `${host.replace(/\/$/, '')}/api/v1/${encodeURIComponent(context)}` : null
  let session = null
  let browser = null

  function failure(service, error, extra = {}) {
    let message = error instanceof Error ? error.message : String(error)
    for (const key of ['ANCHOR_API_KEY', 'ARIZE_API_KEY', 'SURREAL_MEMORY_API_KEY']) {
      if (config[key]) message = message.split(config[key]).join('[redacted]')
    }
    // CDP URLs may contain a session credential. Never return driver exceptions verbatim.
    message = message.replace(/(?:wss?|https?):\/\/[^\s"']+/g, '[url]')
    return { ok: false, service, error: message.slice(0, 400), ...extra }
  }

  async function request(url, { headers = {}, ...options } = {}) {
    const response = await fetcher(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? 30000),
    })
    const text = await response.text()
    let body
    try { body = text ? JSON.parse(text) : {} } catch { body = {} }
    if (!response.ok) throw new Error(`Service returned HTTP ${response.status}`)
    return { body, status: response.status }
  }

  function anchorRequest(path, options = {}) {
    if (!config.ANCHOR_API_KEY) throw new Error('Anchor API key is not configured')
    return request(`${ANCHOR_BASE}${path}`, { ...options, headers: { 'anchor-api-key': config.ANCHOR_API_KEY, ...options.headers } })
  }

  function memoryRequest(path, options = {}) {
    if (!memoryBase || !config.SURREAL_MEMORY_API_KEY) throw new Error('Agent Memory host, context, and key are required')
    const endpoint = new URL(memoryBase)
    if (endpoint.protocol !== 'https:' && !config.allowInsecureTestEndpoint) throw new Error('Agent Memory requires HTTPS')
    return request(`${memoryBase}${path}`, { ...options, headers: { Authorization: `Bearer ${config.SURREAL_MEMORY_API_KEY}`, ...options.headers } })
  }

  function checkedTarget(value) {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid target URL')
    const allowed = config.allowedTargetOrigins ?? []
    if (!allowed.includes(url.origin)) throw new Error('Target origin is outside the owned target allowlist')
    return url
  }

  async function createBrowser() {
    try {
      if (session) return { ok: true, service: 'anchor', sessionId: session.id, viewerUrl: session.live_view_url }
      const { body } = await anchorRequest('/sessions', {
        method: 'POST',
        body: JSON.stringify({ session: { timeout: { max_duration: 10, idle_timeout: 2 } }, browser: { headless: { active: false } } }),
      })
      const data = body.data
      if (!data?.id || !data.cdp_url || !data.live_view_url) throw new Error('Anchor session response is incomplete')
      session = data
      return { ok: true, service: 'anchor', sessionId: data.id, viewerUrl: data.live_view_url }
    } catch (error) { return failure('anchor', error) }
  }

  async function cleanupBrowser() {
    const current = session
    if (!current) return { ok: true, service: 'anchor', closed: false }
    try {
      if (browser) await browser.close().catch(() => {})
      browser = null
      await anchorRequest(`/sessions/${encodeURIComponent(current.id)}`, { method: 'DELETE' })
      session = null
      return { ok: true, service: 'anchor', closed: true, sessionId: current.id }
    } catch (error) { return failure('anchor', error, { sessionId: current.id }) }
  }

  // Reconnect when the cached CDP connection or Anchor session has gone stale.
  async function ensureBrowser() {
    const driver = config.chromium ?? (await import('playwright-core')).chromium
    if (browser && browser.isConnected()) return browser
    if (browser) { await browser.close().catch(() => {}); browser = null }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!session) {
        const created = await createBrowser()
        if (!created.ok) throw new Error(created.error || 'Anchor session unavailable')
      }
      try { browser = await driver.connectOverCDP(session.cdp_url, { timeout: 30000 }); return browser }
      catch {
        // The cached session is dead: drop it and retry with a fresh one.
        await anchorRequest(`/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }).catch(() => {})
        session = null
      }
    }
    throw new Error('Could not establish an Anchor browser connection')
  }

  async function verifyXss(targetUrl, payload, options = {}) {
    let page
    try {
      const target = checkedTarget(targetUrl)
      if (typeof payload !== 'string' || payload.length > 4000) throw new Error('A bounded string payload is required')
      const expectedDialog = options.expectedDialog ?? payload.match(/alert\(\s*['"]([^'"]+)['"]\s*\)/)?.[1]
      if (!expectedDialog) throw new Error('Payload must contain a known harmless alert marker')
      const created = await createBrowser()
      if (!created.ok) return { ...created, confirmed: false, blocked: false }
      const connected = await ensureBrowser()
      const ctx = connected.contexts()[0] ?? await connected.newContext()
      page = await ctx.newPage()
      await seedPreviewConsent(page, target)
      const events = []
      let outsideScope = false
      await page.route('**/*', route => {
        const requestUrl = new URL(route.request().url())
        if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== target.origin) {
          outsideScope = true
          return route.abort('blockedbyclient')
        }
        return route.continue()
      })
      page.on('dialog', async dialog => {
        events.push({ type: dialog.type(), message: dialog.message(), url: page.url(), observedAt: new Date().toISOString() })
        await dialog.dismiss().catch(() => {})
      })
      if (options.login?.path) await performLogin(page, target, options.login)
      target.pathname = options.path || target.pathname || '/'
      target.searchParams.set(options.parameter ?? 'q', payload)
      const response = await page.goto(target.toString(), { waitUntil: 'networkidle', timeout: 25000 })
      await passPreviewWarning(page)
      await page.waitForTimeout(config.proofWaitMs ?? 700)
      const finalUrl = checkedTarget(page.url())
      const renderedText = await page.locator('body').innerText()
      const attackStatus = response?.status() ?? 0
      const confirmed = events.some(event => event.type === 'alert' && event.message === expectedDialog && new URL(event.url).origin === target.origin)
      let normalSearchWorks = false
      let normalStatus = null
      if (options.expectedBlocked) {
        const normal = new URL(targetUrl)
        normal.pathname = options.path || '/'
        const normalMarker = `normal-search-${randomBytes(6).toString('hex')}`
        normal.searchParams.set(options.parameter ?? 'q', normalMarker)
        const normalResponse = await page.goto(normal.toString(), { waitUntil: 'networkidle', timeout: 25000 })
        await page.waitForTimeout(config.proofWaitMs ?? 700)
        checkedTarget(page.url())
        normalStatus = normalResponse?.status() ?? 0
        normalSearchWorks = normalStatus >= 200 && normalStatus < 300 && (await page.locator('body').innerText()).includes(normalMarker)
      }
      const blocked = Boolean(options.expectedBlocked && events.length === 0 && attackStatus >= 200 && attackStatus < 300 && normalSearchWorks && !outsideScope)
      const payloadVisibleAsText = renderedText.includes(payload)
      // Capture the actual rendered page in the live session — real evidence that survives the session.
      const screenshotBase64 = await page.screenshot({ type: 'png' }).then(buffer => buffer.toString('base64')).catch(() => null)
      return {
        ok: !outsideScope, service: 'anchor', confirmed: !outsideScope && confirmed, blocked, normalSearchWorks,
        sessionId: session.id, viewerUrl: session.live_view_url,
        screenshotBase64,
        evidence: { targetUrl: finalUrl.toString(), attackStatus, normalStatus, expectedDialog, dialogs: events, observedAt: new Date().toISOString(), payloadVisibleAsText, escapedPayloadVisible: payloadVisibleAsText },
        ...(outsideScope ? { error: 'A request or redirect left the owned target origin; verification is inconclusive' } : {}),
      }
    } catch (error) { return failure('anchor', error, { confirmed: false, blocked: false, sessionId: session?.id, viewerUrl: session?.live_view_url }) }
    finally { if (page) await page.close().catch(() => {}) }
  }

  async function recordMemory(record) {
    try {
      const { identity, id } = memoryIdentity(record.identity)
      const stored = { ...record, identity, schema: 'session-proof-v1', valid: record.valid !== false }
      const body = { infer: 'triples', memory_category: 'context', triples: [{ entity: { type: 'project', name: id }, key: 'record_json', value: JSON.stringify(stored), memory_category: 'context' }] }
      if (config.SURREAL_MEMORY_SCOPE) body.scopes = [[config.SURREAL_MEMORY_SCOPE]]
      const { status } = await memoryRequest('/facts', { method: 'POST', body: JSON.stringify(body) })
      const readback = await findMemory(identity)
      return { ok: readback.ok && (stored.valid ? readback.found : !readback.found), service: 'surrealdb', persisted: readback.ok && readback.stored === true, id, status, record: readback.record, ...(readback.error ? { error: readback.error } : {}) }
    } catch (error) { return failure('surrealdb', error, { persisted: false }) }
  }

  async function findMemory(input) {
    try {
      const { identity, id } = memoryIdentity(input)
      let response
      try { response = await memoryRequest(`/entities/project/${encodeURIComponent(id)}`) }
      catch (error) {
        if (error.message === 'Service returned HTTP 404') return { ok: true, service: 'surrealdb', found: false, stored: false, id }
        throw error
      }
      const attributes = response.body.attributes
      if (!Array.isArray(attributes)) throw new Error('Agent Memory entity has no attributes array')
      const candidates = attributes.filter(attribute => attribute.key === 'record_json' && !attribute.supersededBy && !attribute.superseded_by && !attribute.forgottenAt && !attribute.forgotten_at)
      if (candidates.length !== 1) return { ok: true, service: 'surrealdb', found: false, stored: false, id, reason: 'Missing or ambiguous current record' }
      let record
      try { record = JSON.parse(candidates[0].value) } catch { throw new Error('Memory record is not valid JSON') }
      const same = record.schema === 'session-proof-v1' && IDENTITY_FIELDS.every(key => record.identity?.[key] === identity[key])
      return { ok: true, service: 'surrealdb', found: same && record.valid === true, stored: same, id, ...(same ? { record } : { reason: 'Exact memory identity did not match' }) }
    } catch (error) { return failure('surrealdb', error, { found: false, stored: false }) }
  }

  async function traceRun(spans) {
    try {
      if (!config.ARIZE_API_KEY || !config.ARIZE_SPACE_ID) throw new Error('Arize API key and Space ID are required')
      if (!Array.isArray(spans) || !spans.length) throw new Error('At least one completed span is required')
      const traceId = /^[a-f0-9]{32}$/i.test(spans[0].traceId ?? '') ? spans[0].traceId : randomBytes(16).toString('hex')
      const attributes = values => Object.entries(values ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => ({ key, value: typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { doubleValue: value } : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } }))
      const wireSpans = spans.map(span => {
        const start = new Date(span.startTime ?? span.startedAt).getTime()
        const end = new Date(span.endTime ?? span.endedAt).getTime()
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Trace spans require actual valid start and end times')
        return {
          traceId, spanId: /^[a-f0-9]{16}$/i.test(span.spanId ?? '') ? span.spanId : randomBytes(8).toString('hex'),
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name ?? 'agent.step', kind: 1,
          startTimeUnixNano: (BigInt(start) * 1000000n).toString(), endTimeUnixNano: (BigInt(end) * 1000000n).toString(),
          attributes: attributes({ 'openinference.span.kind': span.kind ?? 'TOOL', ...span.attributes }),
          status: { code: span.error || span.ok === false ? 2 : 1, ...(span.error ? { message: String(span.error).slice(0, 500) } : {}) },
        }
      })
      const project = config.ARIZE_PROJECT_NAME ?? 'session-workspace'
      const { body, status } = await request(config.ARIZE_OTLP_ENDPOINT ?? 'https://otlp.arize.com/v1/traces', {
        method: 'POST', headers: { 'arize-space-id': config.ARIZE_SPACE_ID, 'arize-api-key': config.ARIZE_API_KEY },
        body: JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'session-workspace', 'openinference.project.name': project, model_id: project }) }, scopeSpans: [{ scope: { name: 'session-workspace', version: '1' }, spans: wireSpans }] }] }),
      })
      const rejected = Number(body.partialSuccess?.rejectedSpans ?? 0)
      return { ok: rejected === 0, service: 'arize', accepted: wireSpans.length - rejected, rejected, status, traceId, project, dashboardUrl: 'https://app.arize.com', projectUrl: config.ARIZE_PROJECT_URL ?? null, indexed: false, ...(rejected ? { error: 'Arize rejected one or more spans' } : {}) }
    } catch (error) { return failure('arize', error, { accepted: 0, indexed: false }) }
  }

  async function probe() {
    const [anchor, surrealdb] = await Promise.all([
      (async () => { try { const { status } = await anchorRequest('/sessions'); return { ok: true, service: 'anchor', status } } catch (error) { return failure('anchor', error) } })(),
      (async () => { try { const { status } = await memoryRequest('/me'); return { ok: true, service: 'surrealdb', status } } catch (error) { return failure('surrealdb', error) } })(),
    ])
    const now = new Date().toISOString()
    const arize = await traceRun([{ name: 'sponsors.connection-check', startTime: now, endTime: now, kind: 'CHAIN', attributes: { 'check.type': 'connection' } }])
    return { anchor, surrealdb, arize }
  }

  return { probe, createBrowser, cleanupBrowser, verifyXss, retestXss: (url, payload, options) => verifyXss(url, payload, { ...options, expectedBlocked: true }), recordMemory, findMemory, invalidateMemory: identity => recordMemory({ identity, valid: false, invalidatedAt: new Date().toISOString() }), traceRun }
}
