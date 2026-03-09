/**
 * ItemValidatorAgent — Agent 4
 *
 * Validates extracted items against schema, deduplicates, runs sanity checks,
 * and produces a quality report. No AI calls — pure deterministic logic.
 */

import { BaseAgent } from '../../BaseAgent.js'

const MAX_NAME_LENGTH           = 200
const MAX_CATEGORY_LENGTH       = 100
const MAX_DESCRIPTION_LENGTH    = 1000
const PRICE_REVIEW_THRESHOLD    = 10000
const NULL_PRICE_RATE_REVIEW    = 0.80
const SCHEMA_FAIL_RATE_REVIEW   = 0.50
const MIN_ITEMS_REVIEW          = 3
const ITEM_COUNT_DEVIATION_REVIEW = 0.50

function normalizeStr(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ')
}

function validateSchema(item) {
  const errors = []

  // name
  if (typeof item.name !== 'string' || !item.name.trim()) {
    errors.push('name missing or empty')
  } else if (item.name.length > MAX_NAME_LENGTH) {
    errors.push(`name too long (${item.name.length} chars)`)
  } else if (/^\d+$/.test(item.name.trim())) {
    errors.push('name is only digits')
  } else if (item.name.trim().length === 1) {
    errors.push('name is a single character')
  }

  // price
  if (item.price !== null && item.price !== undefined) {
    if (typeof item.price !== 'number' || isNaN(item.price)) {
      errors.push('price must be a number or null')
    } else if (item.price < 0) {
      errors.push(`negative price: ${item.price}`)
    }
  }

  // category (optional)
  if (item.category !== null && item.category !== undefined) {
    if (typeof item.category !== 'string') errors.push('category must be string or null')
    else if (item.category.length > MAX_CATEGORY_LENGTH) errors.push('category name too long')
  }

  // description (optional) — truncate rather than reject
  if (item.description !== null && item.description !== undefined) {
    if (typeof item.description !== 'string') {
      errors.push('description must be string or null')
    } else if (item.description.length > MAX_DESCRIPTION_LENGTH) {
      item.description = item.description.slice(0, MAX_DESCRIPTION_LENGTH)
    }
  }

  return { valid: errors.length === 0, errors }
}

export class ItemValidatorAgent extends BaseAgent {
  constructor() {
    super({ agentId: 'item-validator', capabilities: ['validate-items'] })
  }

  async execute(task) {
    const t0 = Date.now()
    const { items = [], analysis } = task.payload

    const validItems     = []
    const rejectedItems  = []
    let schemaFailCount  = 0
    let duplicatesRemoved = 0
    const reviewReasons  = []
    const seen           = new Map()   // dedupe key → item (kept for replacement logic)

    for (const item of items) {
      // ── Schema validation ────────────────────────────────────────────────
      const { valid, errors } = validateSchema(item)
      if (!valid) {
        schemaFailCount++
        rejectedItems.push({ ...item, _rejectionReasons: errors })
        continue
      }

      // ── Duplicate detection ──────────────────────────────────────────────
      const key = `${normalizeStr(item.name)}::${normalizeStr(item.category)}`
      if (seen.has(key)) {
        const existing   = seen.get(key)
        const existScore = Object.values(existing).filter(v => v !== null && v !== undefined).length
        const newScore   = Object.values(item).filter(v => v !== null && v !== undefined).length
        // Keep the more complete item
        if (newScore > existScore) {
          const idx = validItems.findIndex(i =>
            `${normalizeStr(i.name)}::${normalizeStr(i.category)}` === key
          )
          if (idx >= 0) validItems[idx] = item
          seen.set(key, item)
        }
        duplicatesRemoved++
        continue
      }
      seen.set(key, item)
      validItems.push(item)
    }

    const totalInput    = items.length
    const totalValid    = validItems.length
    const totalRejected = rejectedItems.length + duplicatesRemoved

    // ── Rate calculations ────────────────────────────────────────────────────
    const nullPriceRate  = totalValid > 0
      ? validItems.filter(i => i.price === null || i.price === undefined).length / totalValid
      : 0
    const duplicateRate  = totalInput > 0 ? duplicatesRemoved / totalInput : 0
    const schemaFailRate = totalInput > 0 ? schemaFailCount   / totalInput : 0

    // ── Price > threshold ────────────────────────────────────────────────────
    const highPriceItems = validItems.filter(
      i => typeof i.price === 'number' && i.price > PRICE_REVIEW_THRESHOLD
    )
    if (highPriceItems.length > 0) {
      reviewReasons.push(`${highPriceItems.length} item(s) with price > ${PRICE_REVIEW_THRESHOLD}`)
    }

    // ── Quality gates → requiresReview ───────────────────────────────────────
    let requiresReview = false

    if (totalValid === 0) {
      requiresReview = true
      reviewReasons.push('no items passed validation')
    } else if (totalValid < MIN_ITEMS_REVIEW) {
      requiresReview = true
      reviewReasons.push(`very few items extracted: ${totalValid}`)
    }

    if (analysis?.hasPrices && nullPriceRate > NULL_PRICE_RATE_REVIEW) {
      requiresReview = true
      reviewReasons.push(`${(nullPriceRate * 100).toFixed(0)}% null prices (content was expected to have prices)`)
    }

    if (schemaFailRate > SCHEMA_FAIL_RATE_REVIEW) {
      requiresReview = true
      reviewReasons.push(`high schema failure rate: ${(schemaFailRate * 100).toFixed(0)}%`)
    }

    if (analysis?.estimatedItemCount > 0) {
      const deviation = Math.abs(totalValid - analysis.estimatedItemCount) / analysis.estimatedItemCount
      if (deviation > ITEM_COUNT_DEVIATION_REVIEW) {
        requiresReview = true
        reviewReasons.push(
          `item count deviation: estimated ${analysis.estimatedItemCount}, got ${totalValid} (${(deviation * 100).toFixed(0)}% off)`
        )
      }
    }

    if (highPriceItems.length > 0) requiresReview = true

    return this._ok({
      validItems,
      rejectedItems,
      duplicatesRemoved,
      qualityReport: {
        totalInput,
        totalValid,
        totalRejected,
        nullPriceRate:   +nullPriceRate.toFixed(3),
        duplicateRate:   +duplicateRate.toFixed(3),
        schemaFailRate:  +schemaFailRate.toFixed(3),
        estimatedVsActual: {
          estimated: analysis?.estimatedItemCount || 0,
          actual:    totalValid,
          deviation: analysis?.estimatedItemCount > 0
            ? +((Math.abs(totalValid - analysis.estimatedItemCount) / analysis.estimatedItemCount) * 100).toFixed(1)
            : null,
        },
      },
      requiresReview,
      reviewReasons,
    }, { latencyMs: Date.now() - t0 })
  }
}
