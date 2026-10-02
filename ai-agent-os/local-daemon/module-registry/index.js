
const { NOOP_LOGGER } = require('../../memory/logs');

const ACTION_ALIASES = new Map(Object.entries({
  desktop: {
    openApplication: { module: 'process', action: 'openApplication' },
    closeApplication: { module: 'process', action: 'closeApplication' },
    listProcesses: { module: 'process', action: 'listProcesses' },
    getSystemInfo: { module: 'process', action: 'getSystemInfo' },
    executeCommand: { module: 'process', action: 'executeCommand' },
    isRunning: { module: 'process', action: 'isRunning' },
    killProcess: { module: 'process', action: 'killProcess' },
    takeScreenshot: { module: 'screen', action: 'takeScreenshot' }
  },
  process: {
    runCommand: { module: 'process', action: 'executeCommand' },
    moveMouse: { module: 'desktop', action: 'moveMouse' },
    clickMouse: { module: 'desktop', action: 'clickMouse' },
    typeText: { module: 'desktop', action: 'typeText' },
    pressKey: { module: 'desktop', action: 'pressKey' },
    hotkey: { module: 'desktop', action: 'hotkey' },
    screenshot: { module: 'screen', action: 'takeScreenshot' },
    takeScreenshot: { module: 'screen', action: 'takeScreenshot' }
  },
  screen: {
    openApplication: { module: 'process', action: 'openApplication' },
    screenshot: { module: 'screen', action: 'takeScreenshot' }
  }
}).map(([module, aliases]) => [module, new Map(Object.entries(aliases))]));

const MODULE_METHODS = ['initialize', 'shutdown', 'execute', 'supportsAction', 'getActionNames', 'getActionMeta', 'getManifest'];

function assertModuleShape(name, moduleInstance) {
  if (typeof name !== 'string' || !name) throw new TypeError('Module name must be a non-empty string');
  const missing = MODULE_METHODS.filter((m) => typeof moduleInstance?.[m] !== 'function');
  if (missing.length) throw new TypeError(`Module '${name}' is missing: ${missing.join(', ')}`);
}

class ModuleRegistry {
  constructor(logger = NOOP_LOGGER) {
    this.modules = new Map();
    this.logger = logger;
  }

  async registerModule(name, moduleInstance, context = {}) {
    assertModuleShape(name, moduleInstance);
    if (this.modules.has(name)) {
      this.logger.warn(`Module '${name}' already registered. Replacing.`);
      await this.unregisterModule(name);
    }
    await moduleInstance.initialize(context);
    this.modules.set(name, moduleInstance);
    this.logger.info(`Module registered: ${name} (${moduleInstance.getActionNames().length} actions)`);
  }

  async unregisterModule(name) {
    const mod = this.modules.get(name);
    if (!mod) return;
    this.modules.delete(name);
    try {
      await mod.shutdown();
    } catch (err) {
      this.logger.warn(`Error shutting down module '${name}': ${err.message}`);
    }
    this.logger.info(`Module unregistered: ${name}`);
  }

  async shutdownAll() {
    for (const name of this.getModuleNames()) {
      await this.unregisterModule(name);
    }
  }

  getModuleNames() {
    return Array.from(this.modules.keys());
  }

  getSystemManifest() {
    const manifest = {};
    for (const [name, mod] of this.modules) {
      manifest[name] = mod.getManifest();
    }
    return manifest;
  }

  resolve(moduleName, actionName) {
    if (this._supports(moduleName, actionName)) {
      return { module: moduleName, action: actionName };
    }

    const alias = ACTION_ALIASES.get(moduleName)?.get(actionName);
    if (alias && this._supports(alias.module, alias.action)) {
      return { ...alias };
    }

    for (const [name, mod] of this.modules) {
      if (name !== moduleName && mod.supportsAction(actionName)) {
        return { module: name, action: actionName };
      }
    }
    return null;
  }

  getActionMeta(target) {
    return this.modules.get(target.module)?.getActionMeta(target.action) || null;
  }

  async executeAction(moduleName, actionName, parameters = {}) {
    const target = this.resolve(moduleName, actionName);
    if (!target) throw new Error(this.notFoundMessage(moduleName, actionName));

    if (target.module !== moduleName || target.action !== actionName) {
      this.logger.info(`Routing '${moduleName}.${actionName}' -> '${target.module}.${target.action}'`);
    }
    return this.modules.get(target.module).execute(target.action, parameters);
  }

  notFoundMessage(moduleName, actionName) {
    const mod = this.modules.get(moduleName);
    const available = mod ? mod.getActionNames().join(', ') : `Module '${moduleName}' not found`;
    const prefix = String(actionName).toLowerCase().substring(0, 6);
    const similar = [];
    for (const [name, m] of this.modules) {
      for (const a of m.getActionNames()) {
        if (prefix && a.toLowerCase().includes(prefix)) similar.push(`${name}.${a}`);
      }
    }
    return `Action '${actionName}' not found in module '${moduleName}' or any other module. ` +
      `Available in ${moduleName}: [${available}]. ` +
      `Try one of: ${similar.join(', ') || 'see capabilities'}`;
  }

  _supports(moduleName, actionName) {
    return Boolean(this.modules.get(moduleName)?.supportsAction(actionName));
  }
}

module.exports = ModuleRegistry;
module.exports.ACTION_ALIASES = ACTION_ALIASES;
