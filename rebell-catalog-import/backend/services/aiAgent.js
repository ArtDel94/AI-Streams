import OpenAI from 'openai'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const EXTRACT_SYSTEM = `You are a catalog extraction agent. Your job is to extract every product, dish, or service from the merchant's input and return a perfectly structured JSON catalog.

Rules:
- Extract EVERYTHING. Do not skip any item.
- Preserve the merchant's own category names exactly as they appear. Do not rename, merge, or reorder categories.
- If there are no visible categories, infer logical groupings from the content.
- For price: extract the numeric value only (no currency symbols). Prices may appear before or after the currency symbol (e.g. "€ 10.50", "10,50 €", "10.50€", "$12"). Use period as decimal separator in the output. If price is missing or unclear, set to null.
- For description: the input may come from a web scrape where text blocks are concatenated without clear structure. A line starting with "INGREDIENTI:", "Pasta fresca", "Cestino", or similar is likely a product description. If the visible name is ambiguous or missing, infer the product name from the description. If no description is present, set to null — do not invent one.
- Allergen information (e.g. "ALLERGENI: latte, glutine...") should be extracted as tags, not included in the description.
- For tags: extract dietary info, allergens, labels (e.g. "Popolare", "Vegano"). If none visible, set to empty array.
- Confidence: "high" if name + price both clear. "medium" if price missing or name inferred from description. "low" if name and price are both unclear.
- Ignore navigation links, footer text, cookie notices, and UI chrome (e.g. "Registrati", "Scarica la app", "© Deliveroo", "Aggiungi al carrello").

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
            type: 'image_url',
            image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` }
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

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 8192,
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      ...messages,
    ],
  })

  const raw = response.choices[0]?.message?.content || ''
  const catalog = safeParseJson(raw)

  if (!catalog) {
    console.warn('OpenAI returned unparseable response:', raw.slice(0, 200))
    return { merchant_name: merchantName || null, currency: '€', categories: [], extraction_notes: 'AI returned unparseable response' }
  }

  return catalog
}

export async function enrichProducts(catalog) {
  const toEnrich = []
  catalog.categories.forEach((cat, catIdx) => {
    cat.products.forEach((product, prodIdx) => {
      if (!product.description) {
        toEnrich.push({ catIdx, prodIdx, name: product.name, category: cat.name })
      }
    })
  })

  if (toEnrich.length === 0) return

  const BATCH_SIZE = 20
  for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
    const batch = toEnrich.slice(i, i + BATCH_SIZE)
    const batchInput = batch.map((item, idx) => ({ index: idx, name: item.name, category: item.category }))

    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: ENRICH_SYSTEM },
          { role: 'user', content: JSON.stringify(batchInput) },
        ],
      })

      const raw = response.choices[0]?.message?.content || ''
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

  catalog.categories.forEach(cat => {
    cat.products.forEach(product => {
      if (product.description_generated === undefined) {
        product.description_generated = false
      }
    })
  })
}
