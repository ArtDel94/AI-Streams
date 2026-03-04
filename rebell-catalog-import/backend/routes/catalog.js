import express from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { extractFromPdf, extractFromImage, extractFromDocx, extractFromUrl } from '../services/extractor.js'
import { extractCatalog, enrichProducts } from '../services/aiAgent.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// In-memory job store
const jobs = new Map()

// Strip nav/footer noise that delivery platforms append after menu content
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

function log(jobId, type, msg) {
  const job = jobs.get(jobId)
  if (!job) return
  job.log.push({ ts: new Date().toISOString(), type, msg })
}

// POST /api/catalog/extract
router.post('/extract', upload.single('file'), async (req, res, next) => {
  try {
    const { inputType, url, text, merchantName } = req.body
    const jobId = uuidv4()

    jobs.set(jobId, { jobId, status: 'queued', stage: 'extracting', log: [], catalog: null })
    res.json({ jobId, status: 'queued' })

    // Run async
    runJob(jobId, inputType, req.file, url, text, merchantName).catch(err => {
      log(jobId, 'error', err.message || 'Unknown error')
      const job = jobs.get(jobId)
      if (job) job.status = 'failed'
    })
  } catch (err) {
    next(err)
  }
})

async function runJob(jobId, inputType, file, url, text, merchantName) {
  const job = jobs.get(jobId)
  job.status = 'processing'

  log(jobId, 'info', `Job started — input type: ${inputType}`)

  let aiInput

  try {
    if (inputType === 'pdf') {
      log(jobId, 'info', 'Extracting text from PDF...')
      const result = await extractFromPdf(file.buffer)
      if (result.error) throw new Error(result.error)
      log(jobId, 'success', `Text extracted — ${result.text.length} characters (${result.pageCount} pages)`)
      aiInput = { type: 'text', content: result.text }

    } else if (inputType === 'image') {
      const ext = file.originalname.split('.').pop().toLowerCase()

      if (ext === 'docx') {
        log(jobId, 'info', 'Extracting text from Word document...')
        const result = await extractFromDocx(file.buffer)
        log(jobId, 'success', `Text extracted — ${result.text.length} characters`)
        aiInput = { type: 'text', content: result.text }
      } else {
        log(jobId, 'info', 'Sending image to AI Vision...')
        const result = await extractFromImage(file.buffer, file.mimetype)
        aiInput = { type: 'image', imageBase64: result.imageBase64, mimeType: result.mimeType }
      }

    } else if (inputType === 'url') {
      log(jobId, 'info', `Extracting text from URL...`)
      const result = await extractFromUrl(url)
      if (result.error) throw new Error(result.error)
      // Strip common footer/nav noise that appears after the menu content
      const cleaned = stripFooterNoise(result.text)
      log(jobId, 'success', `Text extracted — ${cleaned.length} characters`)
      aiInput = { type: 'text', content: cleaned }

    } else if (inputType === 'text') {
      log(jobId, 'info', 'Processing manual text input...')
      log(jobId, 'success', `Text received — ${text.length} characters`)
      aiInput = { type: 'text', content: text }

    } else {
      throw new Error(`Unknown input type: ${inputType}`)
    }
  } catch (err) {
    log(jobId, 'error', err.message)
    job.status = 'failed'
    return
  }

  try {
    job.stage = 'analyzing'
    log(jobId, 'info', 'Sending to AI for catalog extraction...')
    const catalog = await extractCatalog(aiInput, merchantName)

    const allItems = catalog.categories.flatMap(c => c.items || c.products || [])
    const totalProducts = allItems.length
    log(jobId, 'success', `Catalog extracted — ${totalProducts} items across ${catalog.categories.length} categories`)

    job.stage = 'enriching'
    log(jobId, 'info', `Generating descriptions and tags for ${totalProducts} items...`)
    await enrichProducts(catalog)
    log(jobId, 'success', 'Descriptions and tags generated')

    log(jobId, 'success', 'Done. Catalog ready.')
    job.stage = 'done'
    job.catalog = catalog
    job.status = 'completed'
  } catch (err) {
    log(jobId, 'error', `AI service error: ${err.message}`)
    job.status = 'failed'
  }
}

// GET /api/catalog/job/:jobId
router.get('/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.json(job)
})

// POST /api/catalog/export
router.post('/export', (req, res) => {
  const catalog = req.body
  const filename = `catalog_${catalog.merchantName ? catalog.merchantName.replace(/\s+/g, '_') : 'export'}_${Date.now()}.json`
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Type', 'application/json')
  res.send(JSON.stringify(catalog, null, 2))
})

export default router
