/**
 * Output validation and quality guardrails.
 *
 * Validates extracted catalog items against the expected schema,
 * removes invalid/duplicate items, and flags jobs for human review.
 */

const MAX_PRICE_WARN           = 10000
const SCHEMA_FAILURE_RATE_REVIEW = 0.50

/**
 * Validate a single catalog item.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateItem(item) {
  const errors = []
  if (typeof item.name !== 'string' || !item.name.trim()) {
    errors.push('name missing or empty')
  }
  if (item.price !== null && item.price !== undefined) {
    if (typeof item.price !== 'number') errors.push('price must be a number or null')
    else if (item.price < 0)            errors.push(`negative price: ${item.price}`)
  }
  return { valid: errors.length === 0, errors }
}

/**
 * Validate and clean an entire catalog in-place.
 *
 * Actions:
 * - Removes items that fail schema validation
 * - Removes items with negative prices
 * - Flags items with price > MAX_PRICE_WARN
 * - Removes exact duplicates (name + category key)
 * - Updates item_count
 * - Returns warnings and a requiresReview flag
 *
 * @param {object} catalog - Mutable catalog object
 * @returns {{ catalog, warnings: string[], flaggedForReview: boolean }}
 */
export function validateAndCleanCatalog(catalog) {
  const warnings        = []
  let removed           = 0
  let invalidCount      = 0
  let totalItems        = 0
  let flaggedForReview  = false

  const seen = new Map()  // deduplicate: "name|category" → true

  catalog.categories = catalog.categories.map(cat => {
    const items     = cat.items || cat.products || []
    const cleanItems = []

    for (const item of items) {
      totalItems++

      // ── Schema validation ────────────────────────────────────────────────
      const { valid, errors } = validateItem(item)
      if (!valid) {
        invalidCount++
        warnings.push(`Item "${item.name ?? '[unnamed]'}" removed — ${errors.join(', ')}`)
        console.warn(`[guardrails] Invalid item removed (${errors.join(', ')}):`, item.name)
        continue
      }

      // ── Negative price ───────────────────────────────────────────────────
      if (typeof item.price === 'number' && item.price < 0) {
        invalidCount++
        warnings.push(`Item "${item.name}" removed — negative price ${item.price}`)
        continue
      }

      // ── High price flag ──────────────────────────────────────────────────
      if (typeof item.price === 'number' && item.price > MAX_PRICE_WARN) {
        warnings.push(`Item "${item.name}" price ${item.price} > ${MAX_PRICE_WARN} — flagged for review`)
        flaggedForReview = true
      }

      // ── Duplicate detection ──────────────────────────────────────────────
      const key = `${(item.name || '').toLowerCase().trim()}|${(cat.name || '').toLowerCase().trim()}`
      if (seen.has(key)) {
        removed++
        warnings.push(`Duplicate removed: "${item.name}" in "${cat.name}"`)
        continue
      }
      seen.set(key, true)

      cleanItems.push(item)
    }

    // Normalize items key
    const updated = { ...cat, items: cleanItems }
    delete updated.products  // normalise to 'items'
    return updated
  })

  // ── Update item_count ────────────────────────────────────────────────────
  catalog.item_count = catalog.categories.reduce((s, c) => s + (c.items || []).length, 0)

  if (removed > 0) warnings.push(`${removed} duplicate(s) removed`)

  // ── Schema failure rate ──────────────────────────────────────────────────
  if (totalItems > 0 && invalidCount / totalItems > SCHEMA_FAILURE_RATE_REVIEW) {
    flaggedForReview = true
    warnings.push(`High schema failure rate: ${invalidCount}/${totalItems} items invalid`)
  }

  return { catalog, warnings, flaggedForReview }
}
