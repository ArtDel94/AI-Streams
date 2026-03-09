import OpenAI from 'openai'
import { callOpenAI, safeParseJson } from './openaiGateway.js'
import { EXTRACT_SYSTEM, PROMPT_VERSION as EXTRACT_PROMPT_VERSION } from './prompts/catalogExtraction.js'
import { ENRICH_SYSTEM, PROMPT_VERSION as ENRICH_PROMPT_VERSION } from './prompts/catalogEnrichment.js'

// Keep the OpenAI client only for image generation (DALL-E), which goes through a
// different API endpoint not covered by the chat completions gateway.
const _dalleClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export { EXTRACT_PROMPT_VERSION, ENRICH_PROMPT_VERSION }

// Max chars per extraction chunk (fits within gpt-4o context with schema headroom)
const CHUNK_SIZE  = 14000
// Max chunks processed per job (Phase 3 cost governance)
const MAX_CHUNKS  = 10

// ─── Chunking ─────────────────────────────────────────────────────────────────

function chunkText(text) {
  if (text.length <= CHUNK_SIZE) return [text]
  const lines   = text.split('\n')
  const chunks  = []
  let current   = ''
  for (const line of lines) {
    if (current.length + line.length + 1 > CHUNK_SIZE && current.length > 0) {
      chunks.push(current)
      current = ''
    }
    current += (current ? '\n' : '') + line
  }
  if (current) chunks.push(current)
  return chunks
}

// ─── Catalog Merging ──────────────────────────────────────────────────────────

function mergeCatalogs(catalogs) {
  const base        = catalogs[0]
  const categoryMap = new Map()
  for (const cat of (base.categories || [])) {
    categoryMap.set(cat.name.toLowerCase().trim(), { ...cat, items: [...(cat.items || [])] })
  }
  for (const catalog of catalogs.slice(1)) {
    for (const cat of (catalog.categories || [])) {
      const key = cat.name.toLowerCase().trim()
      if (categoryMap.has(key)) {
        categoryMap.get(key).items.push(...(cat.items || []))
      } else {
        categoryMap.set(key, { ...cat, items: [...(cat.items || [])] })
      }
    }
  }
  return {
    ...base,
    categories: [...categoryMap.values()],
    item_count:  [...categoryMap.values()].reduce((s, c) => s + c.items.length, 0),
  }
}

// ─── Single chunk extraction ──────────────────────────────────────────────────

async function extractSingleChunk(content, merchantName, jobId, jobContext) {
  const userContent = merchantName ? `Merchant: ${merchantName}\n\n${content}` : content
  const result = await callOpenAI({
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user',   content: userContent },
    ],
    maxTokens:      16000,
    responseFormat: { type: 'json_object' },
    stage:          'extraction',
    jobId,
    expectJson:     true,
    jobContext,
  })

  if (!result.success) {
    console.warn('[aiAgent] Chunk extraction failed:', result.error?.message)
    return { catalog: null, costUsd: result.costUsd, warnings: [result.error?.message] }
  }

  const catalog = safeParseJson(result.content)
  if (!catalog) {
    console.warn('[aiAgent] Unparseable chunk response:', result.content?.slice(0, 200))
    return { catalog: null, costUsd: result.costUsd, warnings: ['Unparseable AI response for chunk'] }
  }

  return { catalog, costUsd: result.costUsd, warnings: [] }
}

// ─── extractCatalog ───────────────────────────────────────────────────────────

/**
 * Extract a structured catalog from AI input.
 *
 * @param {object} input         - { type: 'text'|'image', content?, imageBase64?, mimeType? }
 * @param {string} merchantName  - Optional merchant name hint
 * @param {string} jobId         - Job ID for tracing
 * @param {object} jobContext    - Mutable { cumulativeCostUsd, callCount } for governance
 *
 * @returns {{ catalog, costUsd: number, warnings: string[] }}
 */
export async function extractCatalog(input, merchantName, jobId, jobContext) {
  const warnings = []

  // ── Image path ────────────────────────────────────────────────────────────
  if (input.type === 'image') {
    const result = await callOpenAI({
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` } },
            { type: 'text',      text: 'Extract the complete product catalog from this image.' },
          ],
        },
      ],
      maxTokens:      16000,
      responseFormat: { type: 'json_object' },
      stage:          'extraction',
      jobId,
      expectJson:     true,
      jobContext,
    })

    if (!result.success) throw new Error(result.error?.message || 'Image extraction failed')

    const catalog = safeParseJson(result.content)
    if (!catalog) throw new Error('Could not parse AI response for image.')

    return { catalog, costUsd: result.costUsd, warnings }
  }

  // ── Text path: chunk → extract in parallel → merge ────────────────────────
  let chunks = chunkText(input.content)

  if (chunks.length > MAX_CHUNKS) {
    warnings.push(`Input produced ${chunks.length} chunks — truncated to ${MAX_CHUNKS}`)
    console.warn(`[aiAgent] Chunk limit exceeded: ${chunks.length} > ${MAX_CHUNKS}, truncating`)
    chunks = chunks.slice(0, MAX_CHUNKS)
  }

  const chunkResults = await Promise.all(
    chunks.map(chunk => extractSingleChunk(chunk, merchantName, jobId, jobContext))
  )

  let totalCost = 0
  for (const r of chunkResults) {
    totalCost += r.costUsd || 0
    if (r.warnings?.length) warnings.push(...r.warnings)
  }

  const catalogs = chunkResults.map(r => r.catalog).filter(Boolean)
  if (catalogs.length === 0) throw new Error('AI could not extract any items from the input.')

  const catalog = catalogs.length === 1 ? catalogs[0] : mergeCatalogs(catalogs)
  return { catalog, costUsd: totalCost, warnings }
}

// ─── Enrichment ───────────────────────────────────────────────────────────────

async function enrichBatch(batch, catalog, jobId, jobContext, logFn) {
  const batchInput = batch.map((item, idx) => ({
    index:       idx,
    name:        item.name,
    category:    item.category,
    description: item.description,
  }))

  const result = await callOpenAI({
    messages: [
      { role: 'system', content: ENRICH_SYSTEM },
      { role: 'user',   content: JSON.stringify(batchInput) },
    ],
    maxTokens:  4096,
    stage:      'enrichment',
    jobId,
    expectJson: false,
    jobContext,
  })

  if (!result.success) {
    const msg = `Enrich batch failed: ${result.error?.message}`
    logFn('warn', msg)
    return { costUsd: result.costUsd, warningCount: 1, warnings: [msg] }
  }

  const results = safeParseJson(result.content)
  let warningCount = 0

  if (Array.isArray(results)) {
    results.forEach(({ index, description, tags }) => {
      const entry = batch[index]
      if (!entry) return
      const items = catalog.categories[entry.catIdx].items
      const item  = items[entry.itemIdx]
      if (!item.description && description) {
        item.description           = description
        item.description_generated = true
      }
      if (Array.isArray(tags) && tags.length > 0) {
        const existing = item.tags || []
        item.tags = [...new Set([...existing, ...tags])]
      }
    })
  } else {
    const msg = 'Enrich batch returned non-array result'
    logFn('warn', msg)
    warningCount++
    return { costUsd: result.costUsd, warningCount, warnings: [msg] }
  }

  return { costUsd: result.costUsd, warningCount: 0, warnings: [] }
}

/**
 * Enrich a catalog with generated descriptions and tags.
 *
 * @param {object}   catalog     - Mutable catalog to enrich
 * @param {Function} logFn       - (type, msg) => void — logging callback from caller
 * @param {string}   jobId       - Job ID for tracing
 * @param {object}   jobContext  - Mutable { cumulativeCostUsd, callCount }
 *
 * @returns {{ enrichedCatalog, costUsd: number, warningCount: number, warnings: string[] }}
 */
export async function enrichProducts(catalog, logFn = () => {}, jobId, jobContext) {
  const toEnrich = []
  catalog.categories.forEach((cat, catIdx) => {
    const items = cat.items || cat.products || []
    items.forEach((item, itemIdx) => {
      const needsDesc = !item.description
      const needsTags = !item.tags || item.tags.length === 0
      if (needsDesc || needsTags) {
        toEnrich.push({ catIdx, itemIdx, name: item.name, category: cat.name, description: item.description || null })
      }
    })
  })

  if (toEnrich.length === 0) {
    return { enrichedCatalog: catalog, costUsd: 0, warningCount: 0, warnings: [] }
  }

  const BATCH_SIZE = 20
  const batches    = []
  for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
    batches.push(toEnrich.slice(i, i + BATCH_SIZE))
  }

  const batchResults = await Promise.all(
    batches.map(batch => enrichBatch(batch, catalog, jobId, jobContext, logFn))
  )

  let totalCost    = 0
  let warningCount = 0
  const warnings   = []
  for (const r of batchResults) {
    totalCost    += r.costUsd    || 0
    warningCount += r.warningCount || 0
    if (r.warnings?.length) warnings.push(...r.warnings)
  }

  return { enrichedCatalog: catalog, costUsd: totalCost, warningCount, warnings }
}

// ─── Image Generation (DALL-E — stays separate from chat gateway) ─────────────

export async function generateProductImage(name, description, category) {
  const prompt = [
    `Professional product photo of "${name}"`,
    description ? `: ${description.slice(0, 120)}` : '',
    category    ? ` (${category})` : '',
    '. Clean background, well-lit, high quality, appetizing presentation, menu photography style.',
  ].join('')

  const response = await _dalleClient.images.generate({
    model:           'dall-e-3',
    prompt,
    n:               1,
    size:            '1024x1024',
    quality:         'standard',
    response_format: 'url',
  })

  return response.data[0].url
}
