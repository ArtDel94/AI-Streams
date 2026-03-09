import express from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { extractFromPdf, extractFromImage, extractFromDocx, extractFromUrl } from '../services/extractor.js'
import {
  extractCatalog,
  enrichProducts,
  generateProductImage,
  EXTRACT_PROMPT_VERSION,
  ENRICH_PROMPT_VERSION,
} from '../services/aiAgent.js'
import { createJob, getJob, updateJob, pushLog, getJobLog, publishEvent, createSubscriber } from '../services/jobStore.js'
import { validateAndCleanCatalog } from '../services/aiGuardrails.js'
import { recordJobSummary, checkAlerts, ALERT_THRESHOLDS } from '../services/aiMetrics.js'
import { catalogOrchestrator } from '../agents/CatalogOrchestrator.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// ─── Concurrency Semaphore (Phase 5) ──────────────────────────────────────────

const MAX_CONCURRENT_JOBS = 5
let activeJobs = 0

// ─── Footer noise stripping ───────────────────────────────────────────────────

const FOOTER_MARKERS = [
  'scopri deliveroo', 'scarica la app', '© deliveroo', '© uber',
  'termini & condizioni', 'informativa sulla privacy',
  'cookie policy', 'cookie notice', 'informativa cookie', 'consenso cookie',
  'preferenze cookie', 'gestione cookie', 'we use cookies',
  'lavora con noi', 'diventa nostro partner', 'il carrello è vuoto',
  'vai al pagamento', 'assistenza clienti', 'note legali',
]
function stripFooterNoise(text) {
  const lines = text.split('\n')
  let cutAt   = lines.length
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase()
    if (FOOTER_MARKERS.some(m => lower.includes(m))) {
      const charsBefore = lines.slice(0, i).join('\n').length
      if (charsBefore >= 500) cutAt = i
      break
    }
  }
  return lines.slice(0, cutAt).join('\n')
}

// ─── Logging helper ───────────────────────────────────────────────────────────

async function log(jobId, type, msg) {
  await pushLog(jobId, type, msg)
}

// ─── POST /api/catalog/extract ────────────────────────────────────────────────

router.post('/extract', upload.single('file'), async (req, res, next) => {
  try {
    if (activeJobs >= MAX_CONCURRENT_JOBS) {
      return res.status(429).json({ error: 'Too many concurrent jobs. Please try again shortly.' })
    }

    const { inputType, url, text, merchantName } = req.body
    const jobId = uuidv4()

    await createJob(jobId)
    res.json({ jobId, status: 'queued' })

    const USE_MULTI_AGENT = process.env.USE_MULTI_AGENT === 'true'
    const runner = USE_MULTI_AGENT ? runJobMultiAgent : runJob

    activeJobs++
    runner(jobId, inputType, req.file, url, text, merchantName)
      .catch(async err => {
        console.error('[runJob unhandled]', err)
        await log(jobId, 'error', err.message || String(err) || 'Unknown error')
        await updateJob(jobId, { status: 'failed' })
        await publishEvent(jobId, 'failed', null)
      })
      .finally(() => { activeJobs-- })
  } catch (err) {
    next(err)
  }
})

// ─── Pipeline stages ──────────────────────────────────────────────────────────

async function runStage(name, fn) {
  const t0 = Date.now()
  try {
    const result = await fn()
    return { success: true, result, warnings: result.warnings || [], costUsd: result.costUsd || 0, latencyMs: Date.now() - t0 }
  } catch (err) {
    return { success: false, result: null, warnings: [], costUsd: 0, latencyMs: Date.now() - t0, error: { stage: name, message: err.message } }
  }
}

// ─── runJob ────────────────────────────────────────────────────────────────────

async function runJob(jobId, inputType, file, url, text, merchantName) {
  const jobStartMs  = Date.now()
  const jobWarnings = []
  let requiresReview = false
  let aiCallFailed   = false

  // Shared per-job governance context (passed to gateway via aiAgent)
  const jobContext = { cumulativeCostUsd: 0, callCount: 0 }

  await updateJob(jobId, {
    status:     'processing',
    startedAt:  new Date().toISOString(),
    promptVersionExtraction: EXTRACT_PROMPT_VERSION,
    promptVersionEnrichment: ENRICH_PROMPT_VERSION,
  })
  await log(jobId, 'info', `Job started — input type: ${inputType}`)

  // ── Stage 1 + 2: fetchContent + preprocessContent ─────────────────────────
  let aiInput
  const fetchStage = await runStage('fetchContent', async () => {
    if (inputType === 'pdf') {
      await log(jobId, 'info', 'Extracting text from PDF...')
      const result = await extractFromPdf(file.buffer)
      if (result.error) throw new Error(result.error)
      await log(jobId, 'success', `Text extracted — ${result.text.length} characters (${result.pageCount} pages)`)
      return { type: 'text', content: result.text }

    } else if (inputType === 'image') {
      const ext = file.originalname.split('.').pop().toLowerCase()
      if (ext === 'docx') {
        await log(jobId, 'info', 'Extracting text from Word document...')
        const result = await extractFromDocx(file.buffer)
        await log(jobId, 'success', `Text extracted — ${result.text.length} characters`)
        return { type: 'text', content: result.text }
      } else {
        await log(jobId, 'info', 'Sending image to AI Vision...')
        const result = await extractFromImage(file.buffer, file.mimetype)
        return { type: 'image', imageBase64: result.imageBase64, mimeType: result.mimeType }
      }

    } else if (inputType === 'url') {
      await log(jobId, 'info', 'Extracting text from URL...')
      const result = await extractFromUrl(url)
      if (result.error) throw new Error(result.error)
      const cleaned   = stripFooterNoise(result.text)
      const jsonLdStr = result.jsonLd
        ? '\n\n---STRUCTURED_DATA_JSON_LD---\n' + JSON.stringify(result.jsonLd)
        : ''
      await log(jobId, 'success', `Text extracted — ${cleaned.length} characters${result.jsonLd ? ' + structured data' : ''}`)
      return { type: 'text', content: cleaned + jsonLdStr }

    } else if (inputType === 'text') {
      await log(jobId, 'info', 'Processing manual text input...')
      await log(jobId, 'success', `Text received — ${text.length} characters`)
      return { type: 'text', content: text }

    } else {
      throw new Error(`Unknown input type: ${inputType}`)
    }
  })

  if (!fetchStage.success) {
    await log(jobId, 'error', fetchStage.error.message)
    await updateJob(jobId, { status: 'failed' })
    await publishEvent(jobId, 'failed', null)
    return
  }
  aiInput = fetchStage.result

  // ── Stage 3: extractCatalog ────────────────────────────────────────────────
  await updateJob(jobId, { stage: 'analyzing' })
  await publishEvent(jobId, 'stage', 'analyzing')
  await log(jobId, 'info', 'Sending to AI for catalog extraction...')

  const extractStage = await runStage('extractCatalog', () =>
    extractCatalog(aiInput, merchantName, jobId, jobContext)
  )

  let extractionCostUsd = extractStage.costUsd
  if (!extractStage.success) {
    aiCallFailed = true
    await log(jobId, 'error', `AI extraction failed: ${extractStage.error.message}`)
    await updateJob(jobId, { status: 'failed' })
    await publishEvent(jobId, 'failed', null)
    return
  }

  if (extractStage.warnings.length) {
    jobWarnings.push(...extractStage.warnings)
    for (const w of extractStage.warnings) await log(jobId, 'warn', w)
  }

  let catalog = extractStage.result.catalog
  extractionCostUsd = extractStage.result.costUsd

  await log(jobId, 'info', `[info] Extraction cost: ~$${extractionCostUsd.toFixed(4)} (${catalog?.categories?.length ?? 0} categories)`)

  // ── Stage 4: validateExtraction (quality gates) ────────────────────────────
  const allItems = catalog.categories.flatMap(c => c.items || c.products || [])
  await log(jobId, 'success', `Catalog extracted — ${allItems.length} items across ${catalog.categories.length} categories`)

  // Gate 1: zero items = hard failure
  if (allItems.length === 0) {
    await log(jobId, 'error', 'Quality gate failed: no items extracted')
    await updateJob(jobId, { status: 'failed' })
    await publishEvent(jobId, 'failed', null)
    return
  }

  // Gate 2: very few items = warning
  if (allItems.length < 3) {
    const w = `Low item count: ${allItems.length}`
    jobWarnings.push(w)
    await log(jobId, 'warn', w)
    requiresReview = true
  }

  // Gate 3: high null-price rate = warning
  const nullPriceRate = allItems.filter(i => i.price === null || i.price === undefined).length / allItems.length
  if (nullPriceRate > 0.8) {
    const w = `${(nullPriceRate * 100).toFixed(0)}% null prices`
    jobWarnings.push(w)
    await log(jobId, 'warn', w)
  }
  if (nullPriceRate > 0.5) requiresReview = true

  // Guardrail validation + deduplication
  const { catalog: validatedCatalog, warnings: guardWarnings, flaggedForReview } = validateAndCleanCatalog(catalog)
  catalog = validatedCatalog
  if (guardWarnings.length) {
    jobWarnings.push(...guardWarnings)
    for (const w of guardWarnings) await log(jobId, 'warn', w)
  }
  if (flaggedForReview) requiresReview = true

  // Cost governance check
  const costCheckAfterExtract = checkAlerts({ jobId, totalCostUsd: jobContext.cumulativeCostUsd, latencyMs: Date.now() - jobStartMs })
  if (costCheckAfterExtract.abort) {
    await log(jobId, 'error', costCheckAfterExtract.reason)
    await updateJob(jobId, { status: 'failed' })
    await publishEvent(jobId, 'failed', null)
    return
  }

  // ── Stage 5: enrichProducts ────────────────────────────────────────────────
  await updateJob(jobId, { stage: 'enriching' })
  await publishEvent(jobId, 'stage', 'enriching')
  await log(jobId, 'info', 'Enriching catalog with descriptions and tags...')

  const enrichLogFn = (type, msg) => log(jobId, type, msg)
  const enrichStage = await runStage('enrichProducts', () =>
    enrichProducts(catalog, enrichLogFn, jobId, jobContext)
  )

  let enrichmentCostUsd = enrichStage.costUsd
  if (!enrichStage.success) {
    aiCallFailed = true
    const w = `Enrichment failed: ${enrichStage.error.message}`
    jobWarnings.push(w)
    await log(jobId, 'warn', w)
    requiresReview = true
    // Continue — enrichment failure is non-fatal
  } else {
    enrichmentCostUsd = enrichStage.result.costUsd
    if (enrichStage.result.warningCount > 0) {
      aiCallFailed = true
      requiresReview = true
    }
    if (enrichStage.result.warnings?.length) {
      jobWarnings.push(...enrichStage.result.warnings)
    }
    await log(jobId, 'success', 'Enrichment complete.')
  }

  await log(jobId, 'info', `[info] Enrichment cost: ~$${enrichmentCostUsd.toFixed(4)}`)

  // ── Stage 6: validateFinalCatalog ──────────────────────────────────────────
  const finalItems = catalog.categories.flatMap(c => c.items || [])

  // Review flag: any AI call failed
  if (aiCallFailed) requiresReview = true

  // Review flag: cost > $0.10
  if (jobContext.cumulativeCostUsd > ALERT_THRESHOLDS.jobCostWarn) requiresReview = true

  const totalCostUsd = jobContext.cumulativeCostUsd

  await log(jobId, 'info', `[info] Total job cost: ~$${totalCostUsd.toFixed(4)}`)

  // ── Stage 7: saveCatalog ───────────────────────────────────────────────────
  const outcome = requiresReview ? 'requires_review' : 'completed'

  if (requiresReview) {
    await log(jobId, 'warn', `[REVIEW] Job flagged for human review — ${jobWarnings.slice(-3).join('; ')}`)
  }

  await log(jobId, 'success', 'Done. Catalog ready.')
  await updateJob(jobId, {
    status:     outcome === 'requires_review' ? 'requires_review' : 'completed',
    stage:      'done',
    catalog,
    completedAt: new Date().toISOString(),
    warnings:   jobWarnings,
    requiresReview,
    promptVersionExtraction: EXTRACT_PROMPT_VERSION,
    promptVersionEnrichment: ENRICH_PROMPT_VERSION,
  })
  await publishEvent(jobId, 'done', null)

  // ── Structured job summary ─────────────────────────────────────────────────
  recordJobSummary({
    jobId,
    totalCostUsd,
    costExtraction:           extractionCostUsd,
    costEnrichment:           enrichmentCostUsd,
    totalLatencyMs:           Date.now() - jobStartMs,
    itemsExtracted:           finalItems.length,
    nullPriceRate,
    modelUsed:                'gpt-4o / gpt-4o-mini',
    promptVersionExtraction:  EXTRACT_PROMPT_VERSION,
    promptVersionEnrichment:  ENRICH_PROMPT_VERSION,
    warnings:                 jobWarnings,
    outcome,
    requiresReview,
  })
}

// ─── Multi-agent job runner ───────────────────────────────────────────────────

async function runJobMultiAgent(jobId, inputType, file, url, text, merchantName) {
  await updateJob(jobId, { status: 'processing', startedAt: new Date().toISOString() })
  await log(jobId, 'info', `[multi-agent] Job started — input type: ${inputType}`)

  // ── Pre-process file inputs ────────────────────────────────────────────────
  let orchestratorRequest = { jobId, merchantName }

  try {
    if (inputType === 'pdf') {
      await log(jobId, 'info', 'Extracting text from PDF...')
      const result = await extractFromPdf(file.buffer)
      if (result.error) throw new Error(result.error)
      await log(jobId, 'success', `Text extracted — ${result.text.length} characters (${result.pageCount} pages)`)
      orchestratorRequest = { ...orchestratorRequest, rawContent: result.text, format: 'text' }

    } else if (inputType === 'image') {
      const ext = file.originalname.split('.').pop().toLowerCase()
      if (ext === 'docx') {
        await log(jobId, 'info', 'Extracting text from Word document...')
        const result = await extractFromDocx(file.buffer)
        await log(jobId, 'success', `Text extracted — ${result.text.length} characters`)
        orchestratorRequest = { ...orchestratorRequest, rawContent: result.text, format: 'text' }
      } else {
        await log(jobId, 'info', 'Sending image to AI Vision...')
        const result = await extractFromImage(file.buffer, file.mimetype)
        orchestratorRequest = { ...orchestratorRequest, imageBase64: result.imageBase64, mimeType: result.mimeType }
      }

    } else if (inputType === 'url') {
      orchestratorRequest = { ...orchestratorRequest, url, format: 'html' }

    } else if (inputType === 'text') {
      orchestratorRequest = { ...orchestratorRequest, rawContent: text, format: 'text' }

    } else {
      throw new Error(`Unknown input type: ${inputType}`)
    }
  } catch (err) {
    await log(jobId, 'error', err.message || String(err))
    await updateJob(jobId, { status: 'failed' })
    await publishEvent(jobId, 'failed', null)
    return
  }

  // ── Run pipeline ───────────────────────────────────────────────────────────
  await updateJob(jobId, { stage: 'analyzing' })
  await publishEvent(jobId, 'stage', 'analyzing')
  await log(jobId, 'info', 'Running multi-agent catalog extraction pipeline...')

  const result = await catalogOrchestrator.executePipeline(orchestratorRequest)

  if (result.status === 'failed') {
    await log(jobId, 'error', `Pipeline failed at stage "${result.failedAtStage}": ${result.error?.message}`)
    for (const w of (result.warnings || [])) await log(jobId, 'warn', w)
    await updateJob(jobId, { status: 'failed' })
    await publishEvent(jobId, 'failed', null)
    return
  }

  // ── Log stage costs ────────────────────────────────────────────────────────
  const bd = result.metrics?.stageBreakdown || {}
  if (bd.analyze?.costUsd)  await log(jobId, 'info',    `[info] Analysis cost:    ~$${(bd.analyze.costUsd).toFixed(4)}`)
  if (bd.extract?.costUsd)  await log(jobId, 'info',    `[info] Extraction cost:  ~$${(bd.extract.costUsd).toFixed(4)}`)
  if (bd.enrich?.costUsd)   await log(jobId, 'info',    `[info] Enrichment cost:  ~$${(bd.enrich.costUsd).toFixed(4)}`)
  await log(jobId, 'info', `[info] Total job cost: ~$${(result.metrics?.totalCostUsd || 0).toFixed(4)}`)

  // ── Log quality summary ────────────────────────────────────────────────────
  const qr = result.qualityReport || {}
  await log(jobId, 'success',
    `Catalog extracted — ${result.itemCount} items across ${result.catalog?.categories?.length || 0} categories`)
  if (qr.nullPriceRate > 0.3)  await log(jobId, 'warn', `${(qr.nullPriceRate * 100).toFixed(0)}% null prices`)
  if (qr.duplicatesRemoved > 0) await log(jobId, 'info', `${qr.duplicatesRemoved} duplicates removed`)
  for (const w of (result.warnings || [])) await log(jobId, 'warn', w)

  if (result.requiresReview) {
    await log(jobId, 'warn',
      `[REVIEW] Job flagged for human review — ${(result.reviewReasons || []).slice(0, 3).join('; ')}`)
  }

  await updateJob(jobId, { stage: 'enriching' })
  await publishEvent(jobId, 'stage', 'enriching')
  await log(jobId, 'success', 'Done. Catalog ready.')

  const finalStatus = result.requiresReview ? 'requires_review' : 'completed'
  await updateJob(jobId, {
    status:          finalStatus,
    stage:           'done',
    catalog:         result.catalog,
    completedAt:     new Date().toISOString(),
    warnings:        result.warnings || [],
    requiresReview:  result.requiresReview,
    qualityReport:   result.qualityReport,
    metrics:         result.metrics,
    promptVersions:  result.promptVersions,
  })
  await publishEvent(jobId, 'done', null)
}

// ─── GET /api/catalog/job/:jobId/stream  — SSE ────────────────────────────────

router.get('/job/:jobId/stream', async (req, res) => {
  const { jobId } = req.params

  const job = await getJob(jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

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

  const sub = createSubscriber()
  await sub.subscribe(jobId)

  const existingLog = await getJobLog(jobId)
  for (const entry of existingLog) send('log', entry)

  const current = await getJob(jobId)
  send('stage', current.stage)

  if (current.status === 'completed' || current.status === 'requires_review') {
    send('done', null)
    cleanup()
    return
  }
  if (current.status === 'failed') {
    send('failed', null)
    cleanup()
    return
  }

  sub.on('message', (channel, message) => {
    if (closed) return
    const { event, data } = JSON.parse(message)
    send(event, data)
    if (event === 'done' || event === 'failed') cleanup()
  })

  req.on('close', cleanup)
})

// ─── GET /api/catalog/job/:jobId  — REST ──────────────────────────────────────

router.get('/job/:jobId', async (req, res) => {
  const job = await getJob(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  const jobLog = await getJobLog(req.params.jobId)
  res.json({ ...job, log: jobLog })
})

// ─── POST /api/catalog/export ─────────────────────────────────────────────────

router.post('/export', (req, res) => {
  const catalog = req.body
  const filename = `catalog_${catalog.merchantName ? catalog.merchantName.replace(/[^a-z0-9]/gi, '_') : 'export'}_${Date.now()}.json`
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Type', 'application/json')
  res.send(JSON.stringify(catalog, null, 2))
})

// ─── POST /api/catalog/generate-image ────────────────────────────────────────

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
