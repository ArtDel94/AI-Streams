import { useState } from 'react'
import { API_BASE } from '../api.js'

export default function ExportBar({ catalog }) {
  const [exporting, setExporting] = useState(false)

  const totalProducts = catalog.categories?.reduce((s, c) => s + (c.items || c.products || []).length, 0) || 0

  async function handleExport() {
    setExporting(true)
    try {
      const res = await fetch(`${API_BASE}/api/catalog/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(catalog),
      })
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') || ''
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
      const filename = filenameMatch ? filenameMatch[1] : 'catalog.json'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Export failed:', err)
    }
    setExporting(false)
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-gray-200 px-6 py-3 flex items-center justify-between z-50">
      <span className="text-sm text-gray-500">
        <span className="font-bold text-gray-900">{totalProducts}</span> products ready to export
      </span>
      <button
        onClick={handleExport}
        disabled={exporting}
        className="flex items-center gap-2 px-5 py-2.5 bg-rebell-blue hover:bg-rebell-dark text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-60"
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
          <path d="M7.5 1v9M4 7l3.5 3.5L11 7" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M1 12h13" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        {exporting ? 'Exporting...' : 'Export as JSON'}
      </button>
    </div>
  )
}
