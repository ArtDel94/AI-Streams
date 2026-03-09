#!/usr/bin/env node
/**
 * Evaluation script for catalog extraction quality.
 *
 * Usage:
 *   npm run eval-catalog
 *   node scripts/eval-catalog.js [--case case-001]
 *
 * Test cases live in: tests/catalogExtraction/<case-name>/
 *   input.html    — raw HTML input
 *   expected.json — expected extraction (partial schema for comparison)
 *
 * Metrics per case:
 *   - Item precision (extracted ∩ expected / extracted)
 *   - Item recall    (extracted ∩ expected / expected)
 *   - Price accuracy (% of matched items with price within tolerance)
 *   - Schema compliance (% of items passing validateItem)
 *
 * Exit code 1 if any case scores below baseline.
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { extractCatalog } from '../services/aiAgent.js'
import { validateItem }   from '../services/aiGuardrails.js'

// ─── Config ───────────────────────────────────────────────────────────────────

const TESTS_DIR        = resolve(import.meta.dirname, '../../tests/catalogExtraction')
const PRICE_TOLERANCE  = 0.01   // within 1 cent
const BASELINE_RECALL  = 0.80   // 80% recall required to pass
const BASELINE_PRECISION = 0.80

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalise(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ')
}

function itemsFromCatalog(catalog) {
  return catalog.categories.flatMap(c => (c.items || c.products || []).map(i => ({ ...i, _category: c.name })))
}

function matchItems(extracted, expected) {
  const expectedNames = new Set(expected.map(i => normalise(i.name)))
  const extractedNames = new Set(extracted.map(i => normalise(i.name)))
  const matched = [...extractedNames].filter(n => expectedNames.has(n))
  return {
    precision: matched.length / (extractedNames.size || 1),
    recall:    matched.length / (expectedNames.size  || 1),
    matched,
  }
}

function priceAccuracy(extracted, expected) {
  let correct = 0
  let compared = 0
  for (const exp of expected) {
    if (exp.price === null || exp.price === undefined) continue
    const ext = extracted.find(i => normalise(i.name) === normalise(exp.name))
    if (!ext || ext.price === null) continue
    compared++
    if (Math.abs(ext.price - exp.price) <= PRICE_TOLERANCE) correct++
  }
  return compared > 0 ? correct / compared : 1
}

function schemaCompliance(items) {
  const valid = items.filter(i => validateItem(i).valid).length
  return valid / (items.length || 1)
}

// ─── Run evaluation ───────────────────────────────────────────────────────────

async function evalCase(caseName) {
  const caseDir      = join(TESTS_DIR, caseName)
  const inputPath    = join(caseDir, 'input.html')
  const expectedPath = join(caseDir, 'expected.json')

  if (!existsSync(inputPath) || !existsSync(expectedPath)) {
    console.warn(`[skip] ${caseName} — missing input.html or expected.json`)
    return null
  }

  const inputHtml = readFileSync(inputPath, 'utf8')
  const expected  = JSON.parse(readFileSync(expectedPath, 'utf8'))
  const expectedItems = itemsFromCatalog(expected)

  console.log(`\n── Case: ${caseName} ──`)

  let catalog, costUsd
  try {
    const result = await extractCatalog(
      { type: 'text', content: inputHtml },
      expected.merchant_name || null,
      `eval-${caseName}`,
      { cumulativeCostUsd: 0, callCount: 0 }
    )
    catalog = result.catalog
    costUsd = result.costUsd
  } catch (err) {
    console.error(`  FAIL — extraction threw: ${err.message}`)
    return { caseName, pass: false, error: err.message }
  }

  const extractedItems = itemsFromCatalog(catalog)
  const { precision, recall } = matchItems(extractedItems, expectedItems)
  const priceAcc   = priceAccuracy(extractedItems, expectedItems)
  const schemaPct  = schemaCompliance(extractedItems)

  const pass = precision >= BASELINE_PRECISION && recall >= BASELINE_RECALL

  console.log(`  Items expected: ${expectedItems.length}  |  extracted: ${extractedItems.length}`)
  console.log(`  Precision:  ${(precision * 100).toFixed(1)}%  (baseline ${BASELINE_PRECISION * 100}%)`)
  console.log(`  Recall:     ${(recall    * 100).toFixed(1)}%  (baseline ${BASELINE_RECALL    * 100}%)`)
  console.log(`  Price acc:  ${(priceAcc  * 100).toFixed(1)}%`)
  console.log(`  Schema:     ${(schemaPct * 100).toFixed(1)}%`)
  console.log(`  Cost:       $${costUsd.toFixed(5)}`)
  console.log(`  Result:     ${pass ? '✓ PASS' : '✗ FAIL'}`)

  return { caseName, pass, precision, recall, priceAcc, schemaPct, costUsd }
}

async function main() {
  if (!existsSync(TESTS_DIR)) {
    console.error(`Test directory not found: ${TESTS_DIR}`)
    process.exit(1)
  }

  const args        = process.argv.slice(2)
  const caseFilter  = args.includes('--case') ? args[args.indexOf('--case') + 1] : null
  const cases       = caseFilter
    ? [caseFilter]
    : readdirSync(TESTS_DIR).filter(d => existsSync(join(TESTS_DIR, d, 'input.html')))

  if (cases.length === 0) {
    console.log('No test cases found.')
    process.exit(0)
  }

  const results = []
  for (const c of cases) {
    const r = await evalCase(c)
    if (r) results.push(r)
  }

  const passed = results.filter(r => r.pass).length
  console.log(`\n══ Summary: ${passed}/${results.length} cases passed ══`)

  if (passed < results.length) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
