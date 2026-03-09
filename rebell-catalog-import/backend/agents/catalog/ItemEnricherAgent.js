/**
 * ItemEnricherAgent — Agent 5
 *
 * Enriches validated items with descriptions and tags using gpt-4o-mini.
 * Always uses the cheap model — enrichment is enhancement, not core extraction.
 *
 * Critical rule: never modifies name or price. Enrichment is additive only.
 * Batch failures fall back to original items — enrichment is non-fatal.
 */

import { BaseAgent } from '../../BaseAgent.js'
import { callOpenAI, safeParseJson } from '../../../services/openaiGateway.js'
import { ENRICH_SYSTEM, PROMPT_VERSION } from './prompts/enrichItems.js'

const ENRICHMENT_BATCH_SIZE  = 15
const MAX_ENRICHMENT_BATCHES = 10

export class ItemEnricherAgent extends BaseAgent {
  constructor() {
    super({ agentId: 'item-enricher', capabilities: ['enrich-items'] })
  }

  async execute(task) {
    const t0 = Date.now()
    const { items = [], analysis, enrichmentConfig = {} } = task.payload
    const { jobId, jobContext }                           = task.context || {}

    const config = {
      addDescriptions:     true,
      normalizeCategories: false,   // not implemented yet — placeholder
      addTags:             true,
      ...enrichmentConfig,
    }

    // Identify items that actually need enrichment
    const toEnrich = items
      .map((item, idx) => ({
        idx,
        needsDesc: config.addDescriptions && !item.description,
        needsTags: config.addTags && (!item.tags || item.tags.length === 0),
      }))
      .filter(e => e.needsDesc || e.needsTags)

    if (toEnrich.length === 0) {
      return this._ok({
        enrichedItems:    items,
        enrichmentStats:  { descriptionsAdded: 0, categoriesNormalized: 0, tagsAdded: 0, failedItems: 0 },
      }, { latencyMs: Date.now() - t0 })
    }

    // Build batches (cap at MAX_ENRICHMENT_BATCHES)
    const batches = []
    for (
      let i = 0;
      i < toEnrich.length && batches.length < MAX_ENRICHMENT_BATCHES;
      i += ENRICHMENT_BATCH_SIZE
    ) {
      batches.push(toEnrich.slice(i, i + ENRICHMENT_BATCH_SIZE))
    }

    let totalCost        = 0
    let callCount        = 0
    let descriptionsAdded = 0
    let tagsAdded        = 0
    let failedItems      = 0

    // Mutable copy of items — we patch in-place
    const enrichedItems = items.map(i => ({ ...i }))

    await Promise.all(batches.map(async batch => {
      const batchInput = batch.map(({ idx }, batchIdx) => ({
        index:       batchIdx,
        name:        items[idx].name,
        category:    items[idx].category,
        description: items[idx].description,
      }))

      const result = await callOpenAI({
        messages: [
          { role: 'system', content: ENRICH_SYSTEM },
          { role: 'user',   content: JSON.stringify(batchInput) },
        ],
        maxTokens: 4096,
        model:     'gpt-4o-mini',    // always mini for enrichment
        stage:     'enrichment',
        jobId,
        jobContext,
      })

      callCount++
      totalCost += result.costUsd || 0

      if (!result.success) {
        console.warn(`[ItemEnricher] Batch failed: ${result.error?.message}`)
        failedItems += batch.length
        return
      }

      const enrichments = safeParseJson(result.content)
      if (!Array.isArray(enrichments)) {
        console.warn('[ItemEnricher] Non-array enrichment response')
        failedItems += batch.length
        return
      }

      for (const { index, description, tags } of enrichments) {
        const entry = batch[index]
        if (!entry) continue
        const item = enrichedItems[entry.idx]

        // Safety: never overwrite name or price
        if (!item.description && description && typeof description === 'string') {
          item.description           = description
          item.description_generated = true
          descriptionsAdded++
        }

        if (Array.isArray(tags) && tags.length > 0) {
          const existing = item.tags || []
          item.tags = [...new Set([...existing, ...tags])]
          tagsAdded++
        }
      }
    }))

    return this._ok({
      enrichedItems,
      enrichmentStats: { descriptionsAdded, categoriesNormalized: 0, tagsAdded, failedItems },
    }, {
      costUsd:    totalCost,
      latencyMs:  Date.now() - t0,
      callCount,
      batchCount: batches.length,
    })
  }
}

export { PROMPT_VERSION }
