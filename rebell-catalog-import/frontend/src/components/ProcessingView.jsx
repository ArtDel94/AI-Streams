import { useEffect, useRef, useState } from 'react'
// SSE-based job tracking — no polling
import RebellutionGame from './RebellutionGame.jsx'
import { API_BASE } from '../api.js'

const STAGES = [
  { key: 'extracting', label: 'Extracting content' },
  { key: 'analyzing',  label: 'AI extraction' },
  { key: 'enriching',  label: 'Enriching catalog' },
]
const STAGE_INDEX = { extracting: 0, analyzing: 1, enriching: 2, done: 3 }

const TYPE_COLOR = {
  info: 'text-slate-400', success: 'text-green-400',
  warn: 'text-yellow-400', error: 'text-red-400',
}

function parseItemCount(log) {
  for (const entry of [...(log || [])].reverse()) {
    const m = entry.msg.match(/(\d+)\s+items?\s+across/i)
    if (m) return parseInt(m[1])
  }
  return null
}

export default function ProcessingView({ jobId, onComplete, onNewImport }) {
  const [job, setJob] = useState({ status: 'queued', stage: 'extracting', log: [] })
  const [showLog, setShowLog] = useState(false)
  const logEndRef = useRef(null)

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/catalog/job/${jobId}/stream`)

    es.addEventListener('log', e => {
      const entry = JSON.parse(e.data)
      setJob(prev => ({ ...prev, log: [...prev.log, entry] }))
    })

    es.addEventListener('stage', e => {
      setJob(prev => ({ ...prev, stage: e.data }))
    })

    es.addEventListener('done', () => {
      es.close()
      // Fetch catalog via reliable GET rather than parsing large SSE payload
      fetch(`${API_BASE}/api/catalog/job/${jobId}`)
        .then(r => r.json())
        .then(data => setJob(prev => ({ ...prev, status: 'completed', stage: 'done', catalog: data.catalog })))
    })

    es.addEventListener('failed', () => {
      setJob(prev => ({ ...prev, status: 'failed' }))
      es.close()
    })

    return () => es.close()
  }, [jobId])

  useEffect(() => {
    if (showLog) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [job?.log, showLog])

  const isRunning = !job || job.status === 'queued' || job.status === 'processing'
  const isDone    = job?.status === 'completed'
  const isFailed  = job?.status === 'failed'

  const stageIdx  = STAGE_INDEX[job?.stage ?? 'extracting'] ?? 0
  const itemCount = parseItemCount(job?.log)

  let stats = null
  if (isDone && job.catalog) {
    const allItems = job.catalog.categories?.flatMap(c => c.items || c.products || []) || []
    stats = {
      totalProducts:   allItems.length,
      totalCategories: job.catalog.categories?.length || 0,
      generated:       allItems.filter(p => p.description_generated).length,
      needsReview:     allItems.filter(p => p.confidence === 'low').length,
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">

        {/* ── GAME (while processing) ── */}
        {isRunning && (
          <div className="bg-[#0a0c11] rounded-2xl overflow-hidden shadow-2xl mb-4 border border-white/5">

            {/* Header bar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
              <div className="flex items-baseline gap-3">
                <span
                  className="font-black tracking-[0.18em] text-xl"
                  style={{ color: '#2F85A4', fontFamily: 'monospace', textShadow: '0 0 20px rgba(47,133,164,0.5)' }}
                >
                  REBELLUTION
                </span>
                {itemCount != null && (
                  <span className="text-slate-500 text-xs font-mono">
                    {itemCount} items found
                  </span>
                )}
              </div>
              <span className="text-slate-600 text-xs hidden sm:block">Space · tap to jump</span>
            </div>

            {/* Canvas game */}
            <RebellutionGame />

            {/* Stage progress inside game card */}
            <div className="px-5 py-3 border-t border-white/5">
              <div className="relative flex items-center">
                {/* Track */}
                <div className="absolute inset-x-[8%] top-3 h-px bg-white/8" />
                <div
                  className="absolute left-[8%] top-3 h-px bg-green-400 transition-all duration-700"
                  style={{ width: stageIdx === 0 ? '0%' : stageIdx === 1 ? '42%' : '84%' }}
                />
                {STAGES.map((stage, i) => {
                  const done    = stageIdx > i
                  const current = stageIdx === i
                  return (
                    <div key={stage.key} className="flex-1 flex flex-col items-center gap-1.5 relative">
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-500 ${
                        done    ? 'bg-green-400 text-white' :
                        current ? 'bg-white text-slate-900 ring-2 ring-white/25' :
                                  'bg-white/8 text-slate-600'
                      }`}>
                        {done ? '✓' : i + 1}
                      </div>
                      <span className={`text-xs transition-colors duration-300 ${
                        done ? 'text-green-400' : current ? 'text-white font-medium' : 'text-slate-600'
                      }`}>
                        {stage.label}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── DONE stats ── */}
        {isDone && stats && (
          <div className="bg-white/5 rounded-2xl p-5 mb-4">
            <div className="text-center mb-5">
              <div className="text-green-400 text-3xl mb-1.5">✓</div>
              <h2 className="text-white text-xl font-bold">Catalog Ready</h2>
              {job.catalog.merchant_name && (
                <p className="text-slate-400 text-sm mt-0.5">{job.catalog.merchant_name}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="bg-white/5 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-white">{stats.totalProducts}</div>
                <div className="text-xs text-slate-400 mt-0.5">products</div>
              </div>
              <div className="bg-white/5 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-white">{stats.totalCategories}</div>
                <div className="text-xs text-slate-400 mt-0.5">categories</div>
              </div>
              <div className="bg-white/5 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-white">{stats.generated}</div>
                <div className="text-xs text-slate-400 mt-0.5">descriptions generated</div>
              </div>
              <div className="bg-white/5 rounded-xl p-3 text-center">
                <div className={`text-2xl font-bold ${stats.needsReview > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                  {stats.needsReview}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">need review</div>
              </div>
            </div>
            <button
              onClick={() => onComplete(job.catalog)}
              className="w-full py-3.5 bg-rebell-blue hover:bg-rebell-dark text-white font-bold rounded-xl transition-colors"
            >
              View Catalog →
            </button>
          </div>
        )}

        {/* ── FAILED ── */}
        {isFailed && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-5 mb-4">
            <p className="text-red-400 text-sm mb-4">
              {job?.log?.findLast(l => l.type === 'error')?.msg || 'An unknown error occurred.'}
            </p>
            <button
              onClick={onNewImport}
              className="w-full py-3 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded-xl transition-colors text-sm"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Log toggle */}
        {job?.log?.length > 0 && (
          <button
            onClick={() => setShowLog(v => !v)}
            className="w-full text-center text-xs text-slate-700 hover:text-slate-400 transition-colors py-1"
          >
            {showLog ? '▲ Hide log' : '▼ Show log'}
          </button>
        )}

        {showLog && (
          <div className="mt-2 bg-[#0a0c11] rounded-xl overflow-hidden border border-white/5">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              <span className="text-slate-500 text-xs font-mono ml-1">extraction log</span>
            </div>
            <div className="p-3 h-44 overflow-y-auto no-scrollbar">
              {(job?.log || []).map((entry, i) => (
                <div key={i} className="flex gap-2 font-mono text-xs mb-0.5">
                  <span className="text-slate-600 shrink-0">[{new Date(entry.ts).toTimeString().slice(0, 8)}]</span>
                  <span className={TYPE_COLOR[entry.type] || 'text-slate-400'}>{entry.msg}</span>
                </div>
              ))}
              {isRunning && <span className="text-slate-600 animate-pulse font-mono text-xs">█</span>}
              <div ref={logEndRef} />
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
