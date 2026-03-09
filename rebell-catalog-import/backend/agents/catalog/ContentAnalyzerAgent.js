/**
 * ContentAnalyzerAgent — Agent 2
 *
 * Classifies content type, language, and structure using gpt-4o-mini.
 * Fast and cheap — its output drives downstream agent behavior.
 */

import { BaseAgent } from '../../BaseAgent.js'
import { callOpenAI, safeParseJson } from '../../../services/openaiGateway.js'
import { ANALYZE_SYSTEM, PROMPT_VERSION } from './prompts/analyzeContent.js'

const ANALYSIS_TEXT_LIMIT = 3000

export class ContentAnalyzerAgent extends BaseAgent {
  constructor() {
    super({ agentId: 'content-analyzer', capabilities: ['analyze-content'] })
  }

  async execute(task) {
    const t0 = Date.now()
    const { text, source }    = task.payload
    const { jobId, jobContext } = task.context || {}

    // Only send a snippet — classification doesn't need the full text
    const snippet     = (text || '').slice(0, ANALYSIS_TEXT_LIMIT)
    const userContent = source ? `Source: ${source}\n\n${snippet}` : snippet

    const result = await callOpenAI({
      messages: [
        { role: 'system', content: ANALYZE_SYSTEM },
        { role: 'user',   content: userContent },
      ],
      maxTokens:  400,
      stage:      'analysis',
      jobId,
      expectJson: true,
      jobContext,
    })

    const latencyMs = Date.now() - t0

    if (!result.success) {
      return this._fail(
        result.error?.code || 'AI_ERROR',
        result.error?.message || 'Content analysis failed',
        { costUsd: result.costUsd, latencyMs, callCount: 1 }
      )
    }

    const raw = safeParseJson(result.content)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return this._fail('PARSE_ERROR', 'Could not parse analysis JSON', { costUsd: result.costUsd, latencyMs, callCount: 1 })
    }

    // Normalize with safe defaults
    const analysis = {
      contentType:         String(raw.contentType        || 'unknown'),
      language:            String(raw.language           || 'en'),
      structureLevel:      String(raw.structureLevel     || 'medium'),
      estimatedItemCount:  Math.max(0, Number(raw.estimatedItemCount) || 0),
      hasCategories:       Boolean(raw.hasCategories),
      hasPrices:           Boolean(raw.hasPrices),
      confidence:          Math.min(1, Math.max(0, Number(raw.confidence) || 0)),
      extractionHints:     String(raw.extractionHints    || ''),
      promptVersion:       PROMPT_VERSION,
    }

    return this._ok(analysis, { costUsd: result.costUsd, latencyMs, callCount: 1 })
  }
}
