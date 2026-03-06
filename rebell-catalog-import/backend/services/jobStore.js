import redis, { createSubscriber } from './redis.js'

const TTL = 86400 // 24 hours

export async function createJob(jobId) {
  const job = { jobId, status: 'queued', stage: 'extracting' }
  await redis.setex(`job:${jobId}`, TTL, JSON.stringify(job))
  return job
}

export async function getJob(jobId) {
  const raw = await redis.get(`job:${jobId}`)
  return raw ? JSON.parse(raw) : null
}

export async function updateJob(jobId, updates) {
  const raw = await redis.get(`job:${jobId}`)
  if (!raw) return null
  const updated = { ...JSON.parse(raw), ...updates }
  await redis.setex(`job:${jobId}`, TTL, JSON.stringify(updated))
  return updated
}

export async function pushLog(jobId, type, msg) {
  const entry = { ts: new Date().toISOString(), type, msg }
  await redis.rpush(`job:${jobId}:log`, JSON.stringify(entry))
  await redis.expire(`job:${jobId}:log`, TTL)
  await redis.publish(`job:${jobId}`, JSON.stringify({ event: 'log', data: entry }))
}

export async function getJobLog(jobId) {
  const raw = await redis.lrange(`job:${jobId}:log`, 0, -1)
  return raw.map(r => JSON.parse(r))
}

export async function publishEvent(jobId, event, data) {
  await redis.publish(`job:${jobId}`, JSON.stringify({ event, data }))
}

export { createSubscriber }
