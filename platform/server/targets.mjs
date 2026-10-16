/**
 * Target application definitions.
 *
 * Architecture note (learned the hard way): a Daytona sandbox cannot reach another
 * sandbox's preview URL — the proxy resolves to an internal CGNAT address and resets —
 * and arbitrary outbound HTTPS is filtered. So the app and OWASP ZAP MUST live in the
 * same sandbox and talk over localhost. Every target below therefore uses one "worker"
 * image (ZAP + git + node + python3) and is scanned at http://127.0.0.1:<port>.
 *
 * Targets:
 *  - `juice-shop`            OWASP Juice Shop, baked into the worker image (default)
 *  - `demo-repo`             any git repo: cloned, installed and run inside the sandbox
 *  - `synthetic-help-center` tiny offline fixture (no network needed) with a known patch
 */
import { resolve } from 'node:path'
import { Image } from '@daytonaio/sdk'

// One image that can clone/build/run an app AND host ZAP, so the scan never leaves the sandbox.
function workerImage(extraCommands = []) {
  return Image.base(process.env.ZAP_IMAGE || 'ghcr.io/zaproxy/zaproxy:stable')
    .dockerfileCommands([
      'USER root',
      'RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates build-essential && rm -rf /var/lib/apt/lists/*',
      'RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*',
      ...extraCommands,
    ])
    .workdir('/workspace')
}

const STOP = 'if [ -f /tmp/app.pid ]; then kill -- -"$(cat /tmp/app.pid)" 2>/dev/null || kill "$(cat /tmp/app.pid)" 2>/dev/null || true; sleep 1; fi;'

const DEMO_REPO_APP_DIR = '/workspace/app'

// Specs are built lazily so .env.server (loaded by loadConfig) is present in
// process.env before any of these values are read.
function buildTargets() {
  const juiceShopImage = process.env.JUICE_SHOP_IMAGE || 'bkimminich/juice-shop:latest'
  const repoUrl = process.env.DEMO_REPO_URL || ''
  const repoLocalDir = process.env.DEMO_REPO_LOCAL_DIR || ''
  const repoPrepare = [
    ...(repoUrl
      ? [`rm -rf ${DEMO_REPO_APP_DIR} && git clone --depth 1 --branch ${process.env.DEMO_REPO_BRANCH || 'main'} ${repoUrl} ${DEMO_REPO_APP_DIR}`]
      : []),
    `cd ${DEMO_REPO_APP_DIR} && ${process.env.DEMO_REPO_INSTALL || 'npm install --no-audit --no-fund'}`,
  ]

  return {
    'juice-shop': {
      id: 'juice-shop',
      label: 'OWASP Juice Shop',
      scope: 'Owned Juice Shop instance in an isolated Daytona sandbox',
      image: workerImage([`COPY --from=${juiceShopImage} /juice-shop /juice-shop`]),
      imageLabel: `zap + node 22 + ${juiceShopImage}`,
      port: 3000,
      resources: { cpu: 2, memory: 4, disk: 10 },
      appDir: '/juice-shop',
      files: [],
      prepare: [],
      start: `${STOP} cd /juice-shop; setsid nohup node build/app.js > /tmp/app.log 2>&1 & echo $! > /tmp/app.pid`,
      health: { path: '/rest/admin/application-version', field: 'version', runtime: 'node' },
      login: { path: '/#/login', emailField: '#email', passwordField: '#password', submit: '#loginButton', email: 'admin@juice-sh.op', password: 'admin123' },
      scan: { seed: '/rest/products/search?q=apple', include: '/(?:rest/products/search|rest/user/login)(?:[/?].*)?', rules: ['40012', '40018', '40019', '40020', '40021', '40022'], maxSeconds: 240 },
      proof: { parameter: 'q', payload: '<iframe src="javascript:alert(`xss`)">', expectedDialog: 'xss' },
      file: 'build/app.js',
    },

    'demo-repo': {
      id: 'demo-repo',
      label: process.env.DEMO_REPO_LABEL || 'Connected git repository',
      scope: 'Owned application cloned from the configured git repository',
      image: workerImage(),
      imageLabel: 'zap + node 22 + git',
      port: Number(process.env.DEMO_REPO_PORT || 3000),
      resources: { cpu: 2, memory: 4, disk: 10 },
      appDir: DEMO_REPO_APP_DIR,
      localDir: repoLocalDir ? resolve(repoLocalDir) : null,
      files: [],
      prepare: repoPrepare,
      start: `${STOP} cd ${DEMO_REPO_APP_DIR}; setsid nohup ${process.env.DEMO_REPO_START || 'npm start'} > /tmp/app.log 2>&1 & echo $! > /tmp/app.pid`,
      health: { path: process.env.DEMO_REPO_HEALTH || '/', field: process.env.DEMO_REPO_HEALTH_FIELD || '', runtime: 'node' },
      login: process.env.DEMO_REPO_EMAIL ? {
        path: process.env.DEMO_REPO_LOGIN_PATH || '/login',
        requestData: process.env.DEMO_REPO_LOGIN_REQUEST || 'email={%username%}&password={%password%}',
        emailField: process.env.DEMO_REPO_LOGIN_EMAIL_FIELD || 'input[name=email]',
        passwordField: process.env.DEMO_REPO_LOGIN_PASSWORD_FIELD || 'input[name=password]',
        submit: process.env.DEMO_REPO_LOGIN_SUBMIT || 'button[type=submit]',
        email: process.env.DEMO_REPO_EMAIL,
        password: process.env.DEMO_REPO_PASSWORD,
        successPath: process.env.DEMO_REPO_LOGIN_SUCCESS || '/dashboard',
        indicator: process.env.DEMO_REPO_LOGGED_IN_INDICATOR || 'Sign out',
      } : null,
      scan: { seeds: (process.env.DEMO_REPO_SEEDS || process.env.DEMO_REPO_SEED || '/').split(','), include: process.env.DEMO_REPO_INCLUDE || '/.*', rules: (process.env.DEMO_REPO_RULES || '40012,40018').split(','), maxSeconds: Number(process.env.DEMO_REPO_SCAN_SECONDS || 240) },
      proof: process.env.DEMO_REPO_PAYLOAD ? { parameter: process.env.DEMO_REPO_PARAM || 'q', path: process.env.DEMO_REPO_PROOF_PATH || '/', payload: process.env.DEMO_REPO_PAYLOAD, expectedDialog: process.env.DEMO_REPO_DIALOG || 'xss' } : null,
      patch: process.env.DEMO_REPO_PATCH_FILE ? { file: process.env.DEMO_REPO_PATCH_FILE, before: process.env.DEMO_REPO_PATCH_BEFORE, after: process.env.DEMO_REPO_PATCH_AFTER, vulnerableVersion: process.env.DEMO_REPO_PATCH_VULNERABLE_VERSION || '', fixedVersion: process.env.DEMO_REPO_PATCH_FIXED_VERSION || '' } : null,
    },

    'synthetic-help-center': {
      id: 'synthetic-help-center',
      label: 'Acme Help Center',
      scope: 'Owned synthetic demo only',
      image: workerImage(),
      imageLabel: 'zap + node 22 + python3',
      port: 3000,
      resources: { cpu: 2, memory: 4, disk: 10 },
      appDir: '/tmp/owned-app',
      files: [{ path: 'server.py', source: new URL('./fixture/server.py', import.meta.url) }],
      prepare: [],
      start: `${STOP} cd /tmp/owned-app; setsid nohup python3 -u server.py > /tmp/app.log 2>&1 & echo $! > /tmp/app.pid`,
      health: { path: '/health', field: 'version', runtime: 'node' },
      login: null,
      scan: { seed: '/search?q=workspace', include: '/search(?:\\?.*)?', rules: ['40012'], maxSeconds: 180 },
      proof: { parameter: 'q', payload: '<img src=x onerror=alert("demo-proof")>', expectedDialog: 'demo-proof' },
      patch: { file: 'server.py', before: '        query_html = query', after: '        query_html = html.escape(query, quote=True)', vulnerableVersion: 'demo-vulnerable-1', fixedVersion: 'demo-fixed-2' },
      file: 'server.py',
    },
  }
}

export function resolveTarget(name = process.env.TARGET_APP || 'juice-shop') {
  const targets = buildTargets()
  const target = targets[name]
  if (!target) throw new Error(`Unknown target "${name}". Known targets: ${Object.keys(targets).join(', ')}`)
  if (name === 'demo-repo' && !(process.env.DEMO_REPO_URL || process.env.DEMO_REPO_LOCAL_DIR)) {
    throw new Error('Target "demo-repo" needs DEMO_REPO_URL or DEMO_REPO_LOCAL_DIR in .env.server')
  }
  return target
}

export function listTargets() {
  const configured = Boolean(process.env.DEMO_REPO_URL || process.env.DEMO_REPO_LOCAL_DIR)
  return Object.values(buildTargets())
    .filter(({ id }) => id !== 'demo-repo' || configured)
    .map(({ id, label, scope, imageLabel }) => ({ id, label, scope, kind: 'image', image: imageLabel }))
}

/** The bundled demo checkout, if configured. Used to seed the folder picker. */
export function defaultRepoPath() {
  const dir = process.env.DEMO_REPO_LOCAL_DIR
  if (dir) return resolve(dir)
  if (process.env.DEMO_REPO_URL) return null
  return null
}

/**
 * Build a one-off target from a folder on the operator's machine.
 *
 * It reuses the demo-repo conventions (npm install → npm start → :3000 → /health) so a
 * picked checkout behaves exactly like the bundled app: authenticated scan, browser
 * proof, and the one-line patch all stay available.
 */
export function createRepoTarget({ path, label, id } = {}) {
  const base = buildTargets()['demo-repo']
  const localDir = path ? resolve(path) : base.localDir
  const slug = String(id || label || path || 'repo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'repo'
  return {
    ...base,
    id: `repo-${slug}`,
    label: label || `repo-${slug}`,
    scope: localDir ? `Owned local checkout at ${localDir}` : base.scope,
    appDir: DEMO_REPO_APP_DIR,
    localDir,
    files: [],
    // Trimmed so several sandboxes fit under Daytona's org caps (10 GiB memory / 30 GiB disk).
    resources: { cpu: Number(process.env.REPO_CPU || 1), memory: Number(process.env.REPO_MEMORY || 2), disk: Number(process.env.REPO_DISK || 8) },
    prepare: [`cd ${DEMO_REPO_APP_DIR} && ${process.env.DEMO_REPO_INSTALL || 'npm install --no-audit --no-fund'}`],
  }
}
