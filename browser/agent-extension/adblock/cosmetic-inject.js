import { createCosmeticLookup, hidingCss } from './cosmetic-filters.js';

export const COSMETIC_MESSAGE = 'grol-adblock:cosmetic';

export function createCosmeticInjector({ loadCosmetic, insertCSS, extensionId }) {
  let lookup = null;
  const getLookup = () => (lookup ||= loadCosmetic().then(createCosmeticLookup).catch((e) => { lookup = null; throw e; }));

  async function inject(sender) {
    const { hostname, protocol } = new URL(sender.url);
    if (protocol !== 'http:' && protocol !== 'https:') return;
    const selectors = (await getLookup())(hostname);
    if (!selectors.length) return;
    const target = sender.documentId ? { tabId: sender.tab.id, documentIds: [sender.documentId] } : { tabId: sender.tab.id, frameIds: [sender.frameId] };
    await insertCSS({ target, css: hidingCss(selectors), origin: 'USER' });
  }

  return {
    listener(msg, sender) {
      if (!msg || msg.type !== COSMETIC_MESSAGE || sender.id !== extensionId || !sender.tab || !sender.url) return false;
      inject(sender).catch(() => {});
      return false;
    },
    reset() { lookup = null; },
    inject
  };
}
