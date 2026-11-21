/**
 * Thin persistence layer over chrome.storage.local.
 * All data stays in the browser; nothing is sent to external servers.
 *
 * Keys:
 *   campaign   – the active campaign (written ONLY by the background worker)
 *   templates  – saved message templates (written by the dashboard)
 *   drafts     – saved campaign snapshots (written by the dashboard)
 */

export const KEYS = Object.freeze({
  CAMPAIGN: 'campaign',
  TEMPLATES: 'templates',
  DRAFTS: 'drafts',
});

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Creates a store over any object implementing the promise-based
 * chrome.storage area API ({get(key), set(obj)}). Injectable for tests.
 */
export function createStore(area) {
  const read = async (key, fallback) => {
    const result = await area.get(key);
    return result?.[key] ?? fallback;
  };
  const write = async (key, value) => {
    try {
      await area.set({ [key]: value });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/quota/i.test(msg)) {
        throw new Error('Browser storage is full. Delete old drafts or clear the activity log and try again.');
      }
      throw err;
    }
  };

  return {
    getCampaign: () => read(KEYS.CAMPAIGN, null),
    saveCampaign: (campaign) => write(KEYS.CAMPAIGN, campaign),

    getTemplates: () => read(KEYS.TEMPLATES, []),
    async saveTemplate({ id, name, body }) {
      const list = await read(KEYS.TEMPLATES, []);
      const now = Date.now();
      const clean = { name: String(name || '').trim() || 'Untitled template', body: String(body ?? '') };
      const idx = id ? list.findIndex((t) => t.id === id) : -1;
      let saved;
      if (idx >= 0) {
        saved = { ...list[idx], ...clean, updatedAt: now };
        list[idx] = saved;
      } else {
        saved = { id: uid(), ...clean, createdAt: now, updatedAt: now };
        list.push(saved);
      }
      await write(KEYS.TEMPLATES, list);
      return saved;
    },
    async deleteTemplate(id) {
      const list = await read(KEYS.TEMPLATES, []);
      await write(KEYS.TEMPLATES, list.filter((t) => t.id !== id));
    },
    async seedTemplates(defaults) {
      const list = await read(KEYS.TEMPLATES, null);
      if (list && list.length) return;
      const now = Date.now();
      await write(KEYS.TEMPLATES, defaults.map((t) => ({ id: uid(), ...t, createdAt: now, updatedAt: now })));
    },

    getDrafts: () => read(KEYS.DRAFTS, []),
    async saveDraft(name, campaign) {
      const list = await read(KEYS.DRAFTS, []);
      const draft = {
        id: uid(),
        name: String(name || '').trim() || campaign?.name || 'Untitled draft',
        savedAt: Date.now(),
        contactCount: campaign?.contacts?.length ?? 0,
        campaign: structuredClone(campaign),
      };
      list.unshift(draft);
      await write(KEYS.DRAFTS, list);
      return draft;
    },
    async deleteDraft(id) {
      const list = await read(KEYS.DRAFTS, []);
      await write(KEYS.DRAFTS, list.filter((d) => d.id !== id));
    },
  };
}

const hasChromeStorage = typeof chrome !== 'undefined' && chrome?.storage?.local;

/** Default store backed by chrome.storage.local (null outside the extension). */
export const store = hasChromeStorage ? createStore(chrome.storage.local) : null;

/** Subscribes to changes of one storage key. Returns an unsubscribe function. */
export function onStorageKeyChanged(key, callback) {
  const listener = (changes, areaName) => {
    if (areaName === 'local' && changes[key]) callback(changes[key].newValue);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
