import express from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { extractFromPdf, extractFromImage, extractFromDocx, extractFromUrl } from '../services/extractor.js'
import { extractCatalog, enrichProducts, generateProductImage } from '../services/aiAgent.js'
import { createJob, getJob, updateJob, pushLog, getJobLog, publishEvent, createSubscriber } from '../services/jobStore.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

const FOOTER_MARKERS = [
  'scopri deliveroo', 'scarica la app', '© deliveroo', '© uber',
  'termini & condizioni', 'informativa sulla privacy', 'cookie',
  'lavora con noi', 'diventa nostro partner', 'il carrello è vuoto',
  'vai al pagamento', 'assistenza clienti', 'note legali',
]
function stripFooterNoise(text) {
  const lines = text.split('\n')
  let cutAt = lines.length
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase()
    if (FOOTER_MARKERS.some(m => lower.includes(m))) { cutAt = i; break }
  }
  return lines.slice(0, cutAt).join('\n')
}

async function log(jobId, type, msg) {
  await pushLog(jobId, type, msg)
}

// POST /api/catalog/extract
router.post('/extract', upload.single('file'), async (req, res, next) => {
  try {
    const { inputType, url, text, merchantName } = req.body
    const jobId = uuidv4()

    await createJob(jobId)
    res.json({ jobId, status: 'queued' })

    runJob(jobId, inputType, req.file, url, text, merchantName).catch(async err => {
      console.error('[runJob unhandled]', err)
      await log(jobId, 'error', err.message || String(err) || 'Unknown error')
      await updateJob(jobId, { status: 'failed' })
      await publishEvent(jobId, 'failed', null)
    })
  } catch (err) {
    next(err)
  }
})

async function runJob(jobId, inputType, file, url, text, merchantName) {
  await updateJob(jobId, { status: 'processing' })
  await log(jobId, 'info', `Job started — input type: ${inputType}`)

  let aiInput

  try {
    if (inputType === 'pdf') {
      await log(jobId, 'info', 'Extracting text from PDF...')
      const result = await extractFromPdf(file.buffer)
      if (result.error) throw new Error(result.error)
      await log(jobId, 'success', `Text extracted — ${result.text.length} characters (${result.pageCount} pages)`)
      aiInput = { type: 'text', content: result.text }

    } else if (inputType === 'image') {
      const ext = file.originalname.split('.').pop().toLowerCase()
      if (ext === 'docx') {
        await log(jobId, 'info', 'Extracting text from Word document...')
        const result = await extractFromDocx(file.buffer)
        await log(jobId, 'success', `Text extracted — ${result.text.length} characters`)
        aiInput = { type: 'text', content: result.text }
      } else {
        await log(jobId, 'info', 'Sending image to AI Vision...')
        const result = await extractFromImage(file.buffer, file.mimetype)
        aiInput = { type: 'image', imageBase64: result.imageBase64, mimeType: result.mimeType }
      }

    } else if (inputType === 'url') {
      await log(jobId, 'info', 'Extracting text from URL...')
      const result = await extractFromUrl(url)
      if (result.error) throw new Error(result.error)
      const cleaned = stripFooterNoise(result.text)
      const jsonLdStr = result.jsonLd
        ? '\n\n---STRUCTURED_DATA_JSON_LD---\n' + JSON.stringify(result.jsonLd)
        : ''
      await log(jobId, 'success', `Text extracted — ${cleaned.length} characters${result.jsonLd ? ' + structured data' : ''}`)
      aiInput = { type: 'text', content: cleaned + jsonLdStr }

    } else if (inputType === 'text') {
      await log(jobId, 'info', 'Processing manual text input...')
      await log(jobId, 'success', `Text received — ${text.length} characters`)
      aiInput = { type: 'text', content: text }

    } else {
      throw new Error(`Unknown input type: ${inputType}`)
    }
  } catch (err) {
    console.error('[extraction error]', err)
    await log(jobId, 'error', err.message || String(err) || 'Unknown error')
    await updateJob(jobId, { status: 'failed' })
    await publishEvent(jobId, 'failed', null)
    return
  }

  try {
    await updateJob(jobId, { stage: 'analyzing' })
    await publishEvent(jobId, 'stage', 'analyzing')
    await log(jobId, 'info', 'Sending to AI for catalog extraction...')
    const catalog = await extractCatalog(aiInput, merchantName)

    const allItems = catalog.categories.flatMap(c => c.items || c.products || [])
    await log(jobId, 'success', `Catalog extracted — ${allItems.length} items across ${catalog.categories.length} categories`)

    await updateJob(jobId, { stage: 'enriching' })
    await publishEvent(jobId, 'stage', 'enriching')
    await log(jobId, 'info', 'Enriching catalog with descriptions and tags...')
    await enrichProducts(catalog)
    await log(jobId, 'success', 'Enrichment complete.')

    await log(jobId, 'success', 'Done. Catalog ready.')
    await updateJob(jobId, { status: 'completed', stage: 'done', catalog })
    await publishEvent(jobId, 'done', null) // signal only — frontend fetches catalog via GET

  } catch (err) {
    console.error('[AI error]', err)
    await log(jobId, 'error', `AI service error: ${err.message || String(err)}`)
    await updateJob(jobId, { status: 'failed' })
    await publishEvent(jobId, 'failed', null)
  }
}

// GET /api/catalog/job/:jobId/stream  — SSE
router.get('/job/:jobId/stream', async (req, res) => {
  const { jobId } = req.params

  const job = await getJob(jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // disable nginx/Railway buffering
  res.flushHeaders()

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // Heartbeat — keeps connection alive through proxies
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000)

  let closed = false
  function cleanup() {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    sub.unsubscribe().catch(() => {})
    sub.quit().catch(() => {})
    res.end()
  }

  // Subscribe FIRST — prevents missing events during catch-up
  const sub = createSubscriber()
  await sub.subscribe(jobId)

  // Catch up: replay all log entries already written
  const existingLog = await getJobLog(jobId)
  for (const entry of existingLog) send('log', entry)

  // Check if job already finished before we connected
  const current = await getJob(jobId)
  send('stage', current.stage)

  if (current.status === 'completed') {
    send('done', null) // frontend fetches catalog via GET
    cleanup()
    return
  }
  if (current.status === 'failed') {
    send('failed', null)
    cleanup()
    return
  }

  // Stream live events
  sub.on('message', (channel, message) => {
    if (closed) return
    const { event, data } = JSON.parse(message)
    send(event, data)
    if (event === 'done' || event === 'failed') cleanup()
  })

  req.on('close', cleanup)
})

// GET /api/catalog/job/:jobId  — simple REST (debug / fallback)
router.get('/job/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  const jobLog = await getJobLog(req.params.jobId)
  res.json({ ...job, log: jobLog })
})

// POST /api/catalog/export
router.post('/export', (req, res) => {
  const catalog = req.body
  const filename = `catalog_${catalog.merchantName ? catalog.merchantName.replace(/[^a-z0-9]/gi, '_') : 'export'}_${Date.now()}.json`
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Type', 'application/json')
  res.send(JSON.stringify(catalog, null, 2))
})

// POST /api/catalog/generate-image
router.post('/generate-image', async (req, res) => {
  const { name, description, category } = req.body
  if (!name) return res.status(400).json({ error: 'name is required' })
  try {
    const imageUrl = await generateProductImage(name, description, category)
    res.json({ imageUrl })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
