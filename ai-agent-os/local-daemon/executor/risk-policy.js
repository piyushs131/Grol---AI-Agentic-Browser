// Decides how risky a module.action is and whether the user must approve it.
// A module's own riskLevel/requiresConfirmation is honoured, and this table
// can only raise it, so a module under-declaring a risk cannot weaken policy.

const { RISK_LEVELS } = require('../../shared/schemas/action-schema');

const RISK_ORDER = [RISK_LEVELS.LOW, RISK_LEVELS.MEDIUM, RISK_LEVELS.HIGH, RISK_LEVELS.CRITICAL];

const RISK_FLOOR = new Map(Object.entries({
  'process.killProcess': RISK_LEVELS.CRITICAL,
  'process.executeCommand': RISK_LEVELS.CRITICAL,
  'desktop.executeCommand': RISK_LEVELS.CRITICAL,
  'filesystem.deleteFile': RISK_LEVELS.CRITICAL,
  'filesystem.deleteDirectory': RISK_LEVELS.CRITICAL,

  'filesystem.writeFile': RISK_LEVELS.HIGH,
  'filesystem.appendFile': RISK_LEVELS.HIGH,
  'filesystem.moveFile': RISK_LEVELS.HIGH,
  // fs.copyFile silently overwrites an existing destination.
  'filesystem.copyFile': RISK_LEVELS.HIGH,
  'filesystem.createDirectory': RISK_LEVELS.HIGH,
  'browser.evaluate': RISK_LEVELS.HIGH,
  'browser.executeScript': RISK_LEVELS.HIGH,
  // Hands any local file to a web page, bypassing the filesystem module's guards.
  'browser.uploadFile': RISK_LEVELS.HIGH,
  'process.closeApplication': RISK_LEVELS.HIGH,
  'desktop.closeApplication': RISK_LEVELS.HIGH,
  'desktop.pressKey': RISK_LEVELS.HIGH,
  'desktop.hotkey': RISK_LEVELS.HIGH,

  'process.openApplication': RISK_LEVELS.MEDIUM,
  'process.getSystemInfo': RISK_LEVELS.MEDIUM,
  'browser.openURL': RISK_LEVELS.MEDIUM,
  'browser.click': RISK_LEVELS.MEDIUM,
  'browser.type': RISK_LEVELS.MEDIUM,
  'desktop.moveMouse': RISK_LEVELS.MEDIUM,
  'desktop.clickMouse': RISK_LEVELS.MEDIUM,
  'desktop.typeText': RISK_LEVELS.MEDIUM,
  'desktop.openApplication': RISK_LEVELS.MEDIUM,
  'desktop.focusWindow': RISK_LEVELS.MEDIUM,
  'desktop.dragMouse': RISK_LEVELS.MEDIUM
}));

// Driving the UI (keys, quitting an app, which prompts to save) is the whole
// point of OS Control; asking before every keystroke would make it unusable.
// Anything that touches files, runs code or kills processes is never listed.
const AUTONOMOUS_ACTIONS = new Set([
  'desktop.pressKey',
  'desktop.hotkey',
  'process.closeApplication',
  'desktop.closeApplication'
]);

const rank = (risk) => Math.max(RISK_ORDER.indexOf(risk), 0);
const maxRisk = (...risks) => risks.reduce((a, b) => (rank(b) > rank(a) ? b : a), RISK_LEVELS.LOW);
const riskOf = (name, meta) => maxRisk(RISK_FLOOR.get(name) || RISK_LEVELS.LOW, meta?.riskLevel);

function needsApproval(name, risk, meta) {
  if (meta?.requiresConfirmation === true || risk === RISK_LEVELS.CRITICAL) return true;
  return risk === RISK_LEVELS.HIGH && !AUTONOMOUS_ACTIONS.has(name);
}

// Judges both the requested module.action and the one that will actually run
// (with its manifest meta), so an alias or cross-module fallback such as
// process.runCommand or screen.deleteFile cannot slip past the policy.
function assessRisk(requested, resolved, resolvedMeta) {
  const candidates = [{ name: requested, meta: null }];
  if (resolved && resolved !== requested) candidates.push({ name: resolved, meta: resolvedMeta });
  else candidates[0].meta = resolvedMeta;

  const assessed = candidates.map(({ name, meta }) => {
    const risk = riskOf(name, meta);
    return { risk, needsConfirmation: needsApproval(name, risk, meta) };
  });
  return {
    risk: maxRisk(...assessed.map((a) => a.risk)),
    needsConfirmation: assessed.some((a) => a.needsConfirmation)
  };
}

module.exports = { assessRisk, maxRisk, AUTONOMOUS_ACTIONS, RISK_FLOOR };
