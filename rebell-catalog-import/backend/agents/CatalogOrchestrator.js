/**
 * CatalogOrchestrator — coordinates the 5-agent catalog extraction pipeline.
 *
 * Pipeline:
 *   ContentFetcher → ContentAnalyzer → CatalogExtractor → ItemValidator → ItemEnricher
 *
 * Exports a singleton `catalogOrchestrator` — import and call executePipeline().
 */

import { v4 as generateId } from 'uuid'
import { AgentRegistry }         from './AgentRegistry.js'
import { ContentFetcherAgent }   from './catalog/ContentFetcherAgent.js'
import { ContentAnalyzerAgent }  from './catalog/ContentAnalyzerAgent.js'
import { CatalogExtractorAgent } from './catalog/CatalogExtractorAgent.js'
import { ItemValidatorAgent }    from './catalog/ItemValidatorAgent.js'
import { ItemEnricherAgent }     from './catalog/ItemEnricherAgent.js'
import { recordJobSummary, checkAlerts } from '../services/aiMetrics.js'
import { PROMPT_VERSION as EXTRACT_VERSION } from './catalog/prompts/extractCatalog.js'
import { PROMPT_VERSION as ENRICH_VERSION  } from './catalog/prompts/enrichItems.js'
import { PROMPT_VERSION as ANALYZE_VERSION } from './catalog/prompts/analyzeContent.js'

const MAX_JOB_COST_USD        = 0.25
const DEFAULT_TASK_TIMEOUT_MS = 120000
const MIN_ANALYSIS_CONFIDENCE = 0.3

// ─── Singleton registry ───────────────────────────────────────────────────────

const registry = new AgentRegistry()
registry
  .register(new ContentFetcherAgent())
  .register(new ContentAnalyzerAgent())
  .register(new CatalogExtractorAgent())
  .register(new ItemValidatorAgent())
  .register(new ItemEnricherAgent())

// ─── Catalog builder ──────────────────────────────────────────────────────────

function normalizeItem(item) {
  // Strip the routing fields (category, currency) from the item itself and add required defaults
  const { category: _cat, currency: _cur, ...rest } = item
  return {
    name:                 rest.name,
    description:          rest.description          || null,
    description_generated: rest.description_generated || false,
    price:                rest.price                ?? null,
    price_max:            null,
    image_url:            null,
    is_combo:             false,
    combo_items:          [],
    allergens:            [],
    tags:                 rest.tags                 || [],
    confidence:           'high',
  }
}

function buildCatalogFromItems(items, analysis, merchantName) {
  const categoryMap = new Map()
  for (const item of items) {
    const catName = item.category || 'Other'
    if (!categoryMap.has(catName)) categoryMap.set(catName, [])
    categoryMap.get(catName).push(normalizeItem(item))
  }

  const currency = items.find(i => i.currency)?.currency || null

  return {
    merchant_name:      merchantName || null,
    catalog_language:   analysis?.language || null,
    currency,
    categories_inferred: analysis ? !(analysis.hasCategories) : false,
    mixed_currencies:   false,
    item_count:         items.length,
    categories:         [...categoryMap.entries()].map(([name, catItems]) => ({ name, items: catItems })),
  }
}

// ─── Orchestrator class ───────────────────────────────────────────────────────

class CatalogOrchestrator {

  /** Dispatch a task to the appropriate agent. Updates cumulative cost in jobState. */
  async _dispatch(taskType, payload, jobState) {
    const agent = registry.resolve(taskType)
    if (!agent) {
      return {
        success: false,
        result:  null,
        error:   { code: 'NO_AGENT', message: `No agent registered for task type: ${taskType}` },
        metrics: { costUsd: 0, latencyMs: 0, callCount: 0 },
      }
    }

    const task = {
      taskId:    generateId(),
      type:      taskType,
      payload,
      context:   { jobId: jobState.jobId, jobContext: jobState.jobContext },
      timeout:   DEFAULT_TASK_TIMEOUT_MS,
      createdAt: Date.now(),
    }

    const result = await agent.execute(task)

    const stageCost = result.metrics?.costUsd || 0
    jobState.cumulativeCost += stageCost

    // Cost ceiling check after every agent call
    if (jobState.cumulativeCost > MAX_JOB_COST_USD) {
      return {
        success: false,
        result:  null,
        error: {
          code:    'COST_CEILING',
          message: `Job cost $${jobState.cumulativeCost.toFixed(4)} exceeds limit $${MAX_JOB_COST_USD}`,
        },
        metrics: result.metrics,
      }
    }

    return result
  }

  _failJob(jobState, stage, error) {
    jobState.status      = 'failed'
    jobState.completedAt = Date.now()
    return {
      jobId:         jobState.jobId,
      status:        'failed',
      failedAtStage: stage,
      error,
      catalog:       null,
      itemCount:     0,
      metrics: {
        totalCostUsd:   jobState.cumulativeCost,
        totalLatencyMs: jobState.completedAt - jobState.startedAt,
        stageBreakdown: jobState.stageBreakdown,
      },
      warnings:      jobState.warnings,
      requiresReview: false,
      reviewReasons: [],
    }
  }

  // ── Shared tail: Validate → Enrich → Build catalog ────────────────────────

  async _continueFromItems(rawItems, analysis, merchantName, jobState) {
    // Step 4: Validate
    const validateResult = await this._dispatch('validate-items', { items: rawItems, analysis }, jobState)
    jobState.stageBreakdown.validate = { costUsd: 0, latencyMs: validateResult.metrics?.latencyMs || 0 }

    if (!validateResult.success) return this._failJob(jobState, 'validate', validateResult.error)

    const { validItems, qualityReport, requiresReview, reviewReasons } = validateResult.result

    if (validItems.length === 0) {
      return this._failJob(jobState, 'validate', {
        code:    'NO_VALID_ITEMS',
        message: 'No items passed validation',
      })
    }

    if (requiresReview) {
      jobState.requiresReview = true
      jobState.reviewReasons.push(...reviewReasons)
    }

    // Step 5: Enrich
    const enrichResult = await this._dispatch('enrich-items', {
      items:   validItems,
      analysis,
      enrichmentConfig: { addDescriptions: true, normalizeCategories: false, addTags: true },
    }, jobState)
    jobState.stageBreakdown.enrich = {
      costUsd:   enrichResult.metrics?.costUsd   || 0,
      latencyMs: enrichResult.metrics?.latencyMs || 0,
    }

    // Enrichment failure is non-fatal — fall back to validated items
    const finalItems = enrichResult.success
      ? enrichResult.result.enrichedItems
      : validItems

    if (!enrichResult.success) {
      const msg = `Enrichment failed — using non-enriched items (${enrichResult.error?.message})`
      jobState.warnings.push(msg)
      jobState.requiresReview = true
      jobState.reviewReasons.push('enrichment failed')
    }

    // Cost alert check
    const alert = checkAlerts({
      jobId:        jobState.jobId,
      totalCostUsd: jobState.cumulativeCost,
      latencyMs:    Date.now() - jobState.startedAt,
    })
    if (alert.abort) {
      return this._failJob(jobState, 'cost-check', { code: 'COST_ABORT', message: alert.reason })
    }

    // Build nested catalog from flat items
    const catalog = buildCatalogFromItems(finalItems, analysis, merchantName)

    jobState.status      = jobState.requiresReview ? 'requires_review' : 'success'
    jobState.completedAt = Date.now()

    // Emit structured summary
    recordJobSummary({
      jobId:                   jobState.jobId,
      totalCostUsd:            jobState.cumulativeCost,
      costExtraction:          jobState.stageBreakdown.extract?.costUsd || 0,
      costEnrichment:          jobState.stageBreakdown.enrich?.costUsd  || 0,
      totalLatencyMs:          jobState.completedAt - jobState.startedAt,
      itemsExtracted:          finalItems.length,
      nullPriceRate:           qualityReport.nullPriceRate,
      modelUsed:               'gpt-4o / gpt-4o-mini',
      promptVersionExtraction: EXTRACT_VERSION,
      promptVersionEnrichment: ENRICH_VERSION,
      warnings:                jobState.warnings,
      outcome:                 jobState.status,
      requiresReview:          jobState.requiresReview,
    })

    return {
      jobId:          jobState.jobId,
      status:         jobState.status,
      catalog,
      itemCount:      finalItems.length,
      qualityReport,
      metrics: {
        totalCostUsd:   jobState.cumulativeCost,
        totalLatencyMs: jobState.completedAt - jobState.startedAt,
        stageBreakdown: jobState.stageBreakdown,
      },
      warnings:       jobState.warnings,
      requiresReview: jobState.requiresReview,
      reviewReasons:  jobState.reviewReasons,
      promptVersions: {
        extraction: EXTRACT_VERSION,
        enrichment: ENRICH_VERSION,
        analysis:   ANALYZE_VERSION,
      },
    }
  }

  // ── Text pipeline (full 5-agent flow) ─────────────────────────────────────

  async _executeTextPipeline(request, jobState) {
    const { url, rawContent, format, merchantName } = request

    // Step 1: Fetch
    const fetchResult = await this._dispatch('fetch-content', {
      url, rawContent, format: format || 'text',
    }, jobState)
    jobState.stageBreakdown.fetch = { costUsd: 0, latencyMs: fetchResult.metrics?.latencyMs || 0 }

    if (!fetchResult.success) return this._failJob(jobState, 'fetch', fetchResult.error)

    const { cleanText, chunks } = fetchResult.result

    // Step 2: Analyze
    const analyzeResult = await this._dispatch('analyze-content', {
      text:   chunks[0] || cleanText.slice(0, 3000),
      source: url || null,
    }, jobState)
    jobState.stageBreakdown.analyze = {
      costUsd:   analyzeResult.metrics?.costUsd   || 0,
      latencyMs: analyzeResult.metrics?.latencyMs || 0,
    }

    if (!analyzeResult.success) return this._failJob(jobState, 'analyze', analyzeResult.error)

    const analysis = analyzeResult.result

    // Quality gate: content recognition
    if (analysis.confidence < MIN_ANALYSIS_CONFIDENCE) {
      return this._failJob(jobState, 'analyze', {
        code:    'CONTENT_NOT_RECOGNIZED',
        message: `Content not recognized as a catalog (confidence: ${analysis.confidence.toFixed(2)})`,
      })
    }

    // Step 3: Extract
    const extractResult = await this._dispatch('extract-catalog', {
      chunks:   chunks.length > 0 ? chunks : [cleanText],
      analysis,
    }, jobState)
    jobState.stageBreakdown.extract = {
      costUsd:   extractResult.metrics?.costUsd   || 0,
      latencyMs: extractResult.metrics?.latencyMs || 0,
    }

    if (!extractResult.success) return this._failJob(jobState, 'extract', extractResult.error)

    return this._continueFromItems(extractResult.result.items, analysis, merchantName, jobState)
  }

  // ── Image pipeline (skip Fetch + Analyze) ─────────────────────────────────

  async _executeImagePipeline(request, jobState) {
    const { imageBase64, mimeType, merchantName } = request

    const extractResult = await this._dispatch('extract-catalog-image', {
      imageBase64, mimeType,
    }, jobState)
    jobState.stageBreakdown.extract = {
      costUsd:   extractResult.metrics?.costUsd   || 0,
      latencyMs: extractResult.metrics?.latencyMs || 0,
    }

    if (!extractResult.success) return this._failJob(jobState, 'extract', extractResult.error)

    return this._continueFromItems(extractResult.result.items, null, merchantName, jobState)
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  /**
   * @param {object} request
   * @param {string}  [request.jobId]        - Pre-assigned job ID (optional)
   * @param {string}  [request.url]          - URL to fetch
   * @param {string}  [request.rawContent]   - Pre-fetched text content
   * @param {string}  [request.format]       - 'html' | 'text'
   * @param {string}  [request.imageBase64]  - Base64 image (triggers image pipeline)
   * @param {string}  [request.mimeType]     - MIME type for image
   * @param {string}  [request.merchantName] - Optional merchant name hint
   */
  async executePipeline(request) {
    const jobId = request.jobId || generateId()

    const jobState = {
      jobId,
      status:         'running',
      cumulativeCost: 0,
      jobContext:     { cumulativeCostUsd: 0, callCount: 0 },
      warnings:       [],
      requiresReview: false,
      reviewReasons:  [],
      stageBreakdown: {},
      startedAt:      Date.now(),
      completedAt:    null,
    }

    try {
      if (request.imageBase64) {
        return await this._executeImagePipeline(request, jobState)
      }
      return await this._executeTextPipeline(request, jobState)
    } catch (err) {
      console.error('[CatalogOrchestrator] Unhandled error:', err)
      return this._failJob(jobState, 'unknown', { code: 'UNHANDLED', message: err.message })
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const catalogOrchestrator = new CatalogOrchestrator()
