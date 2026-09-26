const { CapabilityModule } = require('../../shared/schemas/capability-schema');

function formatIn(date, timezone) {
  if (typeof timezone !== 'string') throw new Error('timezone must be an IANA name such as "Europe/Paris"');
  try {
    return date.toLocaleString('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`);
  }
}

class SchedulerModule extends CapabilityModule {
  constructor() {
    super('scheduler', 'Date and time');
  }

  async initialize(context) {
    await super.initialize(context);
    this.registerAction('getTime', this.getTime, {
      description: 'Get current system time',
      parameters: ['timezone'],
      riskLevel: 'low'
    });
  }

  async getTime({ timezone } = {}) {
    const now = new Date();
    return {
      utc: now.toISOString(),
      local: now.toLocaleString(),
      timestamp: now.getTime(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(timezone ? { requested: formatIn(now, timezone) } : {})
    };
  }
}

module.exports = SchedulerModule;
