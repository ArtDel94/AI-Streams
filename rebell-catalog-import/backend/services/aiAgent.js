import OpenAI from 'openai'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const EXTRACT_SYSTEM = `You are a universal catalog extraction agent. Your job is to extract every
product, dish, item, or service from a merchant's input and return a
perfectly structured JSON catalog.

The input may be raw HTML, cleaned text, OCR output, or any combination.
It may be in any of these languages: English, Italian, Spanish, French,
German, Portuguese, or Dutch. The catalog may contain food, retail products,
services, or any combination.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EXTRACTION RULES (follow every single one):

1. COMPLETENESS
   - Extract EVERY item. Zero tolerance for skipped items.
   - When in doubt whether something is an item or noise, extract it and
     set confidence to "low".

2. CATEGORIES
   - Preserve the merchant's own category names EXACTLY as written, in
     the original language. Do not translate, rename, merge, split, or
     reorder them.
   - If no categories are visible, infer logical groupings from the
     content and set "categories_inferred": true at the top level.

3. NAMES
   - Use the item name exactly as the merchant wrote it, in the original
     language.
   - If no clear name exists but a description does, extract the first
     meaningful noun phrase from the description as the name.
   - If the name appears to be truncated or garbled (common in OCR),
     keep it as-is and set confidence to "medium" or "low".

4. PRICES
   - Extract the numeric value only. No currency symbols, no text.
   - Use a period (.) as the decimal separator in output, regardless of
     the source format.
   - Handle all common formats:
       "€10.50"  "10,50€"  "€ 10.50"  "10.50 EUR"  "$12"  "12,00"
       "CHF 8.50"  "R$ 25,90"  "£7.99"  "7.99£"
   - If a price range exists (e.g. "8-12€", "from €8"), extract as:
       "price": 8, "price_max": 12
     If only "from" with no upper bound: "price": 8, "price_max": null
   - If price is missing, illegible, or unclear: "price": null
     Do NOT guess or infer prices. null is always correct when unsure.

5. DESCRIPTIONS
   - Extract any visible description, ingredient list, or product detail
     text associated with the item.
   - Descriptions may appear as:
       • A line directly below the item name
       • An ingredient list (in any language: "Ingredients:", "Ingredienti:",
         "Ingrédients:", "Zutaten:", "Ingredientes:", "Ingrediënten:")
       • A parenthetical note after the name
       • A separate text block near the item in HTML/OCR layout
   - Keep extracted descriptions in the original language exactly as written.
   - If NO description is visible in the source: set "description": null
     and "description_generated": false. Do NOT invent descriptions.

6. COMBOS, BUNDLES, AND SETS
   - A combo/bundle is any item that groups multiple sub-items together
     under a single listing (e.g. "Family Meal Deal", "Cestino 5 Tigelle
     con...", "Burger + Fries + Drink", "Starter Kit").
   - ALWAYS keep combos as a SINGLE item. Never split them.
   - Set "is_combo": true
   - List sub-items in the "combo_items" array:
       "combo_items": [
         { "name": "Tigella Classica", "quantity": 5 },
         { "name": "Crema di Parmigiano", "quantity": 1 }
       ]
   - If sub-items have individual prices AND a combo/total price exists,
     use the combo price as the item price. Include sub-item prices only
     in combo_items:
       "combo_items": [
         { "name": "Burger", "price": 8.50 },
         { "name": "Fries", "price": 3.00 }
       ]
   - If ONLY a total price is shown, use that. Do not sum or calculate.
   - If NO total price exists but sub-items have individual prices,
     set "price": null (do not sum them — the merchant may intend a
     discount).

7. MODIFIERS AND ADD-ONS
   - Ignore size variants (S/M/L), add-ons ("+$2 bacon"), customization
     options, and topping choices entirely.
   - Do NOT extract these as separate items or fields.

8. ALLERGENS AND TAGS
   - Extract allergens from explicit allergen statements in any language:
       "Allergeni: latte, glutine"
       "Allergens: milk, gluten"
       "Allergènes: lait, gluten"
       "Allergenen: melk, gluten"
   - Also detect allergen icons/symbols if present (🥜 🌾 🥛 🐟 etc.)
   - Extract dietary and marketing labels as tags:
       Dietary: "Vegano", "Vegan", "Végétalien", "Vegetarisch",
       "Gluten-free", "Sans gluten", "Glutenfrei", "Bio", "Organic"
       Marketing: "Popolare", "Popular", "Best Seller", "Nieuw", "Nuovo",
       "Promo", "Limited Edition"
   - Only include tags explicitly stated in the source. Do NOT generate
     or infer tags.
   - Place allergens in "allergens": [...] (always lowercase, in the
     original language)
   - Place extracted labels in "tags": []

9. CONFIDENCE SCORING
   - "high"   → Default for any well-formed item. Use "high" whenever the name
                 is clearly readable AND a price is present — even for combos,
                 bundles, price ranges, or items in a foreign language.
                 The vast majority of items on a real menu should be "high".
   - "medium" → Use ONLY when the price is genuinely absent/null for an item
                 where a price is expected, OR the name could not be read
                 directly and had to be inferred from surrounding text.
   - "low"    → Use ONLY when the name is garbled, truncated, or unreadable
                 (poor OCR), OR when you are genuinely uncertain whether the
                 line is a product at all (possible noise).

10. NOISE FILTERING
    - IGNORE all of the following — they are NOT items:
        • Navigation elements (menu links, breadcrumbs, tabs)
        • Footer content (copyright, company info, social links)
        • Cookie/privacy notices
        • UI chrome (buttons like "Add to cart", "Registrati",
          "Ajouter", "In den Warenkorb", "Toevoegen")
        • Authentication prompts ("Login", "Sign up", "Registrati")
        • App promotion banners ("Download our app", "Scarica la app")
        • Delivery/shipping info unless it's a purchasable service
        • Platform branding ("© Deliveroo", "Powered by Shopify")
    - If something could be either an item or noise, extract it with
      confidence "low" rather than skip it.

11. CURRENCY DETECTION
    - Detect the primary currency from symbols, codes, or context.
    - Report it once at the top level as "currency": "EUR" (ISO 4217).
    - If mixed currencies appear, flag: "mixed_currencies": true
      and include "currency" on each item.
    - If no currency is detectable: "currency": null

12. PRODUCT IMAGES
    - If a ---STRUCTURED_DATA_JSON_LD--- block is present at the end of the
      input, scan it for image URLs associated with each product.
      Common locations: MenuItem.image, Product.image, offers.image
    - Set "image_url" to the full image URL if found for that product.
    - If no image is found in structured data: "image_url": null
    - Do NOT invent or guess image URLs.

13. INPUT QUALITY HANDLING
    - Raw HTML: Strip all tags. Focus on text content, alt attributes,
      aria-labels, and structured data (JSON-LD, microdata) if present.
    - OCR output: Expect spacing issues, merged words, misread characters
      (0/O, 1/l, rn/m). Be generous in interpretation. Flag low
      confidence when OCR quality is poor.
    - Cleaned text: May have lost structure. Use line proximity, indentation,
      and price-near-name heuristics to associate data.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OUTPUT FORMAT — Return ONLY this JSON. No markdown. No explanation.
No backticks. No preamble.

{
  "merchant_name": "string or null",
  "catalog_language": "it",
  "currency": "EUR",
  "categories_inferred": false,
  "mixed_currencies": false,
  "item_count": 42,
  "categories": [
    {
      "name": "Primi Piatti",
      "items": [
        {
          "name": "Spaghetti alla Carbonara",
          "description": "Pasta con guanciale, uovo, pecorino romano e pepe nero",
          "description_generated": false,
          "price": 12.50,
          "price_max": null,
          "image_url": null,
          "is_combo": false,
          "combo_items": [],
          "allergens": ["glutine", "uova", "latte"],
          "tags": ["Popolare"],
          "confidence": "high"
        }
      ]
    }
  ]
}

FIELD TYPES (strict):
- name:                 string (never null — if truly unreadable, use "[illegible]")
- description:          string | null (null if not found in source — do NOT invent)
- description_generated: boolean (always false during extraction — enrichment handles generation)
- price:                number | null (decimal, period separator)
- price_max:            number | null
- image_url:            string | null (from structured data only — never invented)
- is_combo:             boolean
- combo_items:          array of { name: string, quantity?: number, price?: number }
- allergens:            string[] (lowercase)
- tags:                 string[] (original casing)
- confidence:           "high" | "medium" | "low"`

const ENRICH_SYSTEM = `You are a product catalog enricher. For each product, return:

1. description — Write a short, accurate description (20-60 words). Be factual and appetizing (food) or informative (other products). Do NOT invent ingredients or features not implied by the name, existing description, or category. If the product already has a description, return it unchanged.
2. tags — Generate 2-5 short, relevant tags based on the product name, existing description, and category. Examples: "Chicken", "Grilled", "Vegetarian", "Spicy", "Bundle", "Sandwich", "Fried", "Seasonal", "Beef", "Fish", "Pizza", "Pasta". Tags should be concise (1-2 words), in the same language as the product name.

Return ONLY a valid JSON array. No markdown. No explanation.
Format: [{ "index": 0, "description": "string", "tags": ["tag1", "tag2"] }, ...]`

// Max input chars per chunk — gpt-4o extraction, lean schema (~50 tokens/item)
const CHUNK_SIZE = 14000

function safeParseJson(raw) {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

// Split text into chunks of ~CHUNK_SIZE chars, breaking on newlines
function chunkText(text) {
  if (text.length <= CHUNK_SIZE) return [text]
  const lines = text.split('\n')
  const chunks = []
  let current = ''
  for (const line of lines) {
    if (current.length + line.length + 1 > CHUNK_SIZE && current.length > 0) {
      chunks.push(current)
      current = ''
    }
    current += (current ? '\n' : '') + line
  }
  if (current) chunks.push(current)
  return chunks
}

// Merge an array of catalogs into one, combining same-named categories
function mergeCatalogs(catalogs) {
  const base = catalogs[0]
  const categoryMap = new Map()
  for (const cat of (base.categories || [])) {
    categoryMap.set(cat.name.toLowerCase().trim(), { ...cat, items: [...(cat.items || [])] })
  }
  for (const catalog of catalogs.slice(1)) {
    for (const cat of (catalog.categories || [])) {
      const key = cat.name.toLowerCase().trim()
      if (categoryMap.has(key)) {
        categoryMap.get(key).items.push(...(cat.items || []))
      } else {
        categoryMap.set(key, { ...cat, items: [...(cat.items || [])] })
      }
    }
  }
  return {
    ...base,
    categories: [...categoryMap.values()],
    item_count: [...categoryMap.values()].reduce((s, c) => s + c.items.length, 0),
  }
}

async function extractSingleChunk(content, merchantName) {
  const messages = [{
    role: 'user',
    content: merchantName ? `Merchant: ${merchantName}\n\n${content}` : content,
  }]

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 16000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      ...messages,
    ],
  })

  const raw = response.choices[0]?.message?.content || ''
  const catalog = safeParseJson(raw)
  if (!catalog) {
    console.warn('Unparseable chunk response:', raw.slice(0, 200))
    return null
  }
  return catalog
}

export async function extractCatalog(input, merchantName) {
  // Images go directly — no chunking possible
  if (input.type === 'image') {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 16000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` } },
          { type: 'text', text: 'Extract the complete product catalog from this image.' }
        ]},
      ],
    })
    const raw = response.choices[0]?.message?.content || ''
    const catalog = safeParseJson(raw)
    if (!catalog) throw new Error('Could not parse AI response for image.')
    return catalog
  }

  // Text: chunk if large, extract all chunks in parallel, then merge
  const chunks = chunkText(input.content)
  const rawResults = await Promise.all(chunks.map(chunk => extractSingleChunk(chunk, merchantName)))
  const results = rawResults.filter(Boolean)

  if (results.length === 0) throw new Error('AI could not extract any items from the input.')
  return results.length === 1 ? results[0] : mergeCatalogs(results)
}

async function enrichBatch(batch, catalog) {
  const batchInput = batch.map((item, idx) => ({
    index: idx,
    name: item.name,
    category: item.category,
    description: item.description,
  }))

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
    const results = safeParseJson(raw)

    if (Array.isArray(results)) {
      results.forEach(({ index, description, tags }) => {
        const entry = batch[index]
        if (!entry) return
        const items = catalog.categories[entry.catIdx].items || catalog.categories[entry.catIdx].products
        const item = items[entry.itemIdx]
        if (!item.description && description) {
          item.description = description
          item.description_generated = true
        }
        if (Array.isArray(tags) && tags.length > 0) {
          const existing = item.tags || []
          item.tags = [...new Set([...existing, ...tags])]
        }
      })
    }
  } catch (err) {
    console.warn('Enrich batch failed:', err.message)
  }
}

export async function generateProductImage(name, description, category) {
  const prompt = [
    `Professional product photo of "${name}"`,
    description ? `: ${description.slice(0, 120)}` : '',
    category ? ` (${category})` : '',
    '. Clean background, well-lit, high quality, appetizing presentation, menu photography style.',
  ].join('')

  const response = await client.images.generate({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    quality: 'standard',
    response_format: 'url',
  })

  return response.data[0].url
}

export async function enrichProducts(catalog) {
  const toEnrich = []
  catalog.categories.forEach((cat, catIdx) => {
    const items = cat.items || cat.products || []
    items.forEach((item, itemIdx) => {
      const needsDesc = !item.description
      const needsTags = !item.tags || item.tags.length === 0
      if (needsDesc || needsTags) {
        toEnrich.push({ catIdx, itemIdx, name: item.name, category: cat.name, description: item.description || null })
      }
    })
  })

  if (toEnrich.length === 0) return

  const BATCH_SIZE = 20
  const batches = []
  for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
    batches.push(toEnrich.slice(i, i + BATCH_SIZE))
  }

  // Run all enrichment batches in parallel
  await Promise.all(batches.map(batch => enrichBatch(batch, catalog)))
}
