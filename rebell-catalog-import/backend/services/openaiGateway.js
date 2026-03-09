/**
 * OpenAI Gateway — single entry point for all model calls.
 *
 * No other file imports the OpenAI client directly.
 * Responsibilities: timeout, retry, circuit breaker, model routing,
 * cost computation, response caching, PII sanitization, JSON guardrail,
 * per-job cost/call governance, and metrics emission.
 */

import OpenAI from 'openai'
import crypto from 'crypto'
import { recordCall } from './aiMetrics.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_TIMEOUT_MS   = 60000
const MAX_INPUT_CHARS     = 60000
const CACHE_TTL_MS        = 86400000  // 24 hours
const MINI_THRESHOLD_CHARS = 2500
export const MAX_JOB_COST_USD  = 0.25
export const MAX_CALLS_PER_JOB = 20

const PRICING = {
  'gpt-4o':      { input: 5.00  / 1_000_000, output: 15.00 / 1_000_000 },
  'gpt-4o-mini': { input: 0.15  / 1_000_000, output:  0.60 / 1_000_000 },
}

// ─── Model Router ─────────────────────────────────────────────────────────────

export function selectModel(stage, inputChars) {
  if (stage === 'enrichment') return 'gpt-4o-mini'
  if (inputChars < MINI_THRESHOLD_CHARS) return 'gpt-4o-mini'
  return 'gpt-4o'
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

const CB_CONFIG = {
  maxFailures: 5,
  windowMs:    60000,
  cooldownMs:  120000,
}

const circuitState = {
  failures:  [],    // failure timestamps
  openedAt:  null,  // timestamp circuit was opened
  halfOpen:  false,
}

function getCircuitStatus() {
  const now = Date.now()
  // Evict stale failures
  circuitState.failures = circuitState.failures.filter(t => t > now - CB_CONFIG.windowMs)

  if (circuitState.openedAt) {
    if (now - circuitState.openedAt >= CB_CONFIG.cooldownMs) {
      circuitState.halfOpen = true
      return 'half-open'
    }
    return 'open'
  }

  if (circuitState.failures.length >= CB_CONFIG.maxFailures) {
    circuitState.openedAt = now
    circuitState.halfOpen = false
    return 'open'
  }

  return 'closed'
}

function recordCircuitFailure() {
  circuitState.failures.push(Date.now())
  const recentCount = circuitState.failures.filter(t => t > Date.now() - CB_CONFIG.windowMs).length
  if (recentCount >= CB_CONFIG.maxFailures && !circuitState.openedAt) {
    circuitState.openedAt = Date.now()
    circuitState.halfOpen = false
    console.error('[gateway] Circuit breaker OPENED')
  }
}

function recordCircuitSuccess() {
  if (circuitState.halfOpen) {
    circuitState.openedAt = null
    circuitState.halfOpen = false
    circuitState.failures  = []
    console.log('[gateway] Circuit breaker CLOSED (half-open test passed)')
  }
}

// ─── Response Cache ────────────────────────────────────────────────────────────

const responseCache = new Map()

function buildCacheKey(model, messages) {
  const payload = JSON.stringify({ model, messages })
  return crypto.createHash('sha256').update(payload).digest('hex')
}

function getCached(key) {
  const entry = responseCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { responseCache.delete(key); return null }
  return entry.result
}

function setCached(key, result) {
  responseCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ─── PII Sanitization ─────────────────────────────────────────────────────────

export function sanitizeInput(text) {
  text = text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]')
  text = text.replace(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[PHONE_REDACTED]')
  text = text.replace(/(?:sk|pk|api|key|token)[-_]?[a-zA-Z0-9]{20,}/gi, '[KEY_REDACTED]')
  return text
}

// ─── JSON Helper ──────────────────────────────────────────────────────────────

export function safeParseJson(raw) {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try { return JSON.parse(cleaned) } catch { return null }
}

// ─── Cost Computation ─────────────────────────────────────────────────────────

function computeCost(model, usage) {
  const p = PRICING[model]
  if (!p || !usage) return 0
  return (usage.prompt_tokens || 0) * p.input + (usage.completion_tokens || 0) * p.output
}

// ─── Transient Error Detection ────────────────────────────────────────────────

const TRANSIENT_CODES = new Set([429, 500, 502, 503, 504])

function isTransient(err) {
  const status = err?.status ?? err?.response?.status
  return TRANSIENT_CODES.has(status)
}

// ─── Main Gateway ─────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}  [opts.model]           - Override model selection
 * @param {Array}   opts.messages          - Chat messages array
 * @param {number}  [opts.maxTokens]       - max_tokens for completion
 * @param {number}  [opts.temperature]     - temperature override
 * @param {string}  [opts.stage]           - 'extraction' | 'enrichment' (used for routing + logging)
 * @param {string}  [opts.jobId]           - Job ID for tracing
 * @param {boolean} [opts.expectJson]      - Enable JSON guardrail (retry on invalid JSON)
 * @param {object}  [opts.responseFormat]  - OpenAI response_format object
 * @param {object}  [opts.jobContext]      - Mutable { cumulativeCostUsd, callCount } — for governance
 *
 * @returns {{ content, usage, costUsd, latencyMs, model, success, cached?, error? }}
 */
export async function callOpenAI({
  model: modelOverride,
  messages,
  maxTokens,
  temperature,
  stage,
  jobId,
  expectJson = false,
  responseFormat,
  jobContext,
} = {}) {
  const startMs = Date.now()

  // ── Per-job governance ────────────────────────────────────────────────────
  if (jobContext) {
    if (jobContext.cumulativeCostUsd >= MAX_JOB_COST_USD) {
      const msg = `Job cost ceiling reached ($${jobContext.cumulativeCostUsd.toFixed(4)} >= $${MAX_JOB_COST_USD})`
      console.error(`[gateway] ${msg}`)
      return _fail(msg, 'COST_LIMIT', false, startMs, stage, jobId)
    }
    if (jobContext.callCount >= MAX_CALLS_PER_JOB) {
      const msg = `Max calls per job exceeded (${jobContext.callCount} >= ${MAX_CALLS_PER_JOB})`
      console.error(`[gateway] ${msg}`)
      return _fail(msg, 'CALL_LIMIT', false, startMs, stage, jobId)
    }
  }

  // ── PII sanitization ──────────────────────────────────────────────────────
  const safeMessages = messages.map(m => ({
    ...m,
    content: typeof m.content === 'string' ? sanitizeInput(m.content) : m.content,
  }))

  // ── Input length cap ──────────────────────────────────────────────────────
  const inputChars = safeMessages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0
  )
  if (inputChars > MAX_INPUT_CHARS) {
    console.warn(`[gateway] Input too long (${inputChars} chars) — truncating to ${MAX_INPUT_CHARS}`)
    const lastUserIdx = [...safeMessages].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === 'user')?.i
    if (lastUserIdx !== undefined) {
      const excess = inputChars - MAX_INPUT_CHARS
      const content = safeMessages[lastUserIdx].content
      if (typeof content === 'string') {
        safeMessages[lastUserIdx] = { ...safeMessages[lastUserIdx], content: content.slice(0, content.length - excess) }
      }
    }
  }

  // ── Circuit breaker ───────────────────────────────────────────────────────
  const circuit = getCircuitStatus()
  if (circuit === 'open') {
    const msg = 'Circuit breaker open — OpenAI calls suspended'
    console.error(`[gateway] ${msg}`)
    recordCall({ jobId, stage, model: 'none', inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - startMs, success: false, error: msg, circuitState: circuit })
    return _fail(msg, 'CIRCUIT_OPEN', false, startMs, stage, jobId)
  }

  // ── Model selection ───────────────────────────────────────────────────────
  const model = modelOverride || selectModel(stage, inputChars)

  // ── Cache lookup ──────────────────────────────────────────────────────────
  const cacheKey = buildCacheKey(model, safeMessages)
  const cached = getCached(cacheKey)
  if (cached) {
    console.log(`[gateway] Cache hit — ${model}, stage=${stage}, job=${jobId}`)
    recordCall({ jobId, stage, model, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, success: true, cached: true, circuitState: circuit })
    return { ...cached, cached: true, costUsd: 0 }
  }

  // ── Build params ──────────────────────────────────────────────────────────
  const params = {
    model,
    messages: safeMessages,
    ...(maxTokens       && { max_tokens: maxTokens }),
    ...(temperature !== undefined && { temperature }),
    ...(responseFormat  && { response_format: responseFormat }),
  }

  // ── Attempt loop (up to 2 attempts) ──────────────────────────────────────
  let attempt = 0
  let lastErr  = null
  let retryAttempted = false
  let currentParams  = params

  while (attempt <= 1) {
    try {
      const response = await Promise.race([
        client.chat.completions.create(currentParams),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OpenAI request timed out')), OPENAI_TIMEOUT_MS)
        ),
      ])

      const latencyMs  = Date.now() - startMs
      const usage      = response.usage
      const content    = response.choices[0]?.message?.content || ''
      const usedModel  = response.model || model
      const costUsd    = computeCost(model, usage)
      const inputTokens  = usage?.prompt_tokens     || 0
      const outputTokens = usage?.completion_tokens || 0

      // ── JSON guardrail ────────────────────────────────────────────────────
      if (expectJson) {
        const parsed = safeParseJson(content)
        if (!parsed) {
          if (attempt === 0) {
            retryAttempted = true
            currentParams = {
              ...params,
              messages: [
                ...safeMessages,
                { role: 'assistant', content },
                { role: 'user', content: 'Your response was not valid JSON. Return ONLY valid JSON, no markdown, no explanation.' },
              ],
            }
            attempt++
            console.warn(`[gateway] JSON parse failed — retrying with correction prompt (stage=${stage})`)
            continue
          } else {
            // Second failure — mark for review
            recordCircuitFailure()
            recordCall({ jobId, stage, model: usedModel, inputTokens, outputTokens, costUsd, latencyMs, success: false, error: 'JSON_PARSE_ERROR', retryAttempted: true, circuitState: circuit })
            if (jobContext) { jobContext.cumulativeCostUsd += costUsd; jobContext.callCount++ }
            return {
              content: null,
              error: { message: 'Invalid JSON after retry — job flagged for review', code: 'JSON_PARSE_ERROR', retryAttempted: true, requiresReview: true },
              usage: { inputTokens, outputTokens },
              costUsd,
              latencyMs,
              model: usedModel,
              success: false,
            }
          }
        }
      }

      // ── Success ───────────────────────────────────────────────────────────
      recordCircuitSuccess()
      const result = {
        content,
        usage: { inputTokens, outputTokens },
        costUsd,
        latencyMs,
        model: usedModel,
        success: true,
      }
      setCached(cacheKey, result)
      recordCall({ jobId, stage, model: usedModel, inputTokens, outputTokens, costUsd, latencyMs, success: true, retryAttempted, circuitState: circuit })
      if (jobContext) { jobContext.cumulativeCostUsd += costUsd; jobContext.callCount++ }
      return result

    } catch (err) {
      lastErr = err
      if (attempt === 0 && isTransient(err)) {
        retryAttempted = true
        const delay = 2000 * (attempt + 1)
        console.warn(`[gateway] Transient error (${err.status || err.message}) — retry in ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
        attempt++
      } else {
        break
      }
    }
  }

  // ── Retry exhausted ───────────────────────────────────────────────────────
  recordCircuitFailure()
  const latencyMs = Date.now() - startMs
  recordCall({ jobId, stage, model, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs, success: false, error: lastErr?.message || 'Unknown', retryAttempted, circuitState: getCircuitStatus() })
  return {
    content: null,
    error: { message: lastErr?.message || 'Unknown error', code: String(lastErr?.status || 'UNKNOWN'), retryAttempted },
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    latencyMs,
    success: false,
  }
}

// ─── Internal helper ─────────────────────────────────────────────────────────

function _fail(message, code, retryAttempted, startMs, stage, jobId) {
  return {
    content: null,
    error: { message, code, retryAttempted },
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    latencyMs: Date.now() - startMs,
    success: false,
  }
}
