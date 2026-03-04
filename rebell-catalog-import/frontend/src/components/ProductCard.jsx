import { useState } from 'react'

export default function ProductCard({ product, currency, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ ...product })
  const [tagInput, setTagInput] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [hovered, setHovered] = useState(false)

  const needsReview = product.confidence === 'low'

  function handleSave() {
    onUpdate({ ...form, edited: true })
    setEditing(false)
  }

  function handleCancel() {
    setForm({ ...product })
    setEditing(false)
  }

  function addTag() {
    const tag = tagInput.trim()
    if (tag && !form.tags?.includes(tag)) {
      setForm(f => ({ ...f, tags: [...(f.tags || []), tag] }))
    }
    setTagInput('')
  }

  function removeTag(tag) {
    setForm(f => ({ ...f, tags: (f.tags || []).filter(t => t !== tag) }))
  }

  function formatPrice(item, cur) {
    if (item.price == null) return null
    const sym = cur || '€'
    const price = parseFloat(item.price)
    if (isNaN(price)) return null
    if (item.price_max != null) return `${sym}${price.toFixed(2)} – ${sym}${parseFloat(item.price_max).toFixed(2)}`
    return `${sym}${price.toFixed(2)}`
  }

  if (editing) {
    return (
      <div className="bg-white rounded-xl border-2 border-rebell-blue p-4 shadow-lg">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium focus:border-rebell-blue outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</label>
            <textarea
              value={form.description || ''}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3}
              className="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:border-rebell-blue outline-none"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Price</label>
              <input
                type="number" step="0.01" min="0"
                value={form.price ?? ''}
                onChange={e => setForm(f => ({ ...f, price: e.target.value === '' ? null : parseFloat(e.target.value) }))}
                className="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-rebell-blue outline-none"
                placeholder="0.00"
              />
            </div>
            <div className="flex items-end pb-0.5">
              <span className="px-3 py-2 bg-gray-50 rounded-lg text-sm font-medium text-gray-500 border border-gray-200">{currency}</span>
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Tags</label>
            <div className="flex flex-wrap gap-1.5 mt-1 mb-2">
              {(form.tags || []).map(tag => (
                <span key={tag} className="flex items-center gap-1 bg-rebell-light text-rebell-blue text-xs font-medium px-2 py-0.5 rounded-full">
                  {tag}
                  <button onClick={() => removeTag(tag)} className="hover:text-red-500 ml-0.5">×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addTag()}
                placeholder="Add tag..."
                className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:border-rebell-blue outline-none"
              />
              <button onClick={addTag} className="px-3 py-1.5 bg-rebell-light text-rebell-blue text-xs font-semibold rounded-lg hover:bg-rebell-blue hover:text-white transition-colors">
                + Add
              </button>
            </div>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={handleSave} className="flex-1 py-2 bg-rebell-blue text-white text-sm font-semibold rounded-lg hover:bg-rebell-dark transition-colors">Save</button>
          <button onClick={handleCancel} className="flex-1 py-2 bg-gray-100 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors">Cancel</button>
        </div>
      </div>
    )
  }

  const priceLabel = formatPrice(product, currency)

  return (
    <div
      className={`relative bg-white rounded-xl p-4 shadow-sm border transition-shadow hover:shadow-md ${
        needsReview ? 'border-l-4 border-l-amber-400 border-t border-r border-b border-gray-100' : 'border border-gray-100'
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setShowDeleteConfirm(false) }}
    >
      {/* Review badge */}
      {needsReview && (
        <div className="flex items-center gap-1 mb-2">
          <span className="text-amber-500 text-xs">⚠</span>
          <span className="text-amber-600 text-xs font-medium">Needs review</span>
        </div>
      )}

      {/* Bundle badge */}
      {product.is_combo && (
        <div className="inline-flex items-center gap-1 mb-2 bg-purple-50 text-purple-600 text-xs font-semibold px-2 py-0.5 rounded-full">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5h6M5 2v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          Bundle
        </div>
      )}

      {/* Hover actions */}
      {hovered && !showDeleteConfirm && (
        <div className="absolute top-3 right-3 flex gap-1.5">
          <button onClick={() => setEditing(true)} className="px-2.5 py-1 bg-rebell-light text-rebell-blue text-xs font-semibold rounded-lg hover:bg-rebell-blue hover:text-white transition-colors">Edit</button>
          <button onClick={() => setShowDeleteConfirm(true)} className="px-2.5 py-1 bg-red-50 text-red-500 text-xs font-semibold rounded-lg hover:bg-red-500 hover:text-white transition-colors">Delete</button>
        </div>
      )}
      {showDeleteConfirm && (
        <div className="absolute top-3 right-3 flex items-center gap-2 bg-white border border-red-200 rounded-lg px-3 py-1.5 shadow-lg">
          <span className="text-xs text-gray-600">Delete?</span>
          <button onClick={onDelete} className="text-xs font-bold text-red-500 hover:text-red-700">Yes</button>
          <button onClick={() => setShowDeleteConfirm(false)} className="text-xs font-medium text-gray-400 hover:text-gray-600">No</button>
        </div>
      )}

      {/* Name + price */}
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <h3 className="font-bold text-gray-900 text-sm leading-tight pr-16">{product.name}</h3>
        {priceLabel && (
          <span className="font-bold text-rebell-blue text-sm shrink-0">{priceLabel}</span>
        )}
      </div>

      {/* Description */}
      {product.description && (
        <p className="text-gray-400 text-xs italic leading-relaxed mb-2">
          {product.description}
          {product.description_generated && <span className="ml-1 not-italic text-gray-300">(AI)</span>}
        </p>
      )}

      {/* Bundle items */}
      {product.is_combo && product.combo_items?.length > 0 && (
        <div className="mb-2 bg-purple-50 rounded-lg px-3 py-2 space-y-0.5">
          {product.combo_items.map((ci, i) => (
            <div key={i} className="flex justify-between text-xs text-purple-700">
              <span>{ci.quantity ? `${ci.quantity}× ` : ''}{ci.name}</span>
              {ci.price != null && <span>{currency}{parseFloat(ci.price).toFixed(2)}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Tags */}
      {product.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {product.tags.map(tag => (
            <span key={tag} className="bg-gray-50 text-gray-500 text-xs px-2 py-0.5 rounded-full border border-gray-100">{tag}</span>
          ))}
        </div>
      )}

      {/* Allergens */}
      {product.allergens?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {product.allergens.map(a => (
            <span key={a} className="bg-amber-50 text-amber-700 text-xs px-2 py-0.5 rounded-full border border-amber-100">{a}</span>
          ))}
        </div>
      )}

      {product.edited && (
        <div className="absolute bottom-3 right-3">
          <span className="text-xs text-rebell-blue bg-rebell-light px-1.5 py-0.5 rounded">edited</span>
        </div>
      )}
    </div>
  )
}
