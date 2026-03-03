# Rebell Catalog Import Tool

A full-stack web application that converts merchant menus and product lists into structured, editable catalogs using AI.

## Quick Start

### 1. Backend

```bash
cd backend
npm install
cp ../.env.example .env
# Add your ANTHROPIC_API_KEY to .env
node server.js
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

---

## Requirements

- Node.js 18+
- An Anthropic API key → `ANTHROPIC_API_KEY` in `backend/.env`

---

## Test Inputs

**Pasted text:**
```
STARTERS
Bruschetta al Pomodoro - €6.50
Burrata con Prosciutto - €12.00

PASTA
Spaghetti alla Carbonara - €14.00
Rigatoni all'Amatriciana - €13.50
Penne al Pesto - €12.00

MAINS
Bistecca alla Fiorentina (per 100g) - €8.00
Salmone al Forno - €18.00
```

**Website:** Any restaurant website with a menu page (e.g. a local restaurant's website)

**PDF:** A restaurant menu PDF

**Image:** A photo of a handwritten menu or printed price list

---

## Export Format

```json
{
  "merchant_name": "Trattoria da Marco",
  "currency": "€",
  "importedAt": "2026-03-03T12:00:00.000Z",
  "source": "text",
  "categories": [
    {
      "id": "uuid",
      "name": "PASTA",
      "products": [
        {
          "id": "uuid",
          "name": "Spaghetti alla Carbonara",
          "description": "Classic Roman pasta with eggs, guanciale, pecorino and black pepper.",
          "descriptionGenerated": true,
          "price": 14.00,
          "currency": "€",
          "tags": [],
          "confidence": "high",
          "edited": false
        }
      ]
    }
  ]
}
```
