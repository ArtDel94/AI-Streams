import { useState, useEffect } from 'react'
import InputPanel from './components/InputPanel.jsx'
import ProcessingView from './components/ProcessingView.jsx'
import CatalogView from './components/CatalogView.jsx'

export default function App() {
  // view: 'input' | 'processing' | 'catalog'
  const [view, setView] = useState('input')
  const [jobId, setJobId] = useState(null)
  const [catalog, setCatalog] = useState(null)

  // Bookmarklet lands here with ?jobId=xxx — jump straight to processing
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const jid = params.get('jobId')
    if (jid) {
      setJobId(jid)
      setView('processing')
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  function handleJobStarted(id) {
    setJobId(id)
    setView('processing')
  }

  function handleJobComplete(catalogData) {
    setCatalog(catalogData)
    setView('catalog')
  }

  function handleNewImport() {
    setView('input')
    setJobId(null)
    setCatalog(null)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {view === 'input' && (
        <InputPanel onJobStarted={handleJobStarted} />
      )}
      {view === 'processing' && (
        <ProcessingView
          jobId={jobId}
          onComplete={handleJobComplete}
          onNewImport={handleNewImport}
        />
      )}
      {view === 'catalog' && (
        <CatalogView
          catalog={catalog}
          setCatalog={setCatalog}
          onNewImport={handleNewImport}
        />
      )}
    </div>
  )
}
