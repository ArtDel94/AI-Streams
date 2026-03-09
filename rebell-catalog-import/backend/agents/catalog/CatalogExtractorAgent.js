/**
 * CatalogExtractorAgent — Agent 3
 *
 * Extracts structured items from content chunks.
 * Uses gpt-4o (or mini for small chunks). Most expensive agent.
 * Handles both text chunks and image (vision) inputs.
 */

import { BaseAgent } from '../../BaseAgent.js'
import { callOpenAI, safeParseJson } from '../../../services/openaiGateway.js'
import { buildExtractionSystemPrompt, PROMPT_VERSION } from './prompts/extractCatalog.js'
import { EXTRACT_SYSTEM } from '../../../services/prompts/catalogExtraction.js'

export class CatalogExtractorAgent extends BaseAgent {
  constructor() {
    super({ agentId: 'catalog-extractor', capabilities: ['extract-catalog', 'extract-catalog-image'] })
  }

  async execute(task) {
    const { type, payload, context = {} } = task
    const { jobId, jobContext }           = context

    if (type === 'extract-catalog-image') {
      return this._extractImage(payload, jobId, jobContext)
    }
    return this._extractText(payload, jobId, jobContext)
  }

  // ── Image path (vision) ────────────────────────────────────────────────────

  async _extractImage(payload, jobId, jobContext) {
    const t0 = Date.now()
    const { imageBase64, mimeType } = payload

    // Use the detailed EXTRACT_SYSTEM for image — vision needs the full schema context.
    // The response may be nested (categories format); _normalizeToFlatItems handles both.
    const result = await callOpenAI({
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
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

    const latencyMs = Date.now() - t0

    if (!result.success) {
      return this._fail(result.error?.code || 'AI_ERROR', result.error?.message, {
        costUsd: result.costUsd, latencyMs, callCount: 1,
      })
    }

    const parsed = safeParseJson(result.content)
    if (!parsed) {
      return this._fail('PARSE_ERROR', 'Could not parse image extraction response', {
        costUsd: result.costUsd, latencyMs, callCount: 1,
      })
    }

    const items = this._normalizeToFlatItems(parsed)
    return this._ok(
      { items, totalChunksProcessed: 1, failedChunks: 0 },
      { costUsd: result.costUsd, latencyMs, callCount: 1 }
    )
  }

  // ── Text path (one call per chunk, parallel) ───────────────────────────────

  async _extractText(payload, jobId, jobContext) {
    const t0 = Date.now()
    const { chunks, analysis } = payload

    if (!chunks || chunks.length === 0) {
      return this._fail('NO_CHUNKS', 'No content chunks provided', { latencyMs: 0 })
    }

    const systemPrompt = buildExtractionSystemPrompt(analysis)
    let totalCost    = 0
    let callCount    = 0
    let failedChunks = 0

    const chunkResults = await Promise.all(
      chunks.map(async chunk => {
        const res = await callOpenAI({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: chunk },
          ],
          maxTokens:  8000,
          stage:      'extraction',
          jobId,
          expectJson: true,
          jobContext,
        })

        totalCost += res.costUsd || 0
        callCount++

        if (!res.success) {
          console.warn(`[CatalogExtractor] Chunk failed: ${res.error?.message}`)
          failedChunks++
          return []
        }

        const parsed = safeParseJson(res.content)
        if (!Array.isArray(parsed)) {
          console.warn('[CatalogExtractor] Chunk returned non-array:', res.content?.slice(0, 100))
          failedChunks++
          return []
        }

        return parsed
      })
    )

    const latencyMs = Date.now() - t0
    const allItems  = chunkResults.flat().filter(
      item => item && typeof item.name === 'string' && item.name.trim()
    )

    if (allItems.length === 0 && failedChunks === chunks.length) {
      return this._fail('ALL_CHUNKS_FAILED', 'All extraction chunks failed or returned no items', {
        costUsd: totalCost, latencyMs, callCount,
      })
    }

    return this._ok(
      { items: allItems, totalChunksProcessed: chunks.length, failedChunks },
      { costUsd: totalCost, latencyMs, callCount }
    )
  }

  // ── Normalize nested catalog → flat items array ────────────────────────────

  _normalizeToFlatItems(parsed) {
    // Already flat array
    if (Array.isArray(parsed)) return parsed

    // Nested format: { categories: [{ name, items: [...] }] }
    if (parsed.categories && Array.isArray(parsed.categories)) {
      return parsed.categories.flatMap(cat =>
        (cat.items || cat.products || []).map(item => ({
          name:        item.name,
          category:    cat.name || null,
          price:       item.price     ?? null,
          currency:    item.currency  ?? parsed.currency ?? null,
          description: item.description || null,
        }))
      )
    }

    return []
  }
}

export { PROMPT_VERSION }
