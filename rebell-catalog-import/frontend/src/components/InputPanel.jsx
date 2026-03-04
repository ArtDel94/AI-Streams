import { useState, useRef } from 'react'
import { API_BASE } from '../api.js'

const MAX_SIZE = 10 * 1024 * 1024 // 10MB

export default function InputPanel({ onJobStarted }) {
  const [activeTab, setActiveTab] = useState('pdf')
  const [pdfFile, setPdfFile] = useState(null)
  const [imageFile, setImageFile] = useState(null)
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [merchantName, setMerchantName] = useState('')
  const [fileError, setFileError] = useState('')
  const [urlError, setUrlError] = useState('')
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const pdfInputRef = useRef(null)
  const imageInputRef = useRef(null)

  function handlePdfFile(file) {
    setFileError('')
    if (!file) return
    if (file.size > MAX_SIZE) { setFileError('File exceeds 10MB limit.'); return }
    if (!file.name.endsWith('.pdf') && file.type !== 'application/pdf') { setFileError('Only PDF files accepted.'); return }
    setPdfFile(file)
  }

  function handleImageFile(file) {
    setFileError('')
    if (!file) return
    if (file.size > MAX_SIZE) { setFileError('File exceeds 10MB limit.'); return }
    const accepted = ['.jpg', '.jpeg', '.png', '.webp', '.docx']
    const ext = '.' + file.name.split('.').pop().toLowerCase()
    if (!accepted.includes(ext)) { setFileError('Accepted formats: JPG, PNG, WEBP, DOCX.'); return }
    setImageFile(file)
  }

  function isReady() {
    if (activeTab === 'pdf') return !!pdfFile
    if (activeTab === 'image') return !!imageFile
    if (activeTab === 'url') return url.trim().startsWith('http://') || url.trim().startsWith('https://')
    if (activeTab === 'text') return text.trim().length > 10
    return false
  }

  async function handleExtract() {
    if (!isReady() || loading) return

    if (activeTab === 'url') {
      if (!url.trim().startsWith('http://') && !url.trim().startsWith('https://')) {
        setUrlError('URL must start with http:// or https://')
        return
      }
      setUrlError('')
    }

    setLoading(true)
    try {
      const formData = new FormData()
      formData.append('inputType', activeTab)
      if (merchantName) formData.append('merchantName', merchantName)

      if (activeTab === 'pdf') formData.append('file', pdfFile)
      else if (activeTab === 'image') formData.append('file', imageFile)
      else if (activeTab === 'url') formData.append('url', url.trim())
      else if (activeTab === 'text') formData.append('text', text.trim())

      const res = await fetch(`${API_BASE}/api/catalog/extract`, { method: 'POST', body: formData })
      const data = await res.json()
      if (data.jobId) onJobStarted(data.jobId)
      else throw new Error(data.error || 'Failed to start job')
    } catch (err) {
      setFileError(err.message)
      setLoading(false)
    }
  }

  const tabs = [
    { key: 'pdf',   label: '📄 PDF' },
    { key: 'image', label: '🖼️ Image / Doc' },
    { key: 'url',   label: '🌐 Website' },
    { key: 'text',  label: '⌨️ Manual' },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">

        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-rebell-blue flex items-center justify-center">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                <rect x="3" y="3" width="16" height="16" rx="3" stroke="white" strokeWidth="1.6"/>
                <path d="M7 8h8M7 11h8M7 14h5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Rebell Catalog Import</h1>
          </div>
          <p className="text-slate-400 text-sm">Upload a menu, scrape a website, or paste text — AI extracts your full product catalog.</p>
        </div>

        {/* Main card */}
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">

          {/* Tabs */}
          <div className="flex border-b border-gray-100">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setFileError(''); setUrlError('') }}
                className={`flex-1 py-3.5 text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'text-rebell-blue border-b-2 border-rebell-blue bg-rebell-light/30'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="p-6">

            {/* PDF tab */}
            {activeTab === 'pdf' && (
              <div>
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                    dragOver ? 'border-rebell-blue bg-rebell-light/20' : 'border-gray-200 hover:border-gray-300'
                  }`}
                  onClick={() => pdfInputRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { e.preventDefault(); setDragOver(false); handlePdfFile(e.dataTransfer.files[0]) }}
                >
                  <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center mx-auto mb-3">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                      <rect x="4" y="2" width="16" height="20" rx="2" stroke="#EF5A56" strokeWidth="1.5"/>
                      <path d="M8 7h8M8 10h8M8 13h5" stroke="#EF5A56" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                  </div>
                  {pdfFile ? (
                    <div>
                      <p className="font-semibold text-gray-800">{pdfFile.name}</p>
                      <p className="text-sm text-gray-400 mt-1">{(pdfFile.size / 1024).toFixed(0)} KB</p>
                    </div>
                  ) : (
                    <div>
                      <p className="font-medium text-gray-600">Drop your PDF here or <span className="text-rebell-blue">browse</span></p>
                      <p className="text-sm text-gray-400 mt-1">PDF files only · Max 10MB</p>
                    </div>
                  )}
                  <input ref={pdfInputRef} type="file" accept=".pdf" className="hidden" onChange={e => handlePdfFile(e.target.files[0])} />
                </div>
              </div>
            )}

            {/* Image / Doc tab */}
            {activeTab === 'image' && (
              <div>
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                    dragOver ? 'border-rebell-blue bg-rebell-light/20' : 'border-gray-200 hover:border-gray-300'
                  }`}
                  onClick={() => imageInputRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { e.preventDefault(); setDragOver(false); handleImageFile(e.dataTransfer.files[0]) }}
                >
                  <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center mx-auto mb-3">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="3" width="18" height="18" rx="3" stroke="#7C3AED" strokeWidth="1.5"/>
                      <circle cx="8.5" cy="8.5" r="2" stroke="#7C3AED" strokeWidth="1.3"/>
                      <path d="M3 16l5-5 4 4 3-3 6 6" stroke="#7C3AED" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  {imageFile ? (
                    <div>
                      <p className="font-semibold text-gray-800">{imageFile.name}</p>
                      <p className="text-sm text-gray-400 mt-1">{(imageFile.size / 1024).toFixed(0)} KB</p>
                    </div>
                  ) : (
                    <div>
                      <p className="font-medium text-gray-600">Drop image or document or <span className="text-rebell-blue">browse</span></p>
                      <p className="text-sm text-gray-400 mt-1">JPG, PNG, WEBP, DOCX · Max 10MB</p>
                    </div>
                  )}
                  <input ref={imageInputRef} type="file" accept=".jpg,.jpeg,.png,.webp,.docx" className="hidden" onChange={e => handleImageFile(e.target.files[0])} />
                </div>
                <p className="text-xs text-gray-400 mt-3 text-center">Images are read directly by AI vision. Word documents (.docx) are parsed for text.</p>
              </div>
            )}

            {/* URL tab */}
            {activeTab === 'url' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Website URL</label>
                <input
                  type="url"
                  value={url}
                  onChange={e => { setUrl(e.target.value); setUrlError('') }}
                  placeholder="https://restaurant.com/menu"
                  className={`w-full px-4 py-3 rounded-xl border text-sm outline-none transition-colors ${
                    urlError ? 'border-red-400 bg-red-50' : 'border-gray-200 focus:border-rebell-blue'
                  }`}
                />
                {urlError && <p className="text-red-500 text-xs mt-1.5">{urlError}</p>}
                <p className="text-xs text-gray-400 mt-2">We'll extract the text content from the page</p>
              </div>
            )}

            {/* Manual text tab */}
            {activeTab === 'text' && (
              <div className="relative">
                <label className="block text-sm font-medium text-gray-700 mb-2">Paste your catalog</label>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  rows={12}
                  placeholder="Paste your menu, price list, or product catalog here..."
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-rebell-blue text-sm outline-none resize-none transition-colors"
                />
                <span className="absolute bottom-3 right-3 text-xs text-gray-300">{text.length}</span>
              </div>
            )}

            {/* File error */}
            {fileError && (
              <div className="mt-3 flex items-center gap-2 text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="7" cy="7" r="6" stroke="#EF5A56" strokeWidth="1.3"/>
                  <path d="M7 4.5V7.5M7 9.5V10" stroke="#EF5A56" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
                {fileError}
              </div>
            )}

            {/* Merchant name */}
            <div className="mt-5">
              <label className="block text-sm font-medium text-gray-500 mb-1.5">Merchant / Restaurant name <span className="text-gray-300">(optional)</span></label>
              <input
                type="text"
                value={merchantName}
                onChange={e => setMerchantName(e.target.value)}
                placeholder="e.g. Trattoria da Marco"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-rebell-blue text-sm outline-none transition-colors"
              />
            </div>

            {/* Extract button */}
            <button
              onClick={handleExtract}
              disabled={!isReady() || loading}
              className={`mt-5 w-full py-3.5 rounded-xl text-sm font-bold transition-all ${
                isReady() && !loading
                  ? 'bg-rebell-blue hover:bg-rebell-dark text-white shadow-lg shadow-rebell-blue/25'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              {loading ? 'Starting...' : 'Extract Catalog'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
