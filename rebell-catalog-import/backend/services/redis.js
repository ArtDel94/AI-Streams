import Redis from 'ioredis'

const url = process.env.REDIS_URL || 'redis://localhost:6379'

const redis = new Redis(url)
redis.on('error', err => console.error('Redis error:', err.message))

export default redis

// Each subscriber needs its own connection
export function createSubscriber() {
  return new Redis(url)
}
