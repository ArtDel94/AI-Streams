import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import mammoth from 'mammoth'
import axios from 'axios'
import puppeteer from 'puppeteer'

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
}

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
  // PDF URLs — download as buffer and parse directly
  if (url.split('?')[0].toLowerCase().endsWith('.pdf')) {
    try {
      const response = await axios.get(url, { timeout: 15000, responseType: 'arraybuffer' })
      const contentType = response.headers['content-type'] || ''
      if (contentType.includes('application/pdf') || url.split('?')[0].toLowerCase().endsWith('.pdf')) {
        const result = await extractFromPdf(Buffer.from(response.data))
        if (result.error) return { text: null, error: result.error }
        return { text: result.text, pageCount: result.pageCount, sourceUrl: url }
      }
    } catch (err) {
      return { text: null, error: `Could not download PDF: ${err.message}` }
    }
  }

  // All other URLs — use Puppeteer headless browser
  let browser = null
  let page = null
  try {
    browser = await launchBrowser()
    page = await browser.newPage()

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
    await page.setViewport({ width: 1280, height: 900 })

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 2000)) // let deferred rendering finish
    const status = response?.status()

    if (status && status >= 400) {
      return { text: null, error: `${new URL(url).hostname} returned HTTP ${status}. The site may require a login or blocks automated access.` }
    }

    // Check if navigated to a PDF
    const contentType = response?.headers()['content-type'] || ''
    if (contentType.includes('application/pdf')) {
      await page.close()
      const res = await axios.get(url, { timeout: 15000, responseType: 'arraybuffer' })
      const result = await extractFromPdf(Buffer.from(res.data))
      if (result.error) return { text: null, error: result.error }
      return { text: result.text, pageCount: result.pageCount, sourceUrl: url }
    }

    // Scroll and accumulate content across all scroll positions.
    // Virtual scrolling removes top items from DOM as you scroll — so we
    // collect each snapshot and union all lines seen, preserving order of first appearance.
    const seenLines = new Map() // line → first-seen scroll position (for ordering)
    let scrollPos = 0

    const STEP = 600
    const PAUSE = 800
    const MAX_STEPS = 80

    for (let i = 0; i < MAX_STEPS; i++) {
      const snapshot = await page.evaluate(() => document.body.innerText)
      snapshot.split('\n').forEach(raw => {
        const l = raw.trim()
        // Skip very short lines and pure UI noise (ratings, icons, single chars)
        if (l.length < 2 || /^[€$£\d\s,.()\-–]+$/.test(l)) return
        if (!seenLines.has(l)) seenLines.set(l, scrollPos)
      })

      const atBottom = await page.evaluate((step) => {
        window.scrollBy(0, step)
        return (window.scrollY + window.innerHeight) >= document.body.scrollHeight - 100
      }, STEP)

      scrollPos += STEP
      await new Promise(r => setTimeout(r, PAUSE))
      if (atBottom) break
    }

    // Sort lines by first-seen scroll position to preserve reading order
    const orderedLines = [...seenLines.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([line]) => line)

    const text = orderedLines.join('\n')

    if (!text || text.length < 100) {
      return { text: null, error: 'Could not extract enough content from this page. Try taking a screenshot and uploading it as an image instead.' }
    }

    return { text, sourceUrl: url }

  } catch (err) {
    if (err.message?.includes('timeout')) {
      return { text: null, error: `Page took too long to load. Try taking a screenshot and uploading it as an image instead.` }
    }
    return { text: null, error: `Could not load page: ${err.message}` }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}
