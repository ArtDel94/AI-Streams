import { useState } from 'react'
import ProductCard from './ProductCard.jsx'
import ExportBar from './ExportBar.jsx'

export default function CatalogView({ catalog, setCatalog, onNewImport }) {
  const [showNewImportConfirm, setShowNewImportConfirm] = useState(false)
  const [newProductForm, setNewProductForm] = useState(null)
  const [newProductData, setNewProductData] = useState({ name: '', description: '', price: '', tags: [] })

  const totalProducts = catalog.categories?.reduce((s, c) => s + (c.items || c.products || []).length, 0) || 0
  const needsReview = catalog.categories?.flatMap(c => c.items || c.products || []).filter(p => p.confidence === 'low').length || 0
  const merchantName = catalog.merchant_name || 'Your Catalog'
  const currency = catalog.currency || '€'

  const categories = (catalog.categories || []).map(cat => ({
    ...cat,
    id: cat.id || crypto.randomUUID(),
    items: (cat.items || cat.products || []).map(p => ({
      ...p,
      id: p.id || crypto.randomUUID(),
      edited: p.edited || false,
    }))
  }))

  function updateProduct(catId, productId, updated) {
    setCatalog(prev => ({
      ...prev,
      categories: prev.categories.map(cat =>
        cat.id === catId
          ? { ...cat, items: (cat.items || cat.products || []).map(p => p.id === productId ? { ...updated, id: productId } : p) }
          : cat
      )
    }))
  }

  function deleteProduct(catId, productId) {
    setCatalog(prev => ({
      ...prev,
      categories: prev.categories.map(cat =>
        cat.id === catId
          ? { ...cat, items: (cat.items || cat.products || []).filter(p => p.id !== productId) }
          : cat
      ).filter(cat => (cat.items || cat.products || []).length > 0)
    }))
  }

  function addProduct(catId) {
    if (!newProductData.name.trim()) return
    const newProduct = {
      id: crypto.randomUUID(),
      name: newProductData.name.trim(),
      description: newProductData.description.trim() || null,
      price: newProductData.price !== '' ? parseFloat(newProductData.price) : null,
      price_max: null,
      tags: newProductData.tags,
      allergens: [],
      is_combo: false,
      combo_items: [],
      confidence: 'high',
      edited: false,
    }
    setCatalog(prev => ({
      ...prev,
      categories: prev.categories.map(cat =>
        cat.id === catId ? { ...cat, items: [...(cat.items || cat.products || []), newProduct] } : cat
      )
    }))
    setNewProductForm(null)
    setNewProductData({ name: '', description: '', price: '', tags: [] })
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-20">

      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {showNewImportConfirm ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600">Start a new import? Unsaved changes will be lost.</span>
                <button onClick={onNewImport} className="text-sm font-semibold text-red-500 hover:text-red-700">Yes, proceed</button>
                <button onClick={() => setShowNewImportConfirm(false)} className="text-sm text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => setShowNewImportConfirm(true)}
                className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                New Import
              </button>
            )}
          </div>

          <div className="text-center">
            <h1 className="text-lg font-bold text-gray-900 tracking-tight">{merchantName}</h1>
            <div className="flex items-center justify-center gap-3 text-xs text-gray-400 mt-0.5">
              <span>{totalProducts} items</span>
              <span>·</span>
              <span>{categories.length} categories</span>
              {catalog.catalog_language && <><span>·</span><span className="uppercase">{catalog.catalog_language}</span></>}
              {needsReview > 0 && <><span>·</span><span className="text-amber-500 font-medium">⚠ {needsReview} to review</span></>}
            </div>
          </div>

          <div className="w-32" />
        </div>
      </div>

      {/* Categories */}
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-10">
        {categories.map(cat => (
          <div key={cat.id}>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-xl font-bold text-gray-900">{cat.name}</h2>
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{cat.items.length} items</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {cat.items.map(product => (
                <ProductCard
                  key={product.id}
                  product={product}
                  currency={currency}
                  onUpdate={updated => updateProduct(cat.id, product.id, updated)}
                  onDelete={() => deleteProduct(cat.id, product.id)}
                />
              ))}

              {newProductForm?.catId === cat.id ? (
                <div className="bg-white rounded-xl border-2 border-dashed border-rebell-blue p-4 space-y-3">
                  <p className="text-xs font-semibold text-rebell-blue uppercase tracking-wide">New Item</p>
                  <input
                    value={newProductData.name}
                    onChange={e => setNewProductData(f => ({ ...f, name: e.target.value }))}
                    placeholder="Item name *"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-rebell-blue outline-none"
                    autoFocus
                  />
                  <textarea
                    value={newProductData.description}
                    onChange={e => setNewProductData(f => ({ ...f, description: e.target.value }))}
                    placeholder="Description (optional)"
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:border-rebell-blue outline-none"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={newProductData.price}
                    onChange={e => setNewProductData(f => ({ ...f, price: e.target.value }))}
                    placeholder={`Price (${currency})`}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-rebell-blue outline-none"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => addProduct(cat.id)} className="flex-1 py-2 bg-rebell-blue text-white text-sm font-semibold rounded-lg hover:bg-rebell-dark transition-colors">Add</button>
                    <button onClick={() => setNewProductForm(null)} className="flex-1 py-2 bg-gray-100 text-gray-500 text-sm rounded-lg hover:bg-gray-200 transition-colors">Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setNewProductForm({ catId: cat.id })}
                  className="flex items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-xl p-4 text-sm text-gray-400 hover:border-rebell-blue hover:text-rebell-blue transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  Add item
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <ExportBar catalog={{ ...catalog, categories }} />
    </div>
  )
}
