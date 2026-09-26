// chrome.runtime.onMessage listener for the service worker. Only the
// extension's own pages may drive the agents: a content script or another
// extension could otherwise start tasks, read state or save a key.

export function isTrustedSender(sender, { id, origin }) {
  return !!sender && sender.id === id && typeof sender.url === 'string' && sender.url.startsWith(origin);
}

// handlers: { [type]: (msg, sender) => response | Promise<response> }
export function createMessageListener(handlers, { id, origin, logger } = {}) {
  return (msg, sender, respond) => {
    if (!isTrustedSender(sender, { id, origin })) {
      respond({ ok: false, error: 'Not allowed' });
      return false;
    }
    const type = msg && typeof msg === 'object' && typeof msg.type === 'string' ? msg.type : '';
    const handler = type && Object.hasOwn(handlers, type) ? handlers[type] : null;
    if (!handler) {
      respond({ ok: false, error: `unknown message ${type ? JSON.stringify(type.slice(0, 60)) : '(no type)'}` });
      return false;
    }
    Promise.resolve()
      .then(() => handler(msg, sender))
      .then((res) => respond(res === undefined ? { ok: true } : res), (e) => {
        logger?.error(`[background] ${type}: ${e && e.message}`);
        respond({ ok: false, error: (e && e.message) || 'failed' });
      });
    return true;      // keep the channel open for the async respond
  };
}
