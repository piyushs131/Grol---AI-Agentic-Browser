const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CapabilityModule } = require('../../shared/schemas/capability-schema');
const macInput = require('../desktop/mac-input');

const pad = (n) => String(n).padStart(2, '0');

function parseLocal(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(at || '').trim());
  if (!m) throw new Error('at must be a local date and time like "2026-10-05 09:00"');
  const [, y, mo, d, h, mi] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) {
    throw new Error(`${at} is not a real date and time`);
  }
  return date;
}

const icsStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/[;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');

function alarmIcs({ title, start, minutesBefore, durationMinutes, notes }) {
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const trigger = `-PT${minutesBefore}M`;
  const utc = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Grol//OS Control//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:grol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@grol`,
    `DTSTAMP:${utc}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsText(title)}`,
    ...(notes ? [`DESCRIPTION:${icsText(notes)}`] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, `TRIGGER:${trigger}`, 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:AUDIO', `TRIGGER:${trigger}`, 'ATTACH;VALUE=URI:Basso', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', ''
  ].join('\r\n');
}

function openFile(file, platform) {
  const [cmd, args] = platform === 'darwin' ? ['open', ['-a', 'Calendar', file]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { timeout: 15000 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
  });
}

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
    this.platform = (context && context.platform) || process.platform;
    this.registerAction('getTime', this.getTime, {
      description: 'Get current system time',
      parameters: ['timezone'],
      riskLevel: 'low'
    });
    this.registerAction('createAlarm', this.createAlarm, {
      description: 'Alarm / reminder at a specific local date and time: a calendar event with a sound alert, opened in Calendar',
      parameters: ['at', 'title', 'minutesBefore', 'durationMinutes', 'notes'],
      riskLevel: 'medium'
    });
  }

  async createAlarm({ at, title = 'Alarm', minutesBefore = 0, durationMinutes = 15, notes = '' } = {}) {
    const start = parseLocal(at);
    if (start.getTime() < Date.now() - 60000) throw new Error(`${at} is in the past (now ${new Date().toLocaleString()})`);
    const before = Math.min(10080, Math.max(0, Math.round(Number(minutesBefore) || 0)));
    const duration = Math.min(1440, Math.max(1, Math.round(Number(durationMinutes) || 15)));
    const name = String(title || 'Alarm').slice(0, 200);
    const file = path.join(os.tmpdir(), `Grol-${name.replace(/[^\w-]+/g, '-').slice(0, 40)}-${icsStamp(start)}.ics`);
    fs.writeFileSync(file, alarmIcs({ title: name, start, minutesBefore: before, durationMinutes: duration, notes }));
    const platform = this.platform || process.platform;
    await openFile(file, platform);
    let confirmed = false;
    if (platform === 'darwin') confirmed = await this._confirmCalendarImport();
    return {
      opened: true, confirmedImport: confirmed, title: name, at: start.toLocaleString(), alertMinutesBefore: before, file,
      note: confirmed
        ? 'Pressed OK on Calendar\'s "Adding a new event" dialog. Check the screenshot shows the event on that day.'
        : 'Calendar opened the event. If it asks which calendar to add it to, press OK.'
    };
  }

  async _confirmCalendarImport() {
    try {
      const front = await macInput.__waitForFront('Calendar', 8000);
      if (!front.focused) return false;
      await new Promise((r) => setTimeout(r, 1200));
      await macInput.pressKey('enter', []);
      return true;
    } catch (_) {
      return false;
    }
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
module.exports.__test = { parseLocal, alarmIcs };
