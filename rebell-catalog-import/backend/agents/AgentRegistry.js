/**
 * AgentRegistry — maps task types to agent instances.
 *
 * Usage:
 *   const registry = new AgentRegistry()
 *   registry.register(new MyAgent())       // fluent
 *   const agent = registry.resolve('my-task-type')
 */

export class AgentRegistry {
  constructor() {
    this._byCapability = new Map()  // taskType → agent instance
  }

  /** Register an agent for all its declared capabilities. Fluent. */
  register(agent) {
    for (const cap of agent.capabilities) {
      this._byCapability.set(cap, agent)
    }
    return this
  }

  /** Resolve the agent that can handle a given task type. Returns null if none. */
  resolve(taskType) {
    return this._byCapability.get(taskType) ?? null
  }

  /** List all registered agents (for debugging). */
  list() {
    const agents = new Set(this._byCapability.values())
    return [...agents].map(a => ({
      agentId:      a.agentId,
      capabilities: [...a.capabilities],
    }))
  }
}
