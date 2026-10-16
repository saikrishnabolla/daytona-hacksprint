import { useEffect, useRef, useState } from 'react'
import { MagnifyingGlass, Funnel, Bug, ArrowUpRight, CaretRight, Database, CheckCircle, WarningCircle, X, Copy, Cube, Browser, ChartLine, PlugsConnected } from '@phosphor-icons/react'
import { api, openLogStream, type RunSummary, type LiveFinding, type MemoryRecord } from '../api'
import './pages.css'

function PageHeading({ title, description }: { title: string, description: string }) { return <header className="standard-heading"><h1>{title}</h1><p>{description}</p></header> }

/* --- Issues ------------------------------------------------------------- */

type FindingWithProof = LiveFinding & { proof?: string | null, retestProof?: string | null }

function FindingsDetail({ finding, onClose }: { finding: FindingWithProof, onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="app-dialog pages-detail" onCancel={onClose} aria-labelledby="pages-detail-title">
    <div className="dialog-header">
      <div><span className="eyebrow">ISSUE</span><h2 id="pages-detail-title">{finding.title}</h2></div>
      <button className="icon-button" aria-label="Close issue" onClick={onClose}><X size={20} /></button>
    </div>
    <div className="pages-detail-meta">
      <span className={`severity ${finding.severity.toLowerCase()}`}><WarningCircle size={12} />{finding.severity}</span>
      <code>{finding.endpoint}</code>
      <span className={`lr-finding-state ${finding.status === 'Confirmed' ? 'confirmed' : ''}`}>{finding.status}</span>
      {finding.cwe && <code>{finding.cwe}</code>}
    </div>
    {finding.description && <p className="pages-detail-text">{finding.description}</p>}
    {(finding.proof || finding.retestProof) && <div className="pages-detail-block">
      <h3>Anchor Browser · captured evidence</h3>
      <div className="pages-proof">
        {finding.proof && <figure><img src={finding.proof} alt="Captured browser frame before the fix" /><figcaption>Before · exploit replayed</figcaption></figure>}
        {finding.retestProof && <figure><img src={finding.retestProof} alt="Captured browser frame after the fix" /><figcaption>After · attack blocked</figcaption></figure>}
      </div>
    </div>}
    {finding.evidence && <div className="pages-detail-block"><h3>Evidence</h3><p className="pages-detail-text">{finding.evidence}</p></div>}
    {finding.request && <div className="pages-detail-block"><h3>Request</h3><pre className="record-code">{finding.request}</pre></div>}
    {finding.response && <div className="pages-detail-block"><h3>Response</h3><pre className="record-code">{finding.response}</pre></div>}
    {!!finding.trace?.length && <div className="pages-detail-block"><h3>Trace</h3><ol className="pages-trace">{finding.trace.map(item => <li key={item.id} className={item.state || ''}><strong>{item.title}</strong><span>{item.tool} · {item.result}</span></li>)}</ol></div>}
  </dialog>
}

export function FindingsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('All')
  const [detail, setDetail] = useState<FindingWithProof | null>(null)

  useEffect(() => {
    const load = () => api.runs().then(result => setRuns(result.runs)).catch(() => {})
    load()
    const stop = openLogStream(load)
    return () => stop()
  }, [])

  const all: FindingWithProof[] = runs.flatMap(run => run.findings.map(finding => ({
    ...finding,
    // Only the finding Anchor actually replayed in a browser has captured frames.
    proof: finding.status === 'Confirmed' ? run.proofs?.verify || null : null,
    retestProof: finding.status === 'Confirmed' ? run.proofs?.retest || null : null,
  })))
  const filtered = all.filter(finding =>
    `${finding.title} ${finding.endpoint}`.toLowerCase().includes(query.toLowerCase())
    && (filter === 'All' || finding.status === filter))

  return <div className="standard-page">
    <PageHeading title="Issues" description="Everything the agents found, with the evidence behind it." />
    <div className="list-toolbar">
      <div className="search-input"><MagnifyingGlass size={16} /><input aria-label="Search issues" placeholder="Search issues or endpoints…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={13} /></button>}</div>
      <div className="select-wrap"><Funnel size={15} /><select aria-label="Filter by status" value={filter} onChange={e => setFilter(e.target.value)}><option value="All">All</option><option value="Confirmed">Confirmed</option><option value="Needs verification">Unverified</option></select></div>
      <span className="result-count">{filtered.length} {filtered.length === 1 ? 'issue' : 'issues'}</span>
    </div>
    <div className="surface table-scroll">
      <table className="data-table full-table">
        <thead><tr><th className="type-col" /><th>Issue</th><th>Severity</th><th>Endpoint</th><th>Status</th><th /></tr></thead>
        <tbody>
          {filtered.map((finding, index) => <tr key={`${finding.id}-${index}`}>
            <td><Bug size={17} /></td>
            <td><button className="finding-name" onClick={() => setDetail(finding)}>{finding.title}</button><span className="table-subtext">{finding.pluginId}</span></td>
            <td><span className={`severity ${finding.severity.toLowerCase()}`}><WarningCircle size={13} />{finding.severity}</span></td>
            <td><code>{finding.endpoint}</code></td>
            <td><span className={`verification-label ${finding.status === 'Confirmed' ? 'confirmed' : ''}`}>{finding.status === 'Confirmed' ? <CheckCircle size={13} weight="fill" /> : null}{finding.status}</span></td>
            <td><button className="icon-button" aria-label={`Open ${finding.title}`} onClick={() => setDetail(finding)}><ArrowUpRight size={17} /></button></td>
          </tr>)}
        </tbody>
      </table>
      {!filtered.length && <div className="empty-state"><h2>{all.length ? 'No matching issues' : 'No issues yet'}</h2><p>{all.length ? 'Adjust the search or filter.' : 'Run a test to populate this page.'}</p></div>}
    </div>
    {detail && <FindingsDetail finding={detail} onClose={() => setDetail(null)} />}
  </div>
}

/* --- Memory ------------------------------------------------------------- */

export function MemoryPage() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [query, setQuery] = useState('')
  useEffect(() => {
    const load = () => api.runs().then(result => setRuns(result.runs)).catch(() => {})
    load()
    const stop = openLogStream(load)
    return () => stop()
  }, [])

  // SurrealDB keys a record by identity, so re-running the same target overwrites the same record.
  // Collapse those writes so the page shows stored results, not one row per run.
  const grouped = new Map<string, { id: string; record: MemoryRecord; writes: number; latest: string }>()
  for (const run of runs) {
    const record = run.memory?.record
    if (!record?.finding) continue
    const id = run.memory?.id || run.runId
    const recordedAt = record.recordedAt || run.updatedAt
    const entry = grouped.get(id)
    if (entry) {
      entry.writes += 1
      if (new Date(recordedAt) > new Date(entry.latest)) { entry.record = record; entry.latest = recordedAt }
    } else {
      grouped.set(id, { id, record, writes: 1, latest: recordedAt })
    }
  }
  const records = [...grouped.values()]
    .filter(item => `${item.record.finding?.title || ''} ${item.record.finding?.endpoint || ''} ${item.record.identity?.testId || ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => new Date(b.latest).getTime() - new Date(a.latest).getTime())

  return <div className="standard-page">
    <PageHeading title="Memory" description="Verified results the agents can reuse." />
    <div className="memory-context-bar"><Database size={18} /><div><strong>SurrealDB Agent Memory</strong><span>{records.length} stored · {runs.length} runs</span></div></div>
    <div className="list-toolbar"><div className="search-input"><MagnifyingGlass size={16} /><input aria-label="Search memory" placeholder="Search stored results…" value={query} onChange={e => setQuery(e.target.value)} /></div><span className="result-count">{records.length} stored</span></div>
    <div className="surface table-scroll">
      {records.length ? <table className="data-table memory-table">
        <thead><tr><th>Finding</th><th>Severity</th><th>Version</th><th>Test</th><th>Writes</th><th>Updated</th><th>Record</th></tr></thead>
        <tbody>{records.map(item => <tr key={item.id}>
          <td><span className="memory-title">{item.record.finding?.title || 'Verified result'}</span>{item.record.finding?.endpoint && <code className="memory-endpoint">{item.record.finding.endpoint}</code>}</td>
          <td>{item.record.finding?.severity ? <span className={`severity ${item.record.finding.severity.toLowerCase()}`}><WarningCircle size={12} />{item.record.finding.severity}</span> : '—'}</td>
          <td><code>{item.record.identity?.appVersion || '—'}</code></td>
          <td><code>{item.record.identity?.testId || '—'}</code></td>
          <td>{item.writes}</td>
          <td className="memory-when">{new Date(item.latest).toLocaleString()}</td>
          <td><code className="memory-id" title={item.id}>{item.id.replace(/^proof-/, '').slice(0, 10)}…</code></td>
        </tr>)}</tbody>
      </table> : <div className="empty-state"><h2>No stored results</h2><p>Run a test to store verified results here.</p></div>}
    </div>
  </div>
}

/* --- Integrations ------------------------------------------------------- */

const SERVICES = [
  { id: 'daytona', name: 'Daytona', icon: Cube, subtitle: 'Isolated sandboxes', env: ['DAYTONA_API_KEY'] },
  { id: 'anchor', name: 'Anchor Browser', icon: Browser, subtitle: 'Browser verification', env: ['ANCHOR_API_KEY'] },
  { id: 'bedrock', name: 'Amazon Bedrock', icon: PlugsConnected, subtitle: 'Coding agent', env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] },
  { id: 'surrealdb', name: 'SurrealDB', icon: Database, subtitle: 'Shared memory', env: ['SURREAL_MEMORY_API_KEY', 'SURREAL_MEMORY_CONTEXT_ID'] },
  { id: 'arize', name: 'Arize', icon: ChartLine, subtitle: 'Traces', env: ['ARIZE_API_KEY', 'ARIZE_SPACE_ID'] },
]

export function IntegrationsPage() {
  const [configured, setConfigured] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState('')
  useEffect(() => { api.health().then(result => setConfigured(result.configured)).catch(() => {}) }, [])
  const connected = SERVICES.filter(service => configured[service.id]).length

  return <div className="standard-page">
    <PageHeading title="Integrations" description={`${connected} of ${SERVICES.length} services connected.`} />
    <div className="integrations-list">
      {SERVICES.map(service => <article className="integration-row" key={service.id}>
        <div className={`integration-icon ${service.id === 'daytona' ? 'daytona' : ''}`}><service.icon size={26} weight="duotone" /></div>
        <div className="integration-info"><div><h2>{service.name}</h2><span className="integration-category">{service.subtitle}</span></div><p>{service.env.join(' · ')}</p></div>
        {configured[service.id]
          ? <span className="connected-row"><span className="status-dot" />Connected</span>
          : <span className="not-connected"><span className="status-dot muted" />Not connected</span>}
        <button className="button" onClick={async () => { try { await navigator.clipboard.writeText(service.env.join('\n')); setCopied(service.id) } catch { setCopied('') } }}>{copied === service.id ? <CheckCircle size={15} /> : <Copy size={15} />}Keys<CaretRight size={14} /></button>
      </article>)}
    </div>
  </div>
}


