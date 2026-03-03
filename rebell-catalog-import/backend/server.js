import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import catalogRoutes from './routes/catalog.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json({ limit: '50mb' }))

app.use('/api/catalog', catalogRoutes)

// Global error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`Rebell Catalog Import backend running on port ${PORT}`)
})
