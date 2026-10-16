/** Typed client for the orchestrator API (server/index.mjs). */

export interface TargetInfo { id: string; label: string; scope: string; kind: string; image: string | null }

export interface LiveFinding {
  id: string
  pluginId: string
  title: string
  endpoint: string
  severity: 'High' | 'Medium' | 'Low'
  status: 'Confirmed' | 'Needs verification'
  confidence?: string
  description: string
  impact: string
  evidence?: string
  request: string
  response: string
  cwe?: string | null
  trace: { id: string; title: string; time: string; tool: string; result: string; state?: 'complete' | 'pending'; evidence?: string }[]
}

export interface Proofs { verify?: string | null; retest?: string | null }

export interface Verification {
  ok?: boolean
  confirmed?: boolean
  blocked?: boolean
  normalSearchWorks?: boolean
  sessionId?: string
  viewerUrl?: string
  proof?: string | null
  service?: string
  error?: string
  evidence?: {
    targetUrl?: string
    attackStatus?: number
    normalStatus?: number
    expectedDialog?: string
    dialogs?: { type: string; message: string; url: string; observedAt: string }[]
    observedAt?: string
    payloadVisibleAsText?: boolean
  }
}

export interface TraceSpan {
  name: string
  kind?: string
  startTime: string | null
  endTime: string | null
  attributes?: Record<string, unknown>
  ok?: boolean
}

export interface TraceResult {
  ok?: boolean
  service?: string
  accepted?: number
  rejected?: number
  traceId?: string
  project?: string
  status?: number
  dashboardUrl?: string
  projectUrl?: string | null
  indexed?: boolean
  spans?: TraceSpan[]
  error?: string
}

export interface MemoryRecord {
  identity?: Record<string, string>
  valid?: boolean
  schema?: string
  recordedAt?: string
  finding?: { id: string; title: string; endpoint: string; severity: string; status: string } | null
  verification?: Verification
}

export interface MemoryResult {
  ok?: boolean
  service?: string
  persisted?: boolean
  id?: string
  status?: number
  record?: MemoryRecord
  error?: string
}

export interface RunState {
  runId: string | null
  label?: string | null
  status: string
  targetApp: string | null
  target: { id: string; url: string; version: string; name: string; scope: string } | null
  scanner: { id: string; name: string; image: string } | null
  findings: LiveFinding[]
  report: { scanner: string; version: string; ruleIds: string[]; alertCount: number; authenticated?: boolean } | null
  stages?: RunStages
  timings?: Record<string, { startedAt?: string | null; endedAt?: string | null }[]>
  sandboxes?: { id: string; role: string; name: string; version: string; status: string; services: string[] }[]
  verification: Verification | null
  retest?: Verification | null
  proofs?: Proofs
  memory: MemoryResult | null
  trace: TraceResult | null
  proposal: any
  error: string | null
  startedAt: string | null
  updatedAt: string
}

export type StageState = 'pending' | 'active' | 'done' | 'error'
export interface RunStages { daytona: StageState; zap: StageState; anchor: StageState; bedrock: StageState; surrealdb: StageState; arize: StageState }
export interface RunSummary extends RunState { runId: string; label: string; stages: RunStages }

export interface DirEntry { name: string; path: string }
export interface DirsResponse { path: string; parent: string; dirs: DirEntry[]; demoRepoPath: string | null }
export interface RunEntry { path?: string; label?: string; targetApp?: string }

export interface LogLine { role: string; text: string; tone?: string; time: string }

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options })
  const text = await response.text()
  let body: any = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { error: text } }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body as T
}

export const api = {
  health: () => call<{ ok: boolean; configured: Record<string, boolean> }>('/api/health'),
  targets: () => call<{ targets: TargetInfo[]; default: string; demoRepoPath: string | null }>('/api/targets'),
  integrations: () => call<Record<string, any>>('/api/integrations'),
  state: () => call<RunState>('/api/run/state'),
  logs: () => call<{ logs: LogLine[]; state: RunState }>('/api/run/logs'),
  runs: () => call<{ runs: RunSummary[] }>('/api/runs'),
  fsDirs: (path?: string) => call<DirsResponse>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  provisionMany: (entries: RunEntry[]) => call<{ runs: RunSummary[] }>('/api/runs', { method: 'POST', body: JSON.stringify({ entries }) }),
  runStep: (id: string, step: string) => call<any>(`/api/runs/${id}/${step}`, { method: 'POST', body: '{}' }),
  cleanupAll: () => call<{ deleted: number }>('/api/runs/cleanup', { method: 'POST', body: '{}' }),
  provision: (targetApp?: string) => call<any>('/api/run/provision', { method: 'POST', body: JSON.stringify({ targetApp }) }),
  scan: () => call<{ findings: LiveFinding[]; report: RunState['report'] }>('/api/run/scan', { method: 'POST' }),
  verify: (body: Record<string, unknown> = {}) => call<any>('/api/run/verify', { method: 'POST', body: JSON.stringify(body) }),
  retest: () => call<any>('/api/run/retest', { method: 'POST' }),
  applyFix: () => call<any>('/api/run/apply-fix', { method: 'POST' }),
  propose: (findingId?: string, source?: string) => call<any>('/api/run/propose', { method: 'POST', body: JSON.stringify({ findingId, source }) }),
  memory: (body: Record<string, unknown> = {}) => call<any>('/api/run/memory', { method: 'POST', body: JSON.stringify(body) }),
  trace: (spans?: unknown) => call<any>('/api/run/trace', { method: 'POST', body: JSON.stringify({ spans }) }),
  cleanup: () => call<{ deleted: number }>('/api/run/cleanup', { method: 'POST' }),
}

/** Subscribe to the orchestrator's server-sent event log stream. */
export function openLogStream(onLine: (line: LogLine) => void): () => void {
  const source = new EventSource('/api/run/events')
  source.onmessage = event => { try { onLine(JSON.parse(event.data)) } catch { /* ignore malformed frame */ } }
  return () => source.close()
}
