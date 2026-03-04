import { useEffect, useRef, useState } from 'react'

const STAGES = [
  { key: 'extracting', label: 'Extracting content',       icon: '⬇' },
  { key: 'analyzing',  label: 'AI analysis',              icon: '🤖' },
  { key: 'enriching',  label: 'Descriptions & tags',      icon: '✦' },
]

const STAGE_INDEX = { extracting: 0, analyzing: 1, enriching: 2, done: 3 }

const TYPE_COLOR = {
  info:    'text-slate-400',
  success: 'text-green-400',
  warn:    'text-yellow-400',
  error:   'text-red-400',
}

function formatTime(ts) {
  return new Date(ts).toTimeString().slice(0, 8)
}

// Parse item count from log messages like "Catalog extracted — 47 items"
function parseItemCount(log) {
  for (const entry of [...(log || [])].reverse()) {
    const m = entry.msg.match(/(\d+)\s+items?\s+across/i)
    if (m) return parseInt(m[1])
  }
  return null
}

export default function ProcessingView({ jobId, onComplete, onNewImport }) {
  const [job, setJob] = useState(null)
  const [showLog, setShowLog] = useState(false)
  const logEndRef = useRef(null)
  const intervalRef = useRef(null)

  useEffect(() => {
    function poll() {
      fetch(`/api/catalog/job/${jobId}`)
        .then(r => r.json())
        .then(data => {
          setJob(data)
          if (data.status === 'completed' || data.status === 'failed') {
            clearInterval(intervalRef.current)
          }
        })
        .catch(console.error)
    }
    poll()
    intervalRef.current = setInterval(poll, 800)
    return () => clearInterval(intervalRef.current)
  }, [jobId])

  useEffect(() => {
    if (showLog) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [job?.log, showLog])

  const isRunning = !job || job.status === 'queued' || job.status === 'processing'
  const isDone    = job?.status === 'completed'
  const isFailed  = job?.status === 'failed'

  const currentStageIdx = STAGE_INDEX[job?.stage ?? 'extracting'] ?? 0
  const itemCount = parseItemCount(job?.log)

  // Stats for done state
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
      <div className="w-full max-w-lg">

        {/* Header */}
        <div className="text-center mb-10">
          {isRunning && (
            <div className="inline-flex items-center gap-2 text-green-400 text-sm font-mono mb-3">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
              Processing
            </div>
          )}
          {isDone && <div className="inline-flex items-center gap-2 text-green-400 text-sm font-mono mb-3"><span className="text-green-400">✓</span> Complete</div>}
          {isFailed && <div className="inline-flex items-center gap-2 text-red-400 text-sm font-mono mb-3"><span>✗</span> Failed</div>}
          <h2 className="text-white text-2xl font-bold tracking-tight">
            {isRunning ? 'Building your catalog...' : isDone ? 'Catalog ready' : 'Something went wrong'}
          </h2>
          {isRunning && itemCount && (
            <p className="text-slate-400 text-sm mt-2">
              <span className="text-white font-bold tabular-nums">{itemCount}</span> items found so far
            </p>
          )}
        </div>

        {/* Stage progress */}
        {!isFailed && (
          <div className="relative mb-10">
            {/* Connecting line */}
            <div className="absolute top-5 left-[calc(16.66%)] right-[calc(16.66%)] h-px bg-white/10" />
            <div
              className="absolute top-5 left-[calc(16.66%)] h-px bg-green-400 transition-all duration-700"
              style={{ width: currentStageIdx === 0 ? '0%' : currentStageIdx === 1 ? '50%' : '100%' }}
            />

            <div className="relative flex justify-between">
              {STAGES.map((stage, i) => {
                const done    = currentStageIdx > i
                const current = currentStageIdx === i && isRunning
                const pending = currentStageIdx < i

                return (
                  <div key={stage.key} className="flex flex-col items-center gap-2 w-1/3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm transition-all duration-500 ${
                      done    ? 'bg-green-400 text-white' :
                      current ? 'bg-white text-slate-900 ring-4 ring-white/20' :
                                'bg-white/10 text-slate-500'
                    }`}>
                      {done ? '✓' : current ? <span className="animate-pulse">{stage.icon}</span> : stage.icon}
                    </div>
                    <span className={`text-xs text-center leading-tight transition-colors duration-300 ${
                      done    ? 'text-green-400' :
                      current ? 'text-white font-semibold' :
                                'text-slate-600'
                    }`}>
                      {stage.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Done stats */}
        {isDone && stats && (
          <div className="bg-white/5 rounded-2xl p-5 mb-4">
            <div className="grid grid-cols-2 gap-4 mb-5">
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
                <div className={`text-2xl font-bold ${stats.needsReview > 0 ? 'text-yellow-400' : 'text-green-400'}`}>{stats.needsReview}</div>
                <div className="text-xs text-slate-400 mt-0.5">need review</div>
              </div>
            </div>
            <button
              onClick={() => onComplete(job.catalog)}
              className="w-full py-3.5 bg-rebell-blue hover:bg-rebell-dark text-white font-bold rounded-xl transition-colors text-sm"
            >
              View Catalog →
            </button>
          </div>
        )}

        {/* Failed state */}
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
        {(job?.log?.length > 0) && (
          <button
            onClick={() => setShowLog(v => !v)}
            className="w-full text-center text-xs text-slate-600 hover:text-slate-400 transition-colors py-1"
          >
            {showLog ? '▲ Hide log' : '▼ Show log'}
          </button>
        )}

        {/* Terminal log (collapsible) */}
        {showLog && (
          <div className="mt-2 bg-[#0d0f14] rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              <span className="text-slate-500 text-xs font-mono ml-1">extraction log</span>
            </div>
            <div className="p-3 h-48 overflow-y-auto no-scrollbar">
              {(job?.log || []).map((entry, i) => (
                <div key={i} className="flex gap-2 font-mono text-xs mb-0.5">
                  <span className="text-slate-600 shrink-0">[{formatTime(entry.ts)}]</span>
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
