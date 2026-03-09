export const PROMPT_VERSION = 'catalog-extract-agent-v1'

const BASE_EXTRACTION_RULES = `EXTRACTION RULES:
1. Extract EVERY item — zero tolerance for skipped items. When in doubt, include it.
2. Names: use original text exactly as written, in the original language. Never translate.
3. Prices: numeric value only, period as decimal separator (e.g. "10,50€" → 10.50). null if missing or unclear. NEVER guess prices.
4. Price ranges ("8-12€", "from €8"): use the lower bound as "price".
5. Category: the section/group header this item belongs to. null if no clear grouping.
6. Description: visible text associated with the item. null if nothing is visible. Never invent.
7. Currency: ISO 4217 code (EUR, USD, GBP, CHF, etc.) or null if not detectable.
8. Noise to SKIP: navigation links, footer text, cookie notices, "Add to cart" buttons, app banners, login prompts, platform branding (Deliveroo, Uber Eats, etc.)
9. Combos/bundles: extract as a single item. Use the total/combo price.
10. If you are unsure whether something is a real item or noise: include it.`

/**
 * Build a dynamic system prompt for catalog extraction based on content analysis.
 *
 * @param {object|null} analysis - From ContentAnalyzerAgent
 * @returns {string} System prompt string
 */
export function buildExtractionSystemPrompt(analysis) {
  const type     = analysis?.contentType?.replace(/-/g, ' ') || 'catalog'
  const lang     = analysis?.language
  const hasPrice = analysis?.hasPrices
  const hasCats  = analysis?.hasCategories
  const hints    = analysis?.extractionHints

  const lines = [
    `You are a catalog extraction agent. Extract all items from this ${type}.`,
    '',
    lang && lang !== 'en'
      ? `The content is in ${lang}. Extract item names exactly as written in the original language.`
      : '',
    hasPrice === false
      ? 'This content may not have prices — set price to null if not present.'
      : 'Extract prices as numbers (no currency symbols).',
    hasCats
      ? 'Preserve the original category/section names exactly as written.'
      : 'Infer a reasonable category for each item based on context, or use null.',
    hints ? `Extraction context: ${hints}` : '',
    '',
    BASE_EXTRACTION_RULES,
    '',
    'Return ONLY a valid JSON array. No markdown. No explanation. No backticks.',
    'Schema: [{ "name": string, "category": string|null, "price": number|null, "currency": string|null, "description": string|null }]',
  ].filter(l => l !== undefined && l !== null)

  return lines.join('\n')
}
