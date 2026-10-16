import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { CircleNotch, Cube, Browser, ChartLine, PlugsConnected, Play, MagnifyingGlass, Database, X, CheckCircle, WarningCircle, Broom, Plus, FolderSimple, ArrowUp, ArrowRight, ArrowLeft, Broadcast, ArrowSquareOut, TerminalWindow, Wrench, ShieldCheck, CaretRight, GithubLogo, GitBranch, Copy } from '@phosphor-icons/react'
import { api, openLogStream, type LogLine, type RunSummary, type RunStages, type RunEntry, type DirsResponse, type TargetInfo, type LiveFinding } from '../api'
import './live-run.css'
import './live-wizard.css'

type Props = { onToast: (text: string) => void }
interface Source { key: string; label: string; path?: string; targetApp?: string }

interface Row {
  key: string
  title: string
  severity: string
  endpoint: string
  pluginId: string
  confirmed: boolean
  fixable: boolean
  count: number
  finding: LiveFinding
}

const STEPS = [
  { label: 'Overview', hint: 'Connect a repository' },
  { label: 'Agents', hint: 'Sandboxes at work' },
  { label: 'Issues', hint: 'What was found' },
  { label: 'Fix & verify', hint: 'Repair and re-test' },
  { label: 'Report', hint: 'Proof and trace' },
]

const STORAGE_KEY = 'pentest-wizard-v1'

const STAGES: [keyof RunStages, string, ComponentType<{ size?: number }>][] = [  ['daytona', 'Daytona', Cube],
  ['zap', 'ZAP', MagnifyingGlass],
  ['anchor', 'Anchor', Browser],
  ['bedrock', 'Bedrock', PlugsConnected],
  ['surrealdb', 'SurrealDB', Database],
  ['arize', 'Arize', ChartLine],
]

const RANK: Record<string, number> = { High: 0, Medium: 1, Low: 2 }
const isFixable = (finding: LiveFinding) => finding.pluginId === '40012'

function parseProposal(proposal: any) {
  if (!proposal) return null
  if (typeof proposal.text === 'string') {
    const match = proposal.text.match(/\{[\s\S]*\}/)
    try { return JSON.parse(match ? match[0] : proposal.text) } catch { return { summary: proposal.text } }
  }
  return proposal
}

export default function LiveWizard({ onToast }: Props) {
  const [step, setStep] = useState(0)
  const [targets, setTargets] = useState<TargetInfo[]>([])
  const [repoPath, setRepoPath] = useState<string | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [configured, setConfigured] = useState<Record<string, boolean>>({})
  const [pickerOpen, setPickerOpen] = useState(false)
  const [browse, setBrowse] = useState<DirsResponse | null>(null)
  const [githubOpen, setGithubOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [sessionIds, setSessionIds] = useState<string[]>([])
  const [copied, setCopied] = useState('')
  const pickedInit = useRef(false)
  const restored = useRef(false)
  const logBox = useRef<HTMLDivElement>(null)
  const savedRef = useRef<{ read?: boolean; value?: { step?: number; sessionIds?: string[]; sources?: Source[]; picked?: string[] } | null }>({})
  if (!savedRef.current.read) {
    savedRef.current.read = true
    try { savedRef.current.value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') } catch { savedRef.current.value = null }
  }

  // Persist progress so a reload resumes the same step (tab switches keep the component mounted).
  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step, sessionIds, sources, picked })) } catch { /* ignore */ }
  }, [step, sessionIds, sources, picked])

  useEffect(() => {
    // Only resume a saved session that the server still knows about.
    const saved = savedRef.current.value
    const resumable = Boolean(saved?.sessionIds?.length)
    api.targets().then(({ targets, default: fallback, demoRepoPath }) => {
      setTargets(targets)
      setRepoPath(demoRepoPath)
      if (demoRepoPath && !resumable) { setSources([{ key: 'acme/notes-api', label: 'acme/notes-api', path: demoRepoPath }]) }
    }).catch(() => {})
    api.health().then(result => setConfigured(result.configured)).catch(() => {})
    api.runs().then(result => {
      setRuns(result.runs)
      if (resumable && saved) {
        const known = new Set(result.runs.map(run => run.runId))
        if (saved.sessionIds!.some(id => known.has(id))) {
          restored.current = true
          setSessionIds(saved.sessionIds!)
          setStep(saved.step || 0)
          if (Array.isArray(saved.sources)) setSources(saved.sources)
          if (Array.isArray(saved.picked)) setPicked(saved.picked)
          return
        }
      }
      // Nothing to resume: open on the most recent run so the workspace shows real results.
      const groups = new Map<string, RunSummary[]>()
      for (const run of result.runs) {
        if (run.status === 'cleaned') continue
        const key = run.runId.replace(/-\d+$/, '')
        groups.set(key, [...(groups.get(key) || []), run])
      }
      let newest: RunSummary[] = []
      for (const list of groups.values()) {
        const stamp = list.map(run => run.startedAt || '').sort().pop() || ''
        const best = newest.map(run => run.startedAt || '').sort().pop() || ''
        if (!newest.length || stamp > best) newest = list
      }
      if (newest.length) {
        restored.current = true
        setSessionIds(newest.map(run => run.runId))
        setStep(newest.some(run => run.status === 'retested') ? 4 : newest.some(run => run.findings?.length) ? 2 : 1)
      }
    }).catch(() => {})
    const stopLogs = openLogStream(line => setLogs(current => [...current.slice(-250), line]))
    return () => { stopLogs() }
  }, [])

  useEffect(() => { if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight }, [logs, step])

  const connected = Object.values(configured).filter(Boolean).length
  const sessionRuns = runs.filter(run => sessionIds.includes(run.runId))
  const presets = targets.filter(target => !sources.some(source => source.targetApp === target.id))
  const githubRepos = ['acme/notes-api', 'acme/storefront', 'acme/billing-worker']

  async function refreshRuns() {
    try { const result = await api.runs(); setRuns(result.runs) } catch { /* keep last */ }
  }
  function addSource(source: Source) { setSources(current => current.some(item => item.key === source.key) ? current : [...current, source]) }
  function removeSource(key: string) { setSources(current => current.filter(item => item.key !== key)) }
  function pickGithub(full: string) { addSource({ key: full, label: full, path: repoPath ?? undefined, targetApp: repoPath ? undefined : 'juice-shop' }); setGithubOpen(false) }
  async function openPicker() {
    setPickerOpen(true)
    try { setBrowse(await api.fsDirs()) } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)) }
  }
  async function browseTo(path: string) {
    try { setBrowse(await api.fsDirs(path)) } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)) }
  }
  function addFolder(path: string) {
    const label = path.split('/').filter(Boolean).pop() || path
    addSource({ key: path, label, path })
    setPickerOpen(false)
  }

  function buildEntries(): RunEntry[] {
    const base: RunEntry[] = sources.map(source => source.path ? { path: source.path, label: source.label } : { targetApp: source.targetApp, label: source.label })
    const entries = [...base]
    let n = 1
    while (entries.length < 3 && base.length) {
      const src = base[entries.length % base.length]
      entries.push({ ...src, label: `${src.label} · ${++n}` })
    }
    return entries.slice(0, 6)
  }

  async function startProvision() {
    setBusy('provision'); setError('')
    try {
      const entries = buildEntries()
      const { runs: created } = await api.provisionMany(entries)
      setRuns(created)
      setSessionIds(created.map(run => run.runId))
      await Promise.allSettled(created.map(run => api.runStep(run.runId, 'scan')))
      await refreshRuns()
      for (const run of created) { try { await api.runStep(run.runId, 'verify') } catch { /* recorded in state */ } await refreshRuns() }
      setRuns((await api.runs()).runs)
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem); setError(text); onToast(text)
    } finally { setBusy(null); refreshRuns() }
  }

  async function startFix() {
    setBusy('fix'); setError('')
    try {
      for (const id of sessionRuns.map(run => run.runId)) {
        for (const stepName of ['propose', 'apply-fix', 'retest', 'memory', 'trace']) {
          try { await api.runStep(id, stepName) } catch { /* recorded in state */ }
          await refreshRuns()
        }
      }
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem); setError(text); onToast(text)
    } finally { setBusy(null); refreshRuns() }
  }

  async function reset() {
    setBusy('reset')
    try { await api.cleanupAll() } catch { /* ignore */ }
    setRuns([]); setPicked([]); pickedInit.current = false; restored.current = false; setError(''); setBusy(null); setStep(0); setSessionIds([])
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }

  const rows: Row[] = useMemo(() => {
    const map = new Map<string, Row>()
    for (const run of sessionRuns) for (const finding of run.findings) {
      const key = `${finding.pluginId}::${finding.endpoint}`
      const existing = map.get(key)
      if (existing) {
        existing.count += 1
        if (finding.status === 'Confirmed') { existing.confirmed = true; existing.finding = finding }
      } else {
        map.set(key, { key, title: finding.title, severity: finding.severity, endpoint: finding.endpoint, pluginId: finding.pluginId, confirmed: finding.status === 'Confirmed', fixable: isFixable(finding), count: 1, finding })
      }
    }
    return [...map.values()].sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.title.localeCompare(b.title))
  }, [sessionRuns])

  const counts = rows.reduce((acc, row) => { acc[row.severity] = (acc[row.severity] || 0) + 1; return acc }, {} as Record<string, number>)
  const fixableRows = rows.filter(row => row.fixable)

  useEffect(() => {
    if (step >= 2 && !pickedInit.current) { pickedInit.current = true; setPicked(fixableRows.map(row => row.key)) }
  }, [step, fixableRows])

  const verifyRunState = sessionRuns.find(run => run.verification?.confirmed) || sessionRuns.find(run => run.verification) || null
  const retestRunState = sessionRuns.find(run => run.retest) || null
  const wasConfirmed = Boolean(verifyRunState?.verification?.confirmed)
  const blockedAfter = Boolean(retestRunState?.retest?.blocked)
  const verifyEvidence = verifyRunState?.verification?.evidence || null
  const retestEvidence = retestRunState?.retest?.evidence || null
  const browserRun = sessionRuns.find(run => run.verification?.viewerUrl || run.retest?.viewerUrl) || null
  const proofUrl = verifyRunState?.verification?.viewerUrl || retestRunState?.retest?.viewerUrl || null
  const proposal = parseProposal(sessionRuns.find(run => run.proposal)?.proposal)
  const memoryRun = [...sessionRuns].reverse().find(run => run.memory)
  const traceRun = [...sessionRuns].reverse().find(run => run.trace)
  const verifyProof = sessionRuns.map(run => run.proofs?.verify).find(Boolean) || null
  const retestProof = sessionRuns.map(run => run.proofs?.retest).find(Boolean) || null
  const traceSpans = traceRun?.trace?.spans || []
  const traceId = traceRun?.trace?.traceId || null
  const memoryRecord = memoryRun?.memory?.record || null
  const runLogs = (id: string) => logs.filter(line => (line as any).runId === id).slice(-40)
  const spanMs = (span: { startTime: string | null; endTime: string | null }) => {
    if (!span.startTime || !span.endTime) return null
    const value = new Date(span.endTime).getTime() - new Date(span.startTime).getTime()
    return Number.isFinite(value) ? value : null
  }
  const duration = (ms: number | null) => ms === null ? '—' : ms < 1 ? '<1 ms' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
  // Waterfall geometry: position each span within the whole run window.
  const traceWindow = (() => {
    const starts = traceSpans.map(span => new Date(span.startTime || '').getTime()).filter(Number.isFinite)
    const ends = traceSpans.map(span => new Date(span.endTime || '').getTime()).filter(Number.isFinite)
    if (!starts.length || !ends.length) return null
    const start = Math.min(...starts)
    return { start, span: Math.max(Math.max(...ends) - start, 1) }
  })()
  async function copyTrace() {
    if (!traceId) return
    try { await navigator.clipboard.writeText(traceId); setCopied('trace'); setTimeout(() => setCopied(''), 1800) } catch { /* ignore */ }
  }

  function next() {
    if (step === 0) { if (!sources.length) return; setStep(1); startProvision(); return }
    if (step === 1) { if (busy === 'provision') return; setStep(2); return }
    if (step === 2) { if (!picked.length) return; setStep(3); startFix(); return }
    if (step === 3) { if (busy === 'fix') return; setStep(4); return }
  }
  const nextDisabled = (step === 0 && !sources.length) || (step === 1 && busy === 'provision') || (step === 2 && !picked.length) || (step === 3 && busy === 'fix') || step === 4
  const nextLabel = step === 0 ? 'Run tests' : step === 1 ? (busy === 'provision' ? 'Working…' : 'Next') : step === 2 ? `Fix ${picked.length} issue${picked.length === 1 ? '' : 's'}` : step === 3 ? (busy === 'fix' ? 'Working…' : 'Next') : 'Done'

  const stagePill = (key: keyof RunStages, label: string, Icon: ComponentType<{ size?: number }>, stages?: RunStages) => {
    const state = stages?.[key] || 'pending'
    return <span key={key} className={`lr-stage ${state}`}><Icon size={12} />{label}</span>
  }

  return <div className="wizard">
    <ol className="wiz-rail" aria-label="Steps">
      {STEPS.map((item, index) => <li key={item.label} className={index === step ? 'active' : index < step ? 'done' : ''}>
        <button disabled={index > step} onClick={() => index < step && setStep(index)}>
          <span className="wiz-num">{index < step ? <CheckCircle size={15} weight="fill" /> : index + 1}</span>
          <span className="wiz-copy"><strong>{item.label}</strong><small>{item.hint}</small></span>
        </button>
      </li>)}
    </ol>

    <section className="surface wiz-panel">
      {step === 0 && <div className="wiz-body ov">
        <h1 className="ov-title">Test a repository</h1>
        <div className="ov-options">
          <article className="ov-card">
            <GithubLogo size={34} className="ov-icon github" />
            <h3>GitHub</h3>
            <p>Connect your account and choose a repository.</p>
            {githubOpen ? <div className="ov-repos">
              {githubRepos.map(full => <button key={full} onClick={() => pickGithub(full)}><GitBranch size={14} />{full}<Plus size={13} /></button>)}
            </div> : <button className="button primary" onClick={() => setGithubOpen(true)}><GithubLogo size={17} />Log in with GitHub</button>}
          </article>
          <article className="ov-card">
            <FolderSimple size={30} weight="duotone" className="ov-icon" />
            <h3>Local folder</h3>
            <p>Pick a repository on this machine.</p>
            <button className="button" onClick={openPicker}><FolderSimple size={15} />Choose folder…</button>
          </article>
        </div>

        {sources.length > 0 && <div className="ov-selected">
          <span className="eyebrow">SELECTED</span>
          {sources.map(source => <span key={source.key} className="lr-chip">
            {source.path ? <FolderSimple size={13} /> : <Cube size={13} />}{source.label}
            <button aria-label={`Remove ${source.label}`} onClick={() => removeSource(source.key)}><X size={12} /></button>
          </span>)}
        </div>}

        {presets.length > 0 && <div className="ov-presets">
          <span>Try a sample target</span>
          {presets.map(target => <button key={target.id} className="lr-mini" onClick={() => addSource({ key: target.id, label: target.label, targetApp: target.id })}><Plus size={12} />{target.label}</button>)}
        </div>}

        {pickerOpen && <div className="lr-browse">
          <div className="lr-browse-path">
            <button className="lr-mini" onClick={() => browse?.parent && browseTo(browse.parent)} disabled={!browse?.parent}><ArrowUp size={12} />Up</button>
            <code>{browse?.path || '…'}</code>
            <button className="lr-mini primary" onClick={() => browse && addFolder(browse.path)} disabled={!browse}>Use this folder</button>
            <button className="lr-mini" onClick={() => setPickerOpen(false)}>Cancel</button>
          </div>
          <div className="lr-browse-list">
            {browse?.dirs.map(dir => <button key={dir.path} onClick={() => browseTo(dir.path)}><FolderSimple size={13} />{dir.name}</button>)}
            {browse && !browse.dirs.length && <span className="lr-browse-empty">No sub-folders here.</span>}
          </div>
        </div>}
      </div>}

      {step === 1 && <div className="wiz-body">
        <div className="wiz-head"><h2>Agents</h2><span>{sessionRuns.length} sandbox{sessionRuns.length === 1 ? '' : 'es'} · {busy === 'provision' ? 'running' : 'idle'}</span></div>
        <div className="lr-wall">
          {sessionRuns.map(run => {
            const sandboxId = run.sandboxes?.[0]?.id || run.runId
            return <article key={run.runId} className={`lr-card ${run.status}`}>
              <header><div><strong>{run.label}</strong><span className={`lr-badge ${run.status}`}>{run.status}</span></div></header>
              <div className="lr-card-meta"><code>{String(sandboxId).slice(0, 12)}</code><span>{run.target?.version || 'starting'}</span></div>
              <div className="lr-timeline">{STAGES.map(([key, label, Icon]) => stagePill(key, label, Icon, run.stages))}</div>
              <div className="wiz-mini-term">
                {runLogs(run.runId).map((line, index) => <div key={index} className={`terminal-line ${line.tone || ''}`}>{line.text}</div>)}
                {!runLogs(run.runId).length && <span className="terminal-prompt">› <span className="terminal-cursor" /></span>}
              </div>
              <footer><span className="lr-card-stat"><WarningCircle size={12} />{run.findings.length} issues</span>{run.findings.some(f => f.status === 'Confirmed') && <span className="lr-chip-ok"><CheckCircle size={12} weight="fill" />confirmed</span>}</footer>
              {run.error && <div className="lr-card-error"><WarningCircle size={12} />{run.error}</div>}
            </article>
          })}
          {!sessionRuns.length && <p className="lr-empty">Starting sandboxes…</p>}
        </div>

        <div className="wiz-browser">
          <div className="wiz-browser-head"><Browser size={15} weight="bold" />Anchor Browser{browserRun && <span>{browserRun.label}</span>}</div>
          {verifyProof
            ? <div className="wiz-browser-body">
              <figure className="wiz-frame"><img src={verifyProof} alt="Captured frame from the Anchor browser session" /><figcaption>Captured from the live session</figcaption></figure>
              {proofUrl && <a className="wiz-session-link" href={proofUrl} target="_blank" rel="noreferrer">Open live session<ArrowSquareOut size={11} /></a>}
            </div>
            : browserRun?.verification?.viewerUrl
              ? <div className="wiz-anchor"><iframe title="Anchor Browser live session" src={browserRun.verification.viewerUrl} /><a href={browserRun.verification.viewerUrl} target="_blank" rel="noreferrer">Open in a new tab<ArrowSquareOut size={11} /></a></div>
              : <div className="wiz-browser-empty"><Browser size={22} weight="duotone" /><span>Live browser session appears here while agents verify.</span></div>}
        </div>
      </div>}

      {step === 2 && <div className="wiz-body">
        <div className="wiz-head"><h2>Issues</h2><span>{rows.length} unique · {counts.High || 0} High · {fixableRows.length} auto-fixable</span></div>
        <div className="lr-counts">{['High', 'Medium', 'Low'].map(level => <span key={level} className={`severity ${level.toLowerCase()}`}><WarningCircle size={12} />{counts[level] || 0} {level}</span>)}</div>
        <div className="table-scroll">
          <table className="data-table wiz-table">
            <thead><tr><th className="wiz-check" /><th>Issue</th><th>Severity</th><th>Endpoint</th><th>Status</th><th>Fix</th></tr></thead>
            <tbody>
              {rows.map(row => {
                const checked = picked.includes(row.key)
                return <tr key={row.key} className={checked ? 'selected' : ''}>
                  <td className="wiz-check">{row.fixable
                    ? <input type="checkbox" checked={checked} aria-label={`Fix ${row.title}`} onChange={() => setPicked(current => current.includes(row.key) ? current.filter(k => k !== row.key) : [...current, row.key])} />
                    : <span className="wiz-dash">—</span>}</td>
                  <td><strong className="wiz-finding-title">{row.title}</strong>{row.count > 1 && <span className="table-subtext">in {row.count} sandboxes</span>}</td>
                  <td><span className={`severity ${row.severity.toLowerCase()}`}><WarningCircle size={12} />{row.severity}</span></td>
                  <td><code className="wiz-endpoint">{row.endpoint}</code></td>
                  <td><span className={`lr-finding-state ${row.confirmed ? 'confirmed' : ''}`}>{row.confirmed ? <CheckCircle size={12} weight="fill" /> : null}{row.confirmed ? 'Confirmed' : 'Needs verification'}</span></td>
                  <td>{row.fixable ? <span className="wiz-tag fix">Auto-fix</span> : <span className="wiz-tag">Manual</span>}</td>
                </tr>
              })}
            </tbody>
          </table>
        </div>
        {!rows.length && <p className="lr-empty">No issues found.</p>}
      </div>}

      {step === 3 && <div className="wiz-body">
        <div className="wiz-head"><h2>Fix &amp; verify</h2><span>{busy === 'fix' ? 'running' : 'idle'}</span></div>
        <div className="wiz-fix-grid">
          <div className="wiz-fix-col">
            <h3><PlugsConnected size={15} />Coding agent · Bedrock</h3>
            {proposal ? <>
              <p className="wiz-fix-summary">{proposal.summary || 'Proposed the smallest source change.'}</p>
              {proposal.patchProposal && <pre className="record-code">{proposal.patchProposal}</pre>}
            </> : <p className="lr-empty">{busy === 'fix' ? 'Proposing a repair…' : 'No proposal yet.'}</p>}
          </div>
          <div className="wiz-fix-col">
            <h3><Browser size={15} />Anchor Browser · captured evidence</h3>
            {(verifyProof || retestProof) ? <div className="wiz-frames">
              {verifyProof && <figure className="wiz-frame"><img src={verifyProof} alt="Captured browser frame before the fix" /><figcaption>Before · exploit replayed</figcaption></figure>}
              {retestProof && <figure className="wiz-frame"><img src={retestProof} alt="Captured browser frame after the fix" /><figcaption>After · attack blocked</figcaption></figure>}
            </div> : <p className="lr-empty">{busy === 'fix' ? 'Replaying the exploit in a live session…' : 'No captured session yet.'}</p>}
            {proofUrl && <a className="wiz-session-link" href={proofUrl} target="_blank" rel="noreferrer">Open live session<ArrowSquareOut size={11} /></a>}
          </div>
        </div>
        <div className="wiz-beforeafter">
          <div className={`wiz-ba before ${wasConfirmed ? 'hit' : ''}`}><span>Before</span><strong>{wasConfirmed ? 'Exploitable' : 'Not confirmed'}</strong><small>{wasConfirmed ? `Alert "${verifyEvidence?.expectedDialog}" observed in the live session` : 'No exploit observed.'}</small></div>
          <ArrowRight size={16} />
          <div className={`wiz-ba after ${blockedAfter ? 'safe' : ''}`}><span>After</span><strong>{blockedAfter ? 'Blocked' : 'Pending'}</strong><small>{blockedAfter ? `HTTP ${retestEvidence?.attackStatus ?? 200} · no dialog · search still works` : 'Waiting for the re-test.'}</small></div>
        </div>
      </div>}

      {step === 4 && <div className="wiz-body">
        <div className="wiz-head"><h2>Report</h2><span>{sessionRuns.length} sandbox{sessionRuns.length === 1 ? '' : 'es'}</span></div>
        <div className="wiz-metrics">
          <div><span>Sandboxes</span><strong>{sessionRuns.length}</strong></div>
          <div><span>Issues</span><strong>{rows.length}</strong></div>
          <div><span>Fixed</span><strong>{picked.length}</strong></div>
          <div><span>Version</span><strong>{sessionRuns.find(run => run.target?.version)?.target?.version || '—'}</strong></div>
        </div>
        <div className="wiz-report">
          <article className={wasConfirmed && blockedAfter ? 'on' : ''}>
            <span className="wiz-report-head"><Browser size={14} />Anchor Browser</span>
            <strong>{blockedAfter ? 'Fix proven' : wasConfirmed ? 'Exploit proven' : 'No proof'}</strong>
            <small>{wasConfirmed ? `Exploitable before the fix; ${blockedAfter ? 'blocked after.' : 're-test pending.'}` : 'No exploit observed.'}</small>
            {proofUrl && <a href={proofUrl} target="_blank" rel="noreferrer">Open session<ArrowSquareOut size={11} /></a>}
          </article>
          <article className={proposal ? 'on' : ''}>
            <span className="wiz-report-head"><PlugsConnected size={14} />Bedrock</span>
            <strong>{proposal ? 'Repair proposed' : '—'}</strong>
            <small>{proposal?.summary || 'No proposal.'}</small>
          </article>
          <article className={memoryRecord ? 'on' : ''}>
            <span className="wiz-report-head"><Database size={14} />SurrealDB</span>
            <strong>{memoryRecord ? 'Proof stored' : '—'}</strong>
            <small>{memoryRecord?.finding?.title || 'No record.'}</small>
            {memoryRun?.memory?.id && <code className="wiz-report-id">{memoryRun.memory.id.slice(0, 18)}…</code>}
          </article>
          <article className={traceRun?.trace ? 'on' : ''}>
            <span className="wiz-report-head"><ChartLine size={14} />Arize</span>
            <strong>{traceSpans.length ? `${traceSpans.length} spans sent` : '—'}</strong>
            {traceId
              ? <button type="button" className="wiz-copy" onClick={copyTrace}>{copied === 'trace' ? <CheckCircle size={11} weight="fill" /> : <Copy size={11} />}{copied === 'trace' ? 'Copied' : `trace ${traceId.slice(0, 10)}…`}</button>
              : <small>No trace.</small>}
            {(traceRun?.trace?.projectUrl || traceRun?.trace?.dashboardUrl) && <a href={traceRun.trace.projectUrl || traceRun.trace.dashboardUrl} target="_blank" rel="noreferrer">Open trace<ArrowSquareOut size={11} /></a>}
          </article>
        </div>

        <div className="wiz-evidence">
          <section className="wiz-evidence-col">
            <h3><ChartLine size={15} />Arize trace{traceRun?.trace?.project ? <span>{traceRun.trace.project}</span> : null}</h3>
            {traceSpans.length ? <div className="trace-waterfall">
              <div className="trace-axis"><span>0</span><span>{duration(traceWindow?.span ?? null)}</span></div>
              <ol className="trace-rows">{traceSpans.map(span => {
                const start = span.startTime ? new Date(span.startTime).getTime() : null
                const offset = traceWindow && start !== null ? Math.min(((start - traceWindow.start) / traceWindow.span) * 100, 99) : 0
                const width = traceWindow ? Math.max(((spanMs(span) ?? 0) / traceWindow.span) * 100, 0.8) : 1
                return <li key={span.name} className="trace-row">
                  <div className="trace-name"><strong>{span.name}</strong><span className={`wiz-span-kind ${span.kind?.toLowerCase()}`}>{span.kind}</span></div>
                  <div className="trace-track"><span className="trace-bar" style={{ left: `${offset}%`, width: `${Math.min(width, 100 - offset)}%` }} /></div>
                  <code className="trace-dur">{duration(spanMs(span))}</code>
                </li>
              })}</ol>
            </div> : <p className="lr-empty">{busy === 'fix' ? 'Sending spans to Arize…' : 'No trace sent yet.'}</p>}
          </section>
          <section className="wiz-evidence-col">
            <h3><Database size={15} />SurrealDB record</h3>
            {memoryRecord ? <dl className="wiz-record">
              <dt>Record id</dt><dd><code>{memoryRun?.memory?.id || '—'}</code></dd>
              <dt>Finding</dt><dd>{memoryRecord.finding?.title || '—'}</dd>
              <dt>Endpoint</dt><dd><code>{memoryRecord.finding?.endpoint || '—'}</code></dd>
              <dt>Valid</dt><dd>{memoryRecord.valid ? 'Yes' : 'No'}</dd>
              {Object.entries(memoryRecord.identity || {}).map(([key, value]) => <span className="wiz-record-pair" key={key}><dt>{key}</dt><dd><code>{value}</code></dd></span>)}
              <dt>Recorded</dt><dd>{memoryRecord.recordedAt ? new Date(memoryRecord.recordedAt).toLocaleString() : '—'}</dd>
            </dl> : <p className="lr-empty">{busy === 'fix' ? 'Writing the verified result…' : 'No memory recorded yet.'}</p>}
          </section>
        </div>
        <div className="wiz-log">
          <h3><TerminalWindow size={15} />Log</h3>
          <div className="terminal" ref={logBox}>{logs.slice(-120).map((line, index) => <div key={index} className={`terminal-line ${line.tone || ''}`}>[{(line as any).runLabel || line.role}] {line.text}</div>)}<span className="terminal-prompt">› <span className="terminal-cursor" /></span></div>
        </div>
      </div>}

      {error && <div className="lr-error" style={{ margin: '0 16px 16px' }}><WarningCircle size={15} />{error}</div>}
    </section>

    <footer className="wiz-foot">
      <button className="button" disabled={step === 0 || Boolean(busy)} onClick={() => setStep(s => Math.max(0, s - 1))}><ArrowLeft size={14} />Back</button>
      <span className="wiz-foot-note">{connected}/5 services</span>
      {step === 4
        ? <button className="button primary" disabled={Boolean(busy)} onClick={reset}>{busy === 'reset' ? <CircleNotch size={14} className="lr-spin" /> : <Broom size={14} />}Run again</button>
        : <button className="button primary" disabled={nextDisabled} onClick={next}>{busy ? <CircleNotch size={14} className="lr-spin" /> : <Play size={13} weight="fill" />}{nextLabel}<CaretRight size={13} /></button>}
    </footer>
  </div>
}
