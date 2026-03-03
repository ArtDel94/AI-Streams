import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const EXTRACT_SYSTEM = `You are a catalog extraction agent. Your job is to extract every product, dish, or service from the merchant's input and return a perfectly structured JSON catalog.

Rules:
- Extract EVERYTHING. Do not skip items.
- Preserve the merchant's own category names exactly as they appear. Do not rename, merge, or reorder categories.
- If there are no visible categories, infer logical groupings from the content.
- For price: extract the numeric value only (no currency symbols). If price is missing or unclear, set to null.
- For description: if the menu has a description for the item, use it verbatim. If not, set to null (do not invent descriptions at this stage).
- For tags: extract any tags visible in the source (dietary info, allergens, spice level, etc.). If none visible, set to empty array.
- Confidence: "high" if name + price both clear. "medium" if price missing or category uncertain. "low" if name is ambiguous or item is unclear.

Return ONLY valid JSON. No markdown. No explanation. No backticks.

JSON structure:
{
  "merchant_name": "string or null",
  "currency": "detected currency symbol or EUR if unknown",
  "categories": [
    {
      "name": "Category name exactly as in source",
      "products": [
        {
          "name": "string",
          "description": "string or null",
          "price": number or null,
          "tags": ["string"],
          "confidence": "high | medium | low",
          "low_confidence_reason": "string or null"
        }
      ]
    }
  ],
  "extraction_notes": "any issues or observations about the source material"
}`

const ENRICH_SYSTEM = `You are a product description writer. Given a list of products from a merchant's catalog, write a short, accurate description for each one.

Rules:
- Keep descriptions between 20-60 words
- Be factual and appetizing (for food) or informative (for other products)
- Do not invent ingredients or features that weren't in the original menu
- If the product name alone gives enough info, a 1-sentence description is fine
- Return ONLY valid JSON array. No markdown. No explanation.

Format: [{ "index": 0, "description": "string" }, ...]`

function safeParseJson(raw) {
  // Strip markdown fences if present
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

export async function extractCatalog(input, merchantName) {
  const messages = input.type === 'image'
    ? [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: input.mimeType, data: input.imageBase64 }
          },
          { type: 'text', text: 'Extract the complete product catalog from this image.' }
        ]
      }]
    : [{
        role: 'user',
        content: merchantName
          ? `Merchant: ${merchantName}\n\n${input.content}`
          : input.content
      }]

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    system: EXTRACT_SYSTEM,
    messages,
  })

  const raw = response.content[0]?.text || ''
  const catalog = safeParseJson(raw)

  if (!catalog) {
    console.warn('Claude returned unparseable response:', raw.slice(0, 200))
    return { merchant_name: merchantName || null, currency: '€', categories: [], extraction_notes: 'AI returned unparseable response' }
  }

  return catalog
}

export async function enrichProducts(catalog) {
  // Collect all products that need descriptions
  const toEnrich = []
  catalog.categories.forEach((cat, catIdx) => {
    cat.products.forEach((product, prodIdx) => {
      if (!product.description) {
        toEnrich.push({ catIdx, prodIdx, name: product.name, category: cat.name })
      }
    })
  })

  if (toEnrich.length === 0) return

  // Batch into groups of 20
  const BATCH_SIZE = 20
  for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
    const batch = toEnrich.slice(i, i + BATCH_SIZE)
    const batchInput = batch.map((item, idx) => ({ index: idx, name: item.name, category: item.category }))

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: ENRICH_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(batchInput) }],
      })

      const raw = response.content[0]?.text || ''
      const descriptions = safeParseJson(raw)

      if (Array.isArray(descriptions)) {
        descriptions.forEach(({ index, description }) => {
          const item = batch[index]
          if (item && description) {
            catalog.categories[item.catIdx].products[item.prodIdx].description = description
            catalog.categories[item.catIdx].products[item.prodIdx].description_generated = true
          }
        })
      }
    } catch (err) {
      console.warn('Enrich batch failed:', err.message)
    }
  }

  // Mark products that had original descriptions
  catalog.categories.forEach(cat => {
    cat.products.forEach(product => {
      if (product.description_generated === undefined) {
        product.description_generated = false
      }
    })
  })
}
