// Base class every capability module extends: it registers named action
// handlers and describes them for GET /capabilities.

class CapabilityModule {
  constructor(name, description = '') {
    if (new.target === CapabilityModule) {
      throw new Error('CapabilityModule is abstract and cannot be instantiated directly');
    }
    this.name = name;
    this.description = description;
    this.initialized = false;
    this._actions = new Map();
  }

  async initialize(context) {
    this.context = context;
    this.initialized = true;
  }

  async shutdown() {
    this.initialized = false;
  }

  registerAction(actionName, handler, meta = {}) {
    if (typeof handler !== 'function') {
      throw new TypeError(`Action '${this.name}.${actionName}' needs a handler function`);
    }
    this._actions.set(actionName, {
      handler: handler.bind(this),
      meta: {
        description: meta.description || '',
        parameters: meta.parameters || [],
        riskLevel: meta.riskLevel || 'low',
        requiresConfirmation: meta.requiresConfirmation || false
      }
    });
  }

  async execute(actionName, parameters = {}) {
    if (!this.initialized) {
      throw new Error(`Module '${this.name}' is not initialized`);
    }
    const entry = this._actions.get(actionName);
    if (!entry) {
      throw new Error(`Action '${actionName}' not found in module '${this.name}'. Available: ${this.getActionNames().join(', ')}`);
    }
    return entry.handler(parameters);
  }

  getActionNames() {
    return Array.from(this._actions.keys());
  }

  supportsAction(actionName) {
    return this._actions.has(actionName);
  }

  getActionMeta(actionName) {
    const entry = this._actions.get(actionName);
    return entry ? { ...entry.meta } : null;
  }

  getManifest() {
    const actions = {};
    for (const [name, entry] of this._actions) {
      actions[name] = { ...entry.meta };
    }
    return {
      name: this.name,
      description: this.description,
      initialized: this.initialized,
      actions
    };
  }
}

module.exports = { CapabilityModule };
