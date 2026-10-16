import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, NavLink, Link, Route, Routes, useLocation } from 'react-router-dom'
import { StackSimple, Bug, Database, PlugsConnected, SquaresFour, CaretDown, CheckCircle, Broadcast, X, Question } from '@phosphor-icons/react'
import LiveWizard from './components/LiveWizard'
import { FindingsPage, MemoryPage, IntegrationsPage } from './components/Pages'
import { api } from './api'

export function App() { return <BrowserRouter><Platform /></BrowserRouter> }

const TABS = [
  { to: '/', label: 'Overview' },
  { to: '/findings', label: 'Issues' },
  { to: '/memory', label: 'Memory' },
  { to: '/integrations', label: 'Integrations' },
]

function Platform() {
  const location = useLocation()
  const [toast, setToast] = useState('')
  const [orgOpen, setOrgOpen] = useState(false)
  const [help, setHelp] = useState(false)
  const [configured, setConfigured] = useState<Record<string, boolean>>({})
  const dialog = useRef<HTMLDialogElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connected = Object.values(configured).filter(Boolean).length

  function notify(message: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(''), 3800)
  }

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])
  useEffect(() => { api.health().then(result => setConfigured(result.configured)).catch(() => {}) }, [])
  useEffect(() => { if (help) dialog.current?.showModal(); else dialog.current?.close() }, [help])
  useEffect(() => { setOrgOpen(false); window.scrollTo(0, 0) }, [location.pathname])

  return <div className="app-shell">
    <aside className="sidebar">
      <Link className="brand" to="/" aria-label="Home"><StackSimple size={27} weight="fill" /><span>Pentests</span></Link>
      <div className="workspace-switcher">
        <button className="workspace-button" onClick={() => setOrgOpen(!orgOpen)} aria-expanded={orgOpen}>Acme Workspace<CaretDown size={13} /></button>
        {orgOpen && <div className="workspace-menu"><CheckCircle size={15} />Acme Workspace<span>{connected}/5 services</span></div>}
      </div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><SquaresFour size={18} /><span>Overview</span></NavLink>
        <NavLink to="/findings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Bug size={18} /><span>Issues</span></NavLink>
        <NavLink to="/memory" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Database size={18} /><span>Memory</span></NavLink>
        <NavLink to="/integrations" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><PlugsConnected size={18} /><span>Integrations</span></NavLink>
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-context"><span className={`status-dot ${connected ? '' : 'muted'}`} /><span>{connected}/5 connected</span></div>
        <button className="nav-item" onClick={() => setHelp(true)}><Question size={18} /><span>Help</span></button>
      </div>
    </aside>

    <div className="app-main">
      <div className="global-bar">
        <div className="breadcrumbs"><span className="team-label">Acme Workspace<CaretDown size={11} /></span></div>
        <div className="global-actions"><span className="preview-badge live-badge"><Broadcast size={13} weight="bold" />{connected}/5 live</span><span className="avatar" title="Acme Workspace">AW</span></div>
      </div>

      <header className="run-header slim">
        <nav className="page-tabs" aria-label="Views">
          {TABS.map(tab => <NavLink key={tab.to} to={tab.to} end={tab.to === '/'} className={({ isActive }) => isActive ? 'active' : ''}>{tab.label}</NavLink>)}
        </nav>
      </header>

      {/* Keep the wizard mounted across route changes so its progress survives tab switches. */}
      <div hidden={location.pathname !== '/'}>
        <LiveWizard onToast={notify} />
      </div>

      <Routes>
        <Route path="/" element={null} />
        <Route path="/findings" element={<FindingsPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="*" element={<div className="empty-state"><h1>Page not found</h1><Link className="button" to="/">Back to overview</Link></div>} />
      </Routes>
    </div>

    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite"><CheckCircle size={17} />{toast}<button className="icon-button" aria-label="Dismiss" onClick={() => setToast('')}><X size={14} /></button></div>

    <dialog ref={dialog} className="app-dialog" onCancel={() => setHelp(false)} aria-labelledby="help-title">
      <div className="dialog-header"><h2 id="help-title">Help</h2><button className="icon-button" aria-label="Close" onClick={() => setHelp(false)}><X size={20} /></button></div>
      <dl className="guide-list">
        <dt>Overview</dt><dd>Connect a GitHub repository or pick a local folder.</dd>
        <dt>Agents</dt><dd>Run the tests and watch each service work.</dd>
        <dt>Issues</dt><dd>Review what was found and open the evidence.</dd>
        <dt>Fix &amp; verify</dt><dd>Apply the coding-agent repair and re-test it.</dd>
        <dt>Report</dt><dd>The captured proof and trace.</dd>
      </dl>
      <button className="button primary" onClick={() => setHelp(false)}>Close</button>
    </dialog>
  </div>
}
