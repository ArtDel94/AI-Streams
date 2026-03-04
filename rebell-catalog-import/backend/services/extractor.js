import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import mammoth from 'mammoth'
import axios from 'axios'
import * as cheerio from 'cheerio'

export async function extractFromPdf(fileBuffer) {
  try {
    const data = await pdfParse(fileBuffer)
    const text = data.text?.trim() || ''
    if (text.length < 50) {
      return { text: null, error: 'PDF appears to be a scanned image with no readable text. Try uploading a photo instead.' }
    }
    return { text, pageCount: data.numpages }
  } catch (err) {
    return { text: null, error: `Could not parse PDF: ${err.message}` }
  }
}

export async function extractFromImage(fileBuffer, mimeType) {
  return {
    imageBase64: fileBuffer.toString('base64'),
    mimeType: mimeType || 'image/jpeg',
  }
}

export async function extractFromDocx(fileBuffer) {
  const result = await mammoth.extractRawText({ buffer: fileBuffer })
  return { text: result.value }
}

export async function extractFromUrl(url) {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    })

    const contentType = response.headers['content-type'] || ''
    const isPdf = contentType.includes('application/pdf') || url.split('?')[0].toLowerCase().endsWith('.pdf')

    if (isPdf) {
      const result = await extractFromPdf(Buffer.from(response.data))
      if (result.error) return { text: null, error: result.error }
      return { text: result.text, pageCount: result.pageCount, sourceUrl: url }
    }

    const html = Buffer.from(response.data).toString('utf-8')

    const $ = cheerio.load(html)

    // Remove noisy tags
    $('script, style, nav, footer, header, iframe, noscript, svg, button, form').remove()

    // Extract meaningful text
    const parts = []
    $('h1, h2, h3, h4, p, li, td, th, span, div').each((_, el) => {
      const node = $(el)
      // Only direct text, not descendant text from nested elements (for div/span)
      const tag = el.tagName?.toLowerCase()
      let text
      if (['div', 'span'].includes(tag)) {
        // Only grab if this node has direct text (not just wrapped elements)
        text = node.clone().children().remove().end().text().trim()
      } else {
        text = node.text().trim()
      }
      if (text && text.length > 1) parts.push(text)
    })

    // Join, collapse whitespace, deduplicate blanks
    const raw = parts.join('\n')
    const cleaned = raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter((l, i, arr) => arr.indexOf(l) === i) // deduplicate
      .join('\n')

    if (cleaned.length < 100) {
      return { text: null, error: 'Could not extract enough content from this URL. Try pasting the text manually.' }
    }

    return { text: cleaned, sourceUrl: url }
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      return { text: null, error: `Request to ${url} timed out after 10 seconds.` }
    }
    if (err.response) {
      return { text: null, error: `${url} returned HTTP ${err.response.status}.` }
    }
    return { text: null, error: `Could not fetch ${url}: ${err.message}` }
  }
}
