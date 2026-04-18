const path = require('path')
const fs = require('fs')

const serverRoot = path.join(__dirname, '..')
require('dotenv').config({ path: path.join(serverRoot, '.env') })

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
if (credPath && !path.isAbsolute(credPath)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(
    serverRoot,
    credPath,
  )
}

/**
 * If credentials are not set, use the first *.json in server/ that looks like
 * a Google service account (so dropping the key file in this folder "just works").
 */
function discoverServiceAccountFile() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return

  const skip = new Set(['package.json', 'package-lock.json'])
  let chosen = null
  for (const name of fs.readdirSync(serverRoot)) {
    if (!name.endsWith('.json') || skip.has(name)) continue
    const full = path.join(serverRoot, name)
    try {
      const j = JSON.parse(fs.readFileSync(full, 'utf8'))
      if (
        j &&
        j.type === 'service_account' &&
        typeof j.client_email === 'string' &&
        typeof j.private_key === 'string'
      ) {
        chosen = full
        break
      }
    } catch {
      // not JSON or unreadable
    }
  }
  if (chosen) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = chosen
    console.info(`Using Google credentials file: ${path.basename(chosen)}`)
  }
}

discoverServiceAccountFile()

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const cookieParser = require('cookie-parser')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')

const {
  teamSubmissionSchema,
  loginSchema,
  entryLookupSchema,
} = require('./schemas')
const { upsertSubmission, getSubmissionForKeys } = require('./sheets')

const PORT = Number(process.env.PORT || 3001)
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').trim()
const FORM_ACCESS_KEY = (process.env.FORM_ACCESS_KEY || '').trim()
const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim()
const SPREADSHEET_ID = (process.env.SPREADSHEET_ID || '').trim()
const SHEET_NAME = (process.env.SHEET_NAME || 'Submissions').trim()
const COOKIE_SAMESITE_RAW = (process.env.SESSION_COOKIE_SAMESITE || 'lax').trim().toLowerCase()
const COOKIE_SECURE_RAW = (process.env.SESSION_COOKIE_SECURE || '').trim().toLowerCase()

const SESSION_COOKIE = 'gdg_form_session'
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ALLOWED_ORIGINS = CLIENT_ORIGIN
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean)

const COOKIE_SAMESITE = ['strict', 'lax', 'none'].includes(COOKIE_SAMESITE_RAW)
  ? COOKIE_SAMESITE_RAW
  : 'lax'

const COOKIE_SECURE =
  COOKIE_SECURE_RAW === 'true'
    ? true
    : COOKIE_SECURE_RAW === 'false'
      ? false
      : process.env.NODE_ENV === 'production'

function corsOrigin(origin, callback) {
  // Allow server-to-server requests and same-origin browser requests without Origin header.
  if (!origin) return callback(null, true)
  if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
  return callback(new Error('Origin not allowed by CORS'))
}

function assertEnv() {
  const missing = []
  if (!FORM_ACCESS_KEY || FORM_ACCESS_KEY.length < 8) {
    missing.push('FORM_ACCESS_KEY (min 8 chars)')
  }
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    missing.push('SESSION_SECRET (min 32 chars)')
  }
  const hasJson = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const hasPath = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  if (!hasJson && !hasPath) {
    missing.push(
      'GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS',
    )
  }
  if (missing.length) {
    console.error('Missing or invalid environment:', missing.join(', '))
    process.exit(1)
  }
  if (!SPREADSHEET_ID) {
    console.warn(
      'SPREADSHEET_ID is not set — add it to server/.env (sheet routes return 503 until then).',
    )
  }
}

function requireSpreadsheet(req, res, next) {
  if (!SPREADSHEET_ID) {
    return res.status(503).json({
      error:
        'Server is missing SPREADSHEET_ID. Add it to server/.env (spreadsheet id from the Google Sheets URL).',
    })
  }
  next()
}

function spreadsheetErrorPayload(err) {
  const g = err?.response?.data?.error
  const status = err?.response?.status
  const detail = g?.message
    ? `${g.message}${status ? ` (HTTP ${status})` : ''}`
    : err?.message || String(err)
  return { error: 'Spreadsheet request failed', detail }
}

function signSession() {
  return jwt.sign({ v: 1 }, SESSION_SECRET, { expiresIn: SESSION_MAX_AGE_MS / 1000 })
}

function readBearerToken(req) {
  const auth = req.headers?.authorization
  if (!auth || typeof auth !== 'string') return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

function readSession(req) {
  const token = readBearerToken(req) || req.cookies?.[SESSION_COOKIE]
  if (!token) return { session: null, reason: 'missing-token' }
  try {
    return { session: jwt.verify(token, SESSION_SECRET), reason: null }
  } catch (err) {
    return { session: null, reason: err?.name || 'invalid-token' }
  }
}

function requireSession(req, res, next) {
  const { session, reason } = readSession(req)
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized', reason })
  }
  next()
}

function createApp() {
  const app = express()
  app.set('trust proxy', 1)

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  )
  app.use(
    cors({
      origin: corsOrigin,
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '48kb' }))
  app.use(cookieParser())

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, try again later.' },
  })

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    }
    if (parsed.data.accessKey !== FORM_ACCESS_KEY) {
      return res.status(401).json({ error: 'Invalid access key' })
    }
    const token = signSession()
    const secure = COOKIE_SAMESITE === 'none' ? true : COOKIE_SECURE
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: COOKIE_SAMESITE,
      secure,
      maxAge: SESSION_MAX_AGE_MS,
      path: '/',
    })
    return res.json({ ok: true, sessionToken: token })
  })

  app.post('/api/auth/logout', (_req, res) => {
    const secure = COOKIE_SAMESITE === 'none' ? true : COOKIE_SECURE
    res.clearCookie(SESSION_COOKIE, {
      path: '/',
      sameSite: COOKIE_SAMESITE,
      secure,
    })
    res.json({ ok: true })
  })

  app.get('/api/auth/me', (req, res) => {
    const { session, reason } = readSession(req)
    res.json({ authenticated: Boolean(session), reason: session ? null : reason })
  })

  app.use('/api', apiLimiter)

  app.get('/api/team/entry', requireSession, requireSpreadsheet, async (req, res) => {
    const parsed = entryLookupSchema.safeParse({
      teamName: req.query.teamName,
      leaderContact: req.query.leaderContact,
    })
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    try {
      const entry = await getSubmissionForKeys(
        SPREADSHEET_ID,
        SHEET_NAME,
        parsed.data.teamName,
        parsed.data.leaderContact,
      )
      if (!entry) {
        return res.status(404).json({ error: 'No submission found for this team and contact' })
      }
      return res.json({ entry })
    } catch (err) {
      console.error(err)
      const { error, detail } = spreadsheetErrorPayload(err)
      return res.status(502).json({ error, detail })
    }
  })

  app.post('/api/team/submit', requireSession, requireSpreadsheet, async (req, res) => {
    const parsed = teamSubmissionSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid submission', details: parsed.error.flatten() })
    }
    try {
      const result = await upsertSubmission(
        SPREADSHEET_ID,
        SHEET_NAME,
        parsed.data,
      )
      return res.json({
        ok: true,
        mode: result.mode,
        rowIndex: result.rowIndex1Based ?? null,
      })
    } catch (err) {
      console.error(err)
      const { error, detail } = spreadsheetErrorPayload(err)
      return res.status(502).json({ error, detail })
    }
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  return app
}

assertEnv()
const app = createApp()
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`)
  console.log(`Loaded env from ${path.join(serverRoot, '.env')}`)
  console.log(`CORS origins: ${ALLOWED_ORIGINS.join(', ') || '(none)'}`)
  console.log(`Session cookie: sameSite=${COOKIE_SAMESITE}, secure=${COOKIE_SAMESITE === 'none' ? true : COOKIE_SECURE}`)
})
