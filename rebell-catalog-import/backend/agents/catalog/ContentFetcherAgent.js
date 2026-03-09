/**
 * ContentFetcherAgent — Agent 1
 *
 * Takes a URL or raw content, returns clean text ready for AI processing.
 * No AI calls. Pure utility: fetch → strip → normalize → chunk.
 */

import { load } from 'cheerio'
import { BaseAgent } from '../../BaseAgent.js'
import { extractFromUrl } from '../../../services/extractor.js'

const MAX_INPUT_CHARS  = 60000
const CHUNK_THRESHOLD  = 8000
const MAX_CHUNKS       = 10

const FOOTER_MARKERS = [
  'scopri deliveroo', 'scarica la app', '© deliveroo', '© uber',
  'termini & condizioni', 'informativa sulla privacy',
  'cookie policy', 'cookie notice', 'informativa cookie', 'consenso cookie',
  'preferenze cookie', 'gestione cookie', 'we use cookies',
  'lavora con noi', 'diventa nostro partner', 'il carrello è vuoto',
  'vai al pagamento', 'assistenza clienti', 'note legali',
]

function stripFooterNoise(text) {
  const lines = text.split('\n')
  let cutAt   = lines.length
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase()
    if (FOOTER_MARKERS.some(m => lower.includes(m))) {
      if (lines.slice(0, i).join('\n').length >= 500) cutAt = i
      break
    }
  }
  return lines.slice(0, cutAt).join('\n')
}

function stripHtml(html) {
  try {
    const $ = load(html)
    $('script, style, nav, footer, head, noscript, [role="navigation"], [aria-hidden="true"]').remove()
    return $('body').text()
      .replace(/\t/g, ' ')
      .replace(/ {2,}/g, ' ')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .join('\n')
  } catch {
    return html
  }
}

function chunkText(text) {
  if (text.length <= CHUNK_THRESHOLD) return [text]
  const lines   = text.split('\n')
  const chunks  = []
  let current   = ''
  for (const line of lines) {
    if (current.length + line.length + 1 > CHUNK_THRESHOLD && current.length > 0) {
      chunks.push(current)
      current = ''
    }
    current += (current ? '\n' : '') + line
  }
  if (current) chunks.push(current)
  return chunks
}

export class ContentFetcherAgent extends BaseAgent {
  constructor() {
    super({ agentId: 'content-fetcher', capabilities: ['fetch-content'] })
  }

  async execute(task) {
    const t0 = Date.now()
    const { url, rawContent, format } = task.payload

    let rawText      = ''
    let jsonLdSuffix = ''

    try {
      if (url) {
        const result = await extractFromUrl(url)
        if (result.error) {
          return this._fail('FETCH_ERROR', result.error, { latencyMs: Date.now() - t0 })
        }
        rawText      = result.text || ''
        jsonLdSuffix = result.jsonLd
          ? '\n\n---STRUCTURED_DATA_JSON_LD---\n' + JSON.stringify(result.jsonLd)
          : ''
      } else if (rawContent) {
        rawText = format === 'html' ? stripHtml(rawContent) : rawContent
      } else {
        return this._fail('NO_INPUT', 'Neither url nor rawContent provided', { latencyMs: Date.now() - t0 })
      }

      // Strip footer noise
      rawText = stripFooterNoise(rawText)

      const originalLength = (rawText + jsonLdSuffix).length
      let cleanText = rawText + jsonLdSuffix
      let truncated = false

      // Hard truncation
      if (cleanText.length > MAX_INPUT_CHARS) {
        cleanText = cleanText.slice(0, MAX_INPUT_CHARS)
        truncated = true
        console.warn(`[ContentFetcher] Truncated: ${originalLength} → ${MAX_INPUT_CHARS} chars`)
      }

      // Chunk
      let chunks = chunkText(cleanText)
      if (chunks.length > MAX_CHUNKS) {
        console.warn(`[ContentFetcher] Too many chunks (${chunks.length}) — truncating to ${MAX_CHUNKS}`)
        chunks    = chunks.slice(0, MAX_CHUNKS)
        truncated = true
      }

      return this._ok({
        cleanText,
        originalLength,
        cleanedLength:  cleanText.length,
        detectedFormat: url ? 'html' : (format || 'text'),
        chunks,
        chunkCount:     chunks.length,
        truncated,
      }, { latencyMs: Date.now() - t0 })

    } catch (err) {
      return this._fail('FETCH_EXCEPTION', err.message, { latencyMs: Date.now() - t0 })
    }
  }
}
