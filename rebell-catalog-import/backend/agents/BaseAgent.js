/**
 * BaseAgent — shared interface for all specialized agents.
 *
 * Every agent:
 *   - Has a stable agentId and a set of capability strings
 *   - Implements execute(task) → standardized result object
 *   - Uses _ok / _fail helpers to emit consistent result shapes
 */

export class BaseAgent {
  constructor({ agentId, capabilities = [] }) {
    this.agentId      = agentId
    this.capabilities = new Set(capabilities)
  }

  canHandle(taskType) {
    return this.capabilities.has(taskType)
  }

  /**
   * Override in subclass.
   * @param {object} task - { taskId, type, payload, context: { jobId, jobContext }, timeout, createdAt }
   * @returns {{ success, result, error, metrics: { costUsd, latencyMs, callCount } }}
   */
  async execute(task) {
    throw new Error(`${this.agentId}: execute() not implemented`)
  }

  /** Standardized success result */
  _ok(result, metrics = {}) {
    return {
      success: true,
      result,
      error:   null,
      metrics: { costUsd: 0, latencyMs: 0, callCount: 0, ...metrics },
    }
  }

  /** Standardized error result */
  _fail(code, message, metrics = {}) {
    return {
      success: false,
      result:  null,
      error:   { code, message },
      metrics: { costUsd: 0, latencyMs: 0, callCount: 0, ...metrics },
    }
  }
}
