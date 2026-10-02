
const APPS = ['google chrome', 'chrome', 'safari', 'firefox', 'finder', 'terminal', 'calculator', 'notes',
  'textedit', 'preview', 'mail', 'calendar', 'messages', 'music', 'photos', 'maps', 'reminders',
  'system settings', 'app store', 'notepad', 'word', 'microsoft word', 'excel', 'microsoft excel',
  'powerpoint', 'vscode', 'visual studio code', 'vs code', 'spotify', 'discord', 'slack', 'teams',
  'microsoft teams', 'zoom', 'telegram', 'whatsapp'];
const APP = `(${APPS.map((a) => a.replace(/ /g, '\\s+')).join('|')})`;
const FOLDER = '(desktop|documents|downloads|pictures)';
const TLD = 'com|org|net|io|dev|co|in|ai|app|edu|gov|me|uk';

const MULTI_STEP = /\b(and|then|after|afterwards|before|also|while|until|if|when)\b|[,;&|]|\n/i;
const POLITE = /^(?:please\s+|can\s+you\s+|could\s+you\s+|hey\s+grol,?\s+)+/i;

const cmd = (body) => new RegExp(`^${body}$`, 'i');

function webUrl(raw) {
  const text = raw.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null;
  } catch (_) {
    return null;
  }
}

const INTENTS = [
  {
    pattern: cmd(`(?:open|launch|start|run)\\s+(?:the\\s+)?${APP}(?:\\s+app)?`),
    build: (m) => ({ module: 'process', action: 'openApplication', parameters: { name: m[1].replace(/\s+/g, ' ') } })
  },
  {
    pattern: cmd(`(?:close|quit|exit)\\s+(?:the\\s+)?${APP}(?:\\s+app)?`),
    build: (m) => ({ module: 'process', action: 'closeApplication', parameters: { name: m[1].replace(/\s+/g, ' ') } })
  },
  {
    pattern: cmd(`(?:open|go\\s+to|visit|navigate\\s+to|browse(?:\\s+to)?)\\s+(?:the\\s+)?(?:website\\s+)?((?:https?://)?[\\w-]+(?:\\.[\\w-]+)*\\.(?:${TLD})(?:[/?#]\\S*)?)`),
    build: (m) => {
      const url = webUrl(m[1]);
      return url && { module: 'browser', action: 'openURL', parameters: { url } };
    }
  },
  {
    pattern: cmd('(?:take|capture|grab)\\s+(?:a\\s+)?(?:screen\\s?shot|screen\\s+capture)|capture\\s+(?:the\\s+)?screen|screenshot'),
    build: () => ({ module: 'screen', action: 'takeScreenshot', parameters: {} })
  },
  {
    pattern: cmd(`(?:list|show)\\s+(?:me\\s+)?(?:the\\s+)?files\\s+(?:in|on)\\s+(?:my\\s+|the\\s+)?${FOLDER}(?:\\s+folder)?`),
    build: (m) => ({ module: 'filesystem', action: 'listDirectory', parameters: { path: m[1].toLowerCase() } })
  },
  {
    pattern: cmd(`(?:create|make)\\s+(?:a\\s+)?(?:new\\s+)?folder\\s+(?:called|named)\\s+["']?([\\w][\\w .-]{0,59}?)["']?\\s+(?:on|in)\\s+(?:my\\s+|the\\s+)?${FOLDER}(?:\\s+folder)?`),
    build: (m) => (m[1].includes('..') ? null
      : { module: 'filesystem', action: 'createDirectory', parameters: { path: `${m[2].toLowerCase()}/${m[1].trim()}` } })
  },
  {
    pattern: cmd('(?:show|list)\\s+(?:the\\s+)?(?:running\\s+)?processes|what(?:\'s|\\s+is)\\s+running'),
    build: () => ({ module: 'process', action: 'listProcesses', parameters: {} })
  },
  {
    pattern: cmd('(?:show\\s+)?system\\s+(?:info|information|status)'),
    build: () => ({ module: 'process', action: 'getSystemInfo', parameters: {} })
  },
  {
    pattern: cmd('what\\s+time\\s+is\\s+it|(?:what\\s+is\\s+the\\s+)?current\\s+time'),
    build: () => ({ module: 'scheduler', action: 'getTime', parameters: {} })
  },
  {
    pattern: cmd('click\\s+(?:at\\s+)?(?:position\\s+)?(\\d{1,5})\\s*[,x]\\s*(\\d{1,5})'),
    build: (m) => ({ module: 'desktop', action: 'clickMouse', parameters: { x: parseInt(m[1], 10), y: parseInt(m[2], 10) } })
  }
];

export function isSingleStep(text) {
  return !MULTI_STEP.test(text);
}

export function matchIntent(text) {
  const input = String(text ?? '').trim().replace(POLITE, '').replace(/[.!]+$/, '').trim();
  if (!input || input.length > 200) return null;
  if (!/^click\b/i.test(input) && !isSingleStep(input)) return null;
  for (const { pattern, build } of INTENTS) {
    const m = input.match(pattern);
    if (!m) continue;
    const action = build(m);
    return action ? [action] : null;
  }
  return null;
}
