import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import mammoth from 'mammoth'
import axios from 'axios'
import * as cheerio from 'cheerio'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteerExtra.use(StealthPlugin())

const STATIC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ])
}

async function launchBrowser() {
  return withTimeout(
    puppeteerExtra.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-networking',
        '--no-first-run',
        '--disable-background-timer-throttling',
      ],
    }),
    10000,
    'Browser launch timed out'
  )
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

// Tier 1: fast static fetch with axios + cheerio (~1-3s)
// Works for WordPress, static HTML, most restaurant sites
async function fetchStatic(url) {
  const res = await axios.get(url, {
    timeout: 8000,
    headers: {
      'User-Agent': STATIC_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    maxRedirects: 5,
  })

  const contentType = res.headers['content-type'] || ''

  // If server returned a PDF, handle separately
  if (contentType.includes('application/pdf')) {
    return { isPdf: true, buffer: Buffer.from(res.data) }
  }

  const $ = cheerio.load(res.data)

  // Extract JSON-LD before stripping scripts
  const jsonLd = []
  $('script[type="application/ld+json"]').each((_, el) => {
    try { jsonLd.push(JSON.parse($(el).html())) } catch {}
  })

  // Remove noise elements
  $('script, style, nav, footer, header, [class*="cookie"], [class*="gdpr"], [id*="cookie"], [id*="gdpr"]').remove()

  // Convert HTML to structured text by working on the raw HTML string:
  // replace block-level tags with newlines, then strip remaining tags
  const bodyHtml = $('body').html() || ''
  const text = bodyHtml
    .replace(/<\/?(p|div|h[1-6]|li|br|tr|section|article|main|aside|span)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text, jsonLd: jsonLd.length ? jsonLd : null, statusCode: res.status }
}

// Tier 2: Puppeteer for JS-rendered SPAs (React, Vue, etc.)
async function fetchWithBrowser(url) {
  let browser = null
  try {
    browser = await launchBrowser()
    const page = await browser.newPage()

    await page.setUserAgent(STATIC_UA)
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
    await page.setViewport({ width: 1280, height: 900 })

    await page.setRequestInterception(true)
    page.on('request', req => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort()
      } else {
        req.continue()
      }
    })

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    const status = response?.status()

    // Fixed 2s wait — enough for React/Vue to render, avoids waitForFunction edge cases
    await new Promise(r => setTimeout(r, 2000))

    if (status && status >= 400) {
      const hostname = new URL(url).hostname
      return { text: null, error: `${hostname} blocked access (HTTP ${status}). Try downloading the menu as a PDF and uploading it instead.` }
    }

    // Check if navigated to a PDF
    const contentType = response?.headers()['content-type'] || ''
    if (contentType.includes('application/pdf')) {
      await page.close()
      const res = await axios.get(url, { timeout: 15000, responseType: 'arraybuffer' })
      const result = await extractFromPdf(Buffer.from(res.data))
      if (result.error) return { text: null, error: result.error }
      return { text: result.text, pageCount: result.pageCount }
    }

    // Scroll to capture virtual-scrolling content
    const STEP = 1200
    const PAUSE = 100
    const MAX_STEPS = 10

    const allSnapshots = []
    let lastLen = 0
    let stuckCount = 0

    for (let i = 0; i < MAX_STEPS; i++) {
      const snapshot = await page.evaluate(() => document.body.innerText)
      allSnapshots.push(snapshot)

      if (snapshot.length === lastLen) {
        stuckCount++
        if (stuckCount >= 2) break
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

    const jsonLd = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map(s => { try { return JSON.parse(s.textContent) } catch { return null } })
        .filter(Boolean)
    })

    // Deduplicate by 3-line blocks
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
    return { text, jsonLd: jsonLd.length ? jsonLd : null }

  } finally {
    if (browser) await Promise.race([
      browser.close(),
      new Promise(r => setTimeout(r, 5000)),
    ]).catch(() => {})
  }
}

export async function extractFromUrl(url) {
  return withTimeout(_extractFromUrl(url), 25000, 'timeout')
    .catch(err => {
      if (err.message === 'timeout') {
        return { text: null, error: 'Page took too long to load. Try downloading the menu as a PDF and uploading it instead.' }
      }
      return { text: null, error: `Could not load page: ${err.message}. Try downloading the menu as a PDF and uploading it instead.` }
    })
}

async function _extractFromUrl(url) {
  // PDF URLs — download and parse directly
  if (url.split('?')[0].toLowerCase().endsWith('.pdf')) {
    try {
      const response = await axios.get(url, { timeout: 15000, responseType: 'arraybuffer' })
      const result = await extractFromPdf(Buffer.from(response.data))
      if (result.error) return { text: null, error: result.error }
      return { text: result.text, pageCount: result.pageCount, sourceUrl: url }
    } catch (err) {
      return { text: null, error: `Could not download PDF: ${err.message}` }
    }
  }

  // Tier 1: fast static fetch (handles WordPress, static HTML, most restaurant sites)
  try {
    console.log(`[extractor] Tier 1 static fetch: ${url}`)
    const staticResult = await fetchStatic(url)
    console.log(`[extractor] Tier 1 result: textLen=${staticResult.text?.length}, isPdf=${staticResult.isPdf}`)

    if (staticResult.isPdf) {
      const result = await extractFromPdf(staticResult.buffer)
      if (result.error) return { text: null, error: result.error }
      return { text: result.text, pageCount: result.pageCount, sourceUrl: url }
    }

    // Only use static result if it contains price-like patterns — otherwise
    // it's a JS-rendered shell (nav/boilerplate only) and we need Puppeteer
    const hasPrices = staticResult.text && /\d[\d,.]*\s*[€$£]|[€$£]\s*[\d,.]+/.test(staticResult.text)
    console.log(`[extractor] Tier 1 hasPrices=${hasPrices}`)
    if (hasPrices && staticResult.text.length >= 500) {
      console.log('[extractor] Using Tier 1 result')
      return { text: staticResult.text, jsonLd: staticResult.jsonLd, sourceUrl: url }
    }
  } catch (err) {
    console.log(`[extractor] Tier 1 error: ${err.message} (status=${err.response?.status})`)
    const status = err.response?.status
    if (status && status >= 400) {
      const hostname = new URL(url).hostname
      return { text: null, error: `${hostname} blocked access (HTTP ${status}). Try downloading the menu as a PDF and uploading it instead.` }
    }
    // Network error or timeout — fall through to Puppeteer
  }

  // Tier 2: Puppeteer for JS-rendered SPAs
  console.log('[extractor] Falling to Tier 2 Puppeteer')
  try {
    const result = await fetchWithBrowser(url)
    console.log(`[extractor] Tier 2 result: textLen=${result.text?.length}, error=${result.error}`)

    if (result.error) return { text: null, error: result.error }

    if (!result.text || result.text.length < 100) {
      return { text: null, error: 'Could not extract enough content from this page. Try taking a screenshot and uploading it as an image instead.' }
    }

    return { text: result.text, jsonLd: result.jsonLd, sourceUrl: url }

  } catch (err) {
    if (err.message?.includes('timeout')) {
      return { text: null, error: `Page took too long to load. Try downloading the menu as a PDF and uploading it instead.` }
    }
    return { text: null, error: `Could not load page: ${err.message}. Try downloading the menu as a PDF and uploading it instead.` }
  }
}
