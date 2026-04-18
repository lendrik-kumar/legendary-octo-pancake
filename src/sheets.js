const { google } = require('googleapis')

const HEADER_ROW = [
  'Created At',
  'Team Name',
  'Leader Name',
  'Leader Contact',
  'GitHub',
  'PPT',
  'Deployed',
  'Updated At',
]

function normalizeTeamKey(teamName) {
  return teamName.trim().toLowerCase()
}

function normalizePhoneKey(contact) {
  return contact.replace(/\D/g, '')
}

function buildGoogleAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS

  if (json) {
    const credentials = JSON.parse(json)
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
  }

  if (keyFile) {
    return new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
  }

  throw new Error(
    'Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS',
  )
}

let cachedClient = null
function getSheetsClient() {
  if (!cachedClient) {
    const auth = buildGoogleAuth()
    cachedClient = google.sheets({ version: 'v4', auth })
  }
  return cachedClient
}

function sheetRange(sheetName, a1) {
  const safe = sheetName.includes(' ')
    ? `'${sheetName.replace(/'/g, "''")}'`
    : sheetName
  return `${safe}!${a1}`
}

function isDuplicateSheetTabError(err) {
  const msg = err?.response?.data?.error?.message || ''
  return /already exists|duplicate sheet title/i.test(msg)
}

/**
 * Creates the tab if it is missing (common misconfig: SHEET_NAME does not exist).
 */
async function ensureSheetTab(spreadsheetId, sheetTitle) {
  const sheets = getSheetsClient()
  const { data } = await sheets.spreadsheets.get({ spreadsheetId })
  const titles = (data.sheets || [])
    .map((s) => s.properties?.title)
    .filter(Boolean)
  if (titles.includes(sheetTitle)) return

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetTitle } } }],
      },
    })
  } catch (err) {
    if (isDuplicateSheetTabError(err)) return
    throw err
  }
}

async function readValues(spreadsheetId, sheetName) {
  const sheets = getSheetsClient()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(sheetName, 'A1:H5000'),
  })
  return res.data.values || []
}

async function ensureHeaders(spreadsheetId, sheetName) {
  await ensureSheetTab(spreadsheetId, sheetName)
  const rows = await readValues(spreadsheetId, sheetName)
  if (rows.length > 0) return
  const sheets = getSheetsClient()
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange(sheetName, 'A1:H1'),
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER_ROW] },
  })
}

/**
 * @returns {{ rowIndex1Based: number | null, row: string[] | null }}
 */
function findLatestMatchingRow(values, teamName, leaderContact) {
  const tk = normalizeTeamKey(teamName)
  const pk = normalizePhoneKey(leaderContact)
  if (!tk || !pk) return { rowIndex1Based: null, row: null }

  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i] || []
    const [, rTeam, , rContact] = row
    if (!rTeam || !rContact) continue
    if (
      normalizeTeamKey(String(rTeam)) === tk &&
      normalizePhoneKey(String(rContact)) === pk
    ) {
      return { rowIndex1Based: i + 1, row }
    }
  }
  return { rowIndex1Based: null, row: null }
}

function rowToSubmission(row) {
  if (!row || row.length < 7) return null
  return {
    createdAt: row[0] || '',
    teamName: row[1] || '',
    leaderName: row[2] || '',
    leaderContact: row[3] || '',
    githubLink: row[4] || '',
    pptLink: row[5] || '',
    deployedLink: row[6] || '',
    updatedAt: row[7] || '',
  }
}

async function appendSubmission(spreadsheetId, sheetName, payload) {
  const sheets = getSheetsClient()
  const now = new Date().toISOString()
  const row = [
    now,
    payload.teamName,
    payload.leaderName,
    payload.leaderContact,
    payload.githubLink,
    payload.pptLink,
    payload.deployedLink,
    now,
  ]
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetRange(sheetName, 'A:H'),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  })
}

async function updateSubmission(
  spreadsheetId,
  sheetName,
  rowIndex1Based,
  payload,
  preserveCreatedAt,
) {
  const sheets = getSheetsClient()
  const now = new Date().toISOString()
  const row = [
    preserveCreatedAt || now,
    payload.teamName,
    payload.leaderName,
    payload.leaderContact,
    payload.githubLink,
    payload.pptLink,
    payload.deployedLink,
    now,
  ]
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange(sheetName, `A${rowIndex1Based}:H${rowIndex1Based}`),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  })
}

async function upsertSubmission(spreadsheetId, sheetName, payload) {
  await ensureHeaders(spreadsheetId, sheetName)
  const values = await readValues(spreadsheetId, sheetName)
  const { rowIndex1Based, row } = findLatestMatchingRow(
    values,
    payload.teamName,
    payload.leaderContact,
  )

  if (rowIndex1Based && row) {
    const createdAt = row[0] || new Date().toISOString()
    await updateSubmission(
      spreadsheetId,
      sheetName,
      rowIndex1Based,
      payload,
      createdAt,
    )
    return { mode: 'updated', rowIndex1Based }
  }

  await appendSubmission(spreadsheetId, sheetName, payload)
  return { mode: 'created' }
}

async function getSubmissionForKeys(spreadsheetId, sheetName, teamName, leaderContact) {
  await ensureHeaders(spreadsheetId, sheetName)
  const values = await readValues(spreadsheetId, sheetName)
  const { row } = findLatestMatchingRow(values, teamName, leaderContact)
  return rowToSubmission(row)
}

module.exports = {
  getSheetsClient,
  upsertSubmission,
  getSubmissionForKeys,
  normalizeTeamKey,
  normalizePhoneKey,
}
