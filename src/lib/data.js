/* Loads everything the popup/dashboard need: this device's detailed entries
 * plus the compact summaries other devices published through Firefox Sync. */
(function (root) {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const S = root.LWStats;

  async function load() {
    const [local, syncAll, info] = await Promise.all([
      api.storage.local.get(null),
      api.storage.sync ? api.storage.sync.get(null).catch(() => ({})) : Promise.resolve({}),
      api.runtime.sendMessage({ type: "getSyncInfo" }).catch(() => null),
    ]);
    const deviceId = (info && info.deviceId) || local.deviceId || "local";
    const entries = S.entriesFromStorage(local);
    const { devices, rowsByDevice } = S.parseSync(syncAll);
    // This device is always represented by its full local data, never its own (possibly stale) summary.
    delete rowsByDevice[deviceId];
    if (!devices[deviceId]) devices[deviceId] = { name: "This computer" };
    devices[deviceId] = { ...devices[deviceId], self: true };
    const rows = S.rowsFromEntries(entries, deviceId);
    for (const r of Object.values(rowsByDevice)) rows.push(...r);
    return { local, entries, rows, devices, deviceId, syncInfo: info };
  }

  root.LWData = { load };
})(globalThis);
