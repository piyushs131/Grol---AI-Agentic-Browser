// The side panel shows each action as a short label and a plain sentence
// ("Type “hello” and press Return"), never the raw module.action + JSON.
const KEY_LABEL = { cmd: '⌘', command: '⌘', meta: '⌘', super: '⌘', win: '⌘', shift: '⇧', alt: '⌥',
  option: '⌥', opt: '⌥', ctrl: '⌃', control: '⌃', enter: 'Return', return: 'Return', tab: 'Tab',
  escape: 'Esc', esc: 'Esc', space: 'Space', backspace: 'Delete', delete: 'Delete',
  forwarddelete: 'Del', up: '↑', down: '↓', left: '←', right: '→', pageup: 'Page Up', pagedown: 'Page Down' };
const keyLabel = (k) => {
  const s = String(k).toLowerCase();
  return KEY_LABEL[s] || (s.length === 1 ? s.toUpperCase() : s.replace(/^\w/, (c) => c.toUpperCase()));
};
const clip = (t, n = 60) => { t = String(t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const where = (p) => (p.app ? ` in ${p.app}` : '');
const humanize = (name) => String(name).replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function describe(a) {
  const p = a.parameters || {};
  const file = (x) => String(x || '').replace(/^(desktop|documents|downloads|pictures)\//i, (m) => m[0].toUpperCase() + m.slice(1, -1) + ' › ');
  switch (a.action) {
    case 'openApplication':  return { kind: 'open', text: String(p.name || '') };
    case 'focusWindow':      return { kind: 'switch', text: String(p.title || p.name || '') };
    case 'closeApplication': return { kind: 'close', text: String(p.name || '') };
    case 'clickMouse':
      return { kind: p.doubleClick ? 'dblclick' : p.button === 'right' ? 'rclick' : 'click',
        text: (where(p) || ' on screen').trim() };
    case 'rightClick':  return { kind: 'rclick', text: (where(p) || ' on screen').trim() };
    case 'moveMouse':   return { kind: 'point', text: (where(p) || ' on screen').trim() };
    case 'dragMouse':   return { kind: 'drag', text: (where(p) || ' on screen').trim() };
    case 'scrollMouse': return { kind: 'scroll', text: `${p.direction || 'down'}${where(p)}` };
    case 'typeText': {
      const t = String(p.text || '');
      const enter = /\n$/.test(t);
      return { kind: 'type', text: `“${clip(t.replace(/\n$/, '').replace(/\n/g, ' ↵ '))}”${enter ? ' and press Return' : ''}` };
    }
    case 'pressKey':
      return { kind: 'key', text: [...(Array.isArray(p.modifiers) ? p.modifiers : []), p.key].map(keyLabel).join(' ') };
    case 'hotkey':
      return { kind: 'key', text: (Array.isArray(p.keys) ? p.keys : String(p.keys || '').split('+')).map(keyLabel).join(' ') };
    case 'wait':        return { kind: 'wait', text: `${Math.round((Number(p.ms) || 1000) / 100) / 10} s` };
    case 'executeCommand': return { kind: 'run', text: clip(p.command, 50) };
    case 'createDirectory': return { kind: 'file', text: `New folder ${file(p.path)}` };
    case 'writeFile':       return { kind: 'file', text: `Save ${file(p.path)}` };
    case 'appendFile':      return { kind: 'file', text: `Add to ${file(p.path)}` };
    case 'readFile':        return { kind: 'file', text: `Read ${file(p.path)}` };
    case 'listDirectory':   return { kind: 'file', text: `Look in ${file(p.path)}` };
    case 'copyFile':        return { kind: 'file', text: `Copy ${file(p.source)} → ${file(p.destination)}` };
    case 'moveFile':        return { kind: 'file', text: `Move ${file(p.source)} → ${file(p.destination)}` };
    case 'deleteFile':
    case 'deleteDirectory': return { kind: 'file', text: `Delete ${file(p.path)}` };
    case 'takeScreenshot':
    case 'screenshot':      return { kind: 'look', text: 'Take a screenshot' };
    default:                return { kind: 'step', text: humanize(a.action) };
  }
}

// Errors the loop recovers from read as a retry; the raw text goes in the tooltip.
export function friendlyError(err) {
  const e = String(err || '');
  if (/permission/i.test(e)) return { kind: 'error', text: e };
  if (/Refusing to send input/i.test(e)) return { kind: 'retry', text: 'That app was not in front — bringing it back' };
  if (/is not running|not found|Unable to find application|Could not open/i.test(e)) return { kind: 'retry', text: "Couldn't find that app — trying another way" };
  return { kind: 'retry', text: "That didn't work — trying another way" };
}
