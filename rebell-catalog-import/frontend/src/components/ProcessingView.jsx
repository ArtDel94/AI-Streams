import { useEffect, useRef, useState } from 'react'

function formatTime(ts) {
  const d = new Date(ts)
  return d.toTimeString().slice(0, 8)
}

const TYPE_COLOR = {
  info:    'text-slate-400',
  success: 'text-green-400',
  warn:    'text-yellow-400',
  error:   'text-red-400',
}

export default function ProcessingView({ jobId, onComplete, onNewImport }) {
  const [job, setJob] = useState(null)
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
    intervalRef.current = setInterval(poll, 1000)
    return () => clearInterval(intervalRef.current)
  }, [jobId])

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [job?.log])

  function handleViewCatalog() {
    if (job?.catalog) onComplete(job.catalog)
  }

  const isRunning = !job || job.status === 'queued' || job.status === 'processing'
  const isDone = job?.status === 'completed'
  const isFailed = job?.status === 'failed'

  // Compute stats
  let stats = null
  if (isDone && job.catalog) {
    const totalProducts = job.catalog.categories?.reduce((s, c) => s + c.products.length, 0) || 0
    const totalCategories = job.catalog.categories?.length || 0
    const generated = job.catalog.categories?.flatMap(c => c.products).filter(p => p.description_generated).length || 0
    const needsReview = job.catalog.categories?.flatMap(c => c.products).filter(p => p.confidence !== 'high').length || 0
    stats = { totalProducts, totalCategories, generated, needsReview }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">

        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          {isRunning && (
            <span className="text-green-400 animate-pulse text-lg">●</span>
          )}
          {isDone && <span className="text-green-400 text-lg">✓</span>}
          {isFailed && <span className="text-red-400 text-lg">✗</span>}
          <h2 className="text-white font-semibold text-lg">
            {isRunning ? 'Processing...' : isDone ? 'Catalog Ready' : 'Processing Failed'}
          </h2>
        </div>

        {/* Terminal log */}
        <div className="bg-[#0d0f14] rounded-2xl overflow-hidden shadow-2xl">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
            <div className="w-3 h-3 rounded-full bg-red-500/60" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
            <div className="w-3 h-3 rounded-full bg-green-500/60" />
            <span className="text-slate-500 text-xs font-mono ml-2">catalog-import — extraction log</span>
          </div>

          <div className="p-4 h-72 overflow-y-auto no-scrollbar">
            {(job?.log || []).map((entry, i) => (
              <div key={i} className="flex gap-3 font-mono text-sm mb-1">
                <span className="text-slate-600 shrink-0">[{formatTime(entry.ts)}]</span>
                <span className={TYPE_COLOR[entry.type] || 'text-slate-400'}>{entry.msg}</span>
              </div>
            ))}
            {isRunning && (
              <div className="flex gap-3 font-mono text-sm">
                <span className="text-slate-600 animate-pulse">█</span>
              </div>
            )}
            <div ref={logEndRef} />
          </div>
        </div>

        {/* Stats + action */}
        {isDone && stats && (
          <div className="mt-4 bg-white/5 rounded-xl p-4">
            <div className="flex flex-wrap gap-4 text-sm text-slate-300 mb-4">
              <span><span className="text-white font-bold">{stats.totalProducts}</span> products</span>
              <span>·</span>
              <span><span className="text-white font-bold">{stats.totalCategories}</span> categories</span>
              <span>·</span>
              <span><span className="text-white font-bold">{stats.generated}</span> descriptions generated</span>
              {stats.needsReview > 0 && <>
                <span>·</span>
                <span><span className="text-yellow-400 font-bold">{stats.needsReview}</span> need review</span>
              </>}
            </div>
            <button
              onClick={handleViewCatalog}
              className="w-full py-3 bg-rebell-blue hover:bg-rebell-dark text-white font-bold rounded-xl transition-colors"
            >
              View Catalog →
            </button>
          </div>
        )}

        {isFailed && (
          <div className="mt-4 bg-red-500/10 border border-red-500/20 rounded-xl p-4">
            <p className="text-red-400 text-sm mb-3">
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
      </div>
    </div>
  )
}
