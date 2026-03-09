// Structured observability for AI calls.
// Logs are emitted as single-line JSON — parseable by Railway and any log aggregator.

const LOG_LEVEL = process.env.LOG_LEVEL || 'info'

/**
 * Record a single AI call outcome.
 * Called by the gateway after every callOpenAI() attempt.
 */
export function recordCall({
  jobId,
  stage,
  model,
  inputTokens,
  outputTokens,
  costUsd,
  latencyMs,
  success,
  error,
  retryAttempted,
  cached,
  circuitState,
}) {
  const entry = {
    timestamp: new Date().toISOString(),
    jobId,
    stage,
    model,
    inputTokens,
    outputTokens,
    costUsd: +costUsd.toFixed(6),
    latencyMs,
    success,
    ...(error && { error }),
    ...(retryAttempted && { retryAttempted }),
    ...(cached && { cached }),
    circuitState,
  }
  console.log(JSON.stringify(entry))
}

/**
 * Record the full job summary after pipeline completion.
 */
export function recordJobSummary({
  jobId,
  totalCostUsd,
  costExtraction,
  costEnrichment,
  totalLatencyMs,
  itemsExtracted,
  nullPriceRate,
  modelUsed,
  promptVersionExtraction,
  promptVersionEnrichment,
  warnings,
  outcome,
  requiresReview,
}) {
  const summary = {
    timestamp: new Date().toISOString(),
    event: 'job_summary',
    jobId,
    totalCostUsd: +totalCostUsd.toFixed(6),
    costExtraction: +costExtraction.toFixed(6),
    costEnrichment: +costEnrichment.toFixed(6),
    totalLatencyMs,
    itemsExtracted,
    nullPriceRate: +nullPriceRate.toFixed(3),
    modelUsed,
    promptVersionExtraction,
    promptVersionEnrichment,
    warnings,
    outcome,
    requiresReview,
  }
  console.log(JSON.stringify(summary))
}

/**
 * Check alert thresholds and log warnings.
 * Returns true if the job should be aborted (cost exceeds hard limit).
 */
export const ALERT_THRESHOLDS = {
  jobCostWarn:     0.10,
  jobCostAbort:    0.25,
  failureRateWarn: 0.05,
  latencyWarn:     30000,
}

export function checkAlerts({ jobId, totalCostUsd, latencyMs, failureRate }) {
  if (totalCostUsd >= ALERT_THRESHOLDS.jobCostAbort) {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), alert: 'COST_ABORT', jobId, totalCostUsd }))
    return { abort: true, reason: `Job cost $${totalCostUsd.toFixed(4)} exceeds abort threshold $${ALERT_THRESHOLDS.jobCostAbort}` }
  }
  if (totalCostUsd >= ALERT_THRESHOLDS.jobCostWarn) {
    console.warn(JSON.stringify({ timestamp: new Date().toISOString(), alert: 'COST_WARN', jobId, totalCostUsd }))
  }
  if (latencyMs && latencyMs >= ALERT_THRESHOLDS.latencyWarn) {
    console.warn(JSON.stringify({ timestamp: new Date().toISOString(), alert: 'LATENCY_WARN', jobId, latencyMs }))
  }
  if (failureRate && failureRate >= ALERT_THRESHOLDS.failureRateWarn) {
    console.warn(JSON.stringify({ timestamp: new Date().toISOString(), alert: 'FAILURE_RATE_WARN', jobId, failureRate }))
  }
  return { abort: false }
}
