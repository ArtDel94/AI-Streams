import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import mammoth from 'mammoth'
import axios from 'axios'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteerExtra.use(StealthPlugin())

async function launchBrowser() {
  return puppeteerExtra.launch({
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
    await new Promise(r => setTimeout(r, 600)) // let deferred rendering finish
    const status = response?.status()

    if (status && status >= 400) {
      const hostname = new URL(url).hostname
      const isDeliveryPlatform = /deliveroo|ubereats|justeat|glovo|doordash|thuisbezorgd|lieferando|wolt/.test(hostname)
      if (status === 403 && isDeliveryPlatform) {
        return { text: null, error: `${hostname} blocks automated access from servers. To import from ${hostname}: open the menu in your browser, select all text (Cmd+A / Ctrl+A), copy it, then paste it into the "Text" tab.` }
      }
      return { text: null, error: `${hostname} returned HTTP ${status}. The site may require a login or block automated access. Try copying the menu text and using the "Text" tab instead.` }
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

    // Scroll and collect viewport snapshots at each step.
    // Virtual scrolling removes top DOM nodes as you scroll, so we concatenate
    // all snapshots and deduplicate at the BLOCK level (sliding window of 3 lines),
    // not line-by-line. This preserves richer occurrences (name+desc+price) even
    // when name also appeared alone in a featured section earlier.
    const STEP = 900   // larger steps = fewer total scrolls
    const PAUSE = 380  // was 800ms — halves scroll time
    const MAX_STEPS = 60

    const allSnapshots = []
    let lastLen = 0
    let stuckCount = 0

    for (let i = 0; i < MAX_STEPS; i++) {
      const snapshot = await page.evaluate(() => document.body.innerText)
      allSnapshots.push(snapshot)

      // Early exit: if content hasn't grown for 3 consecutive steps, we've loaded everything
      if (snapshot.length === lastLen) {
        stuckCount++
        if (stuckCount >= 3) break
      } else {
        stuckCount = 0
        lastLen = snapshot.length
      }

      const atBottom = await page.evaluate((step) => {
        window.scrollBy(0, step)
        return (window.scrollY + window.innerHeight) >= document.body.scrollHeight - 100
      }, STEP)

      await new Promise(r => setTimeout(r, PAUSE))
      if (atBottom) break
    }
    allSnapshots.push(await page.evaluate(() => document.body.innerText))

    // Extract JSON-LD structured data (schema.org) — delivery platforms embed
    // product/menu item data here including image URLs
    const jsonLd = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map(s => { try { return JSON.parse(s.textContent) } catch { return null } })
        .filter(Boolean)
    })

    // Deduplicate by 3-line blocks: keep a block only if we haven't seen this
    // exact triplet before. This prevents repeated nav/header while preserving
    // items that appear with different descriptions in different sections.
    const seenBlocks = new Set()
    const outputLines = []

    for (const snapshot of allSnapshots) {
      const lines = snapshot.split('\n').map(l => l.trim()).filter(l => l.length > 1)
      for (let i = 0; i < lines.length; i++) {
        const blockKey = [lines[i], lines[i + 1] || '', lines[i + 2] || ''].join('|')
        if (!seenBlocks.has(blockKey)) {
          seenBlocks.add(blockKey)
          outputLines.push(lines[i])
        }
      }
    }

    const text = outputLines.join('\n')

    if (!text || text.length < 100) {
      return { text: null, error: 'Could not extract enough content from this page. Try taking a screenshot and uploading it as an image instead.' }
    }

    return { text, jsonLd: jsonLd.length ? jsonLd : null, sourceUrl: url }

  } catch (err) {
    if (err.message?.includes('timeout')) {
      return { text: null, error: `Page took too long to load. Try taking a screenshot and uploading it as an image instead.` }
    }
    return { text: null, error: `Could not load page: ${err.message}` }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}
