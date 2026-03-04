import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import mammoth from 'mammoth'
import axios from 'axios'
import puppeteer from 'puppeteer'

// Shared browser instance — reused across requests
let browser = null
async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
  }
  return browser
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
  let page = null
  try {
    const b = await getBrowser()
    page = await b.newPage()

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
    await page.setViewport({ width: 1280, height: 900 })

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
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

    // Extract visible text from the rendered page
    const text = await page.evaluate(() => {
      const remove = ['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript', 'svg', 'button', 'form', 'aside']
      remove.forEach(tag => document.querySelectorAll(tag).forEach(el => el.remove()))

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const parts = []
      let node
      while ((node = walker.nextNode())) {
        const t = node.textContent.trim()
        if (t.length > 1) parts.push(t)
      }
      return [...new Set(parts)].join('\n')
    })

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
    if (page) await page.close().catch(() => {})
  }
}
