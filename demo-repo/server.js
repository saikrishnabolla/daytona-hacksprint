import express from 'express'
import { randomBytes } from 'node:crypto'

const PORT = Number(process.env.PORT || 3000)
const VERSION = '1.2.0-vulnerable'

// Demo accounts. The second account owns a note the first account should not see.
const USERS = {
  'analyst@acme.test': { password: 'demo1234', name: 'Dana Analyst', role: 'analyst' },
  'admin@acme.test': { password: 'admin123', name: 'Root Admin', role: 'admin' },
}

const NOTES = [
  { id: '1', owner: 'analyst@acme.test', title: 'Onboarding checklist', body: 'Invite the team and configure SSO for the workspace.' },
  { id: '2', owner: 'analyst@acme.test', title: 'Q3 launch plan', body: 'Roll the new dashboard out to every workspace this quarter.' },
  { id: '3', owner: 'admin@acme.test', title: 'CONFIDENTIAL — production key rotation', body: 'Rotate the production API keys every 90 days and review access.' },
]

const sessions = new Map()

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ESCAPES[char])

const STYLE = `*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#152238;font:15px system-ui,sans-serif}
a{color:#2563eb}header{border-bottom:1px solid #e2e8f0;background:#fff;padding:18px 6%;display:flex;justify-content:space-between;align-items:center}
header strong{letter-spacing:-.5px}header nav a{margin-left:16px;font-size:13px;text-decoration:none}
main{max-width:760px;margin:56px auto;padding:0 24px}.eyebrow{font-size:12px;color:#64748b}
h1{font-size:30px;letter-spacing:-1px;margin:12px 0}.intro{color:#64748b}
form.search{display:flex;gap:10px;margin:24px 0}
input{flex:1;min-width:0;padding:12px 14px;border:1px solid #cbd5e1;border-radius:5px;font:inherit}
button{padding:12px 20px;border:0;border-radius:5px;background:#2563eb;color:#fff;font:inherit;cursor:pointer}
h2{font-size:17px;margin-top:32px}.card{border:1px solid #e2e8f0;border-radius:8px;background:#fff;padding:16px;margin:12px 0}
.card.private{border-color:#fca5a5;background:#fef2f2}.card h3{margin:0 0 6px;font-size:15px}
.card p{margin:0;color:#64748b;font-size:14px}.card .meta{font-size:11px;color:#94a3b8;margin-top:8px}
.empty{color:#64748b}footer{margin-top:48px;color:#94a3b8;font-size:11px}
.notice{border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;border-radius:6px;padding:10px 12px;font-size:13px;margin:16px 0}`

function layout(body, user = null) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme Workspace</title><style>${STYLE}</style></head>
<body><header><strong>acme / workspace</strong><nav>${user ? `<span style="font-size:13px;color:#64748b">Signed in as ${escapeHtml(user.name)}</span><a href="/dashboard">Dashboard</a><a href="/logout">Sign out</a>` : '<a href="/login">Sign in</a>'}</nav></header>
<main>${body}<footer>Acme Workspace · ${VERSION}</footer></main></body></html>`
}

// Shared results renderer. The search term is echoed back without escaping.
// This is the seeded reflected XSS, reachable from both /search and /dashboard.
function resultsBlock(term, resultsHtml) {
  const termHtml = term
  return `<h2>Results for ${termHtml}</h2><section>${resultsHtml}</section>`
}

function notesHtml(notes, highlightOwner) {
  if (!notes.length) return '<p class="empty">No notes match this search.</p>'
  return notes.map(note => {
    const isPrivate = highlightOwner && note.owner !== highlightOwner
    return `<article class="card${isPrivate ? ' private' : ''}"><h3>${escapeHtml(note.title)}</h3><p>${escapeHtml(note.body)}</p><div class="meta">note #${note.id} · owner ${escapeHtml(note.owner)} · <a href="/notes/${note.id}">open</a></div></article>`
  }).join('')
}

const app = express()
app.use(express.urlencoded({ extended: false }))

function currentUser(req) {
  const sid = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('sid='))?.slice(4)
  const email = sid ? sessions.get(sid) : null
  return email ? { email, ...USERS[email] } : null
}

function requireLogin(req, res, next) {
  const user = currentUser(req)
  if (!user) return res.redirect('/login')
  req.user = user
  next()
}

app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }))

app.get('/login', (req, res) => {
  res.type('html').send(layout(`<span class="eyebrow">ACCOUNTS</span><h1>Sign in</h1><p class="intro">Use your workspace credentials.</p>
    <form class="search" method="post" action="/login"><input name="email" aria-label="Email" placeholder="you@acme.test" value="analyst@acme.test"><input name="password" type="password" aria-label="Password" placeholder="Password" value="demo1234"><button type="submit">Sign in</button></form>
    <p class="empty">Demo: analyst@acme.test / demo1234</p>`))
})

app.post('/login', (req, res) => {
  const email = String(req.body.email || '').toLowerCase()
  const account = USERS[email]
  if (!account || account.password !== String(req.body.password || '')) {
    return res.status(401).type('html').send(layout('<span class="eyebrow">ACCOUNTS</span><h1>Sign in</h1><div class="notice">Invalid email or password.</div>'))
  }
  const sid = randomBytes(16).toString('hex')
  sessions.set(sid, email)
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`)
  res.redirect('/dashboard')
})

app.get('/logout', (req, res) => {
  const sid = req.headers.cookie?.match(/sid=([a-f0-9]+)/)?.[1]
  if (sid) sessions.delete(sid)
  res.redirect('/login')
})

app.get(['/', '/search'], (req, res) => {
  const term = String(req.query.q ?? '').slice(0, 2048)
  const matches = NOTES.filter(note => note.owner === 'analyst@acme.test' && `${note.title} ${note.body}`.toLowerCase().includes(term.toLowerCase()))
  res.type('html').send(layout(`<span class="eyebrow">KNOWLEDGE BASE</span><h1>How can we help?</h1><p class="intro">Search the public help center.</p>
    <form class="search" action="/search" method="get"><input aria-label="Search articles" name="q" value="${escapeHtml(term)}" placeholder="Search articles…"><button type="submit">Search</button></form>
    ${resultsBlock(term, notesHtml(matches))}`, currentUser(req)))
})

app.get('/go', (req, res) => {
  const next = String(req.query.next || '/')
  res.redirect(next)
})

app.get('/dashboard', requireLogin, (req, res) => {
  const term = String(req.query.q ?? '').slice(0, 2048)
  const mine = NOTES.filter(note => note.owner === req.user.email)
  const matches = term ? mine.filter(note => `${note.title} ${note.body}`.toLowerCase().includes(term.toLowerCase())) : mine
  res.type('html').send(layout(`<span class="eyebrow">YOUR WORKSPACE</span><h1>Welcome back, ${escapeHtml(req.user.name)}</h1><p class="intro">${mine.length} private notes · role ${escapeHtml(req.user.role)}.</p>
    <form class="search" action="/dashboard" method="get"><input aria-label="Search notes" name="q" value="${escapeHtml(term)}" placeholder="Search your notes…"><button type="submit">Search</button></form>
    ${resultsBlock(term, notesHtml(matches, req.user.email))}`, req.user))
})

// No ownership check: any signed-in user can read any note by id.
app.get('/notes/:id', requireLogin, (req, res) => {
  const note = NOTES.find(item => item.id === req.params.id)
  if (!note) return res.status(404).type('html').send(layout('<h1>Not found</h1>', req.user))
  const foreign = note.owner !== req.user.email
  res.type('html').send(layout(`<span class="eyebrow">NOTE #${note.id}</span><h1>${escapeHtml(note.title)}</h1>
    ${foreign ? '<div class="notice">This note belongs to another account, but you can still read it.</div>' : ''}
    <article class="card"><p>${escapeHtml(note.body)}</p><div class="meta">owner ${escapeHtml(note.owner)}</div></article>
    <p><a href="/dashboard">← back to dashboard</a></p>`, req.user))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Acme Workspace ${VERSION} listening on :${PORT}`)
})
