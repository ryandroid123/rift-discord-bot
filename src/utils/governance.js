const {
  ensureDataFile,
  resolveDataPath,
  readJson,
  writeJson
} = require("./storage");

const casesPath = resolveDataPath("cases.json");
const notesPath = resolveDataPath("notes.json");
const timelinePath = resolveDataPath("timeline.json");
const riskPath = resolveDataPath("risk.json");
const analyticsPath = resolveDataPath("analytics.json");
const runtimeConfigPath = resolveDataPath("runtime-config.json");
const lockdownPath = resolveDataPath("lockdown.json");
const schedulerPath = resolveDataPath("scheduler.json");

ensureDataFile("cases.json", []);
ensureDataFile("notes.json", {});
ensureDataFile("timeline.json", []);
ensureDataFile("risk.json", {});
ensureDataFile("analytics.json", {});
ensureDataFile("runtime-config.json", {});
ensureDataFile("lockdown.json", {});
ensureDataFile("scheduler.json", {});

let runtimeConfigCache = null;
let runtimeConfigLoadedAt = 0;
let analyticsCache = null;
const analyticsDirtyGuilds = new Set();
let analyticsFlushTimer = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return clone(override);
  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

function getRuntimeConfig(force = false) {
  const now = Date.now();
  if (!force && runtimeConfigCache && now - runtimeConfigLoadedAt < 4000) {
    return runtimeConfigCache;
  }
  runtimeConfigCache = readJson(runtimeConfigPath, {});
  runtimeConfigLoadedAt = now;
  return runtimeConfigCache;
}

function mergeWithRuntime(baseConfig) {
  const runtime = getRuntimeConfig();
  return deepMerge(baseConfig, runtime);
}

function setRuntimeConfigValue(group, keyPath, value) {
  const runtime = getRuntimeConfig(true);
  if (!runtime[group] || !isObject(runtime[group])) runtime[group] = {};

  const keys = String(keyPath || "").split(".").map(x => x.trim()).filter(Boolean);
  if (!keys.length) {
    runtime[group] = value;
  } else {
    let node = runtime[group];
    for (let i = 0; i < keys.length - 1; i += 1) {
      const k = keys[i];
      if (!isObject(node[k])) node[k] = {};
      node = node[k];
    }
    node[keys[keys.length - 1]] = value;
  }

  writeJson(runtimeConfigPath, runtime);
  runtimeConfigCache = runtime;
  runtimeConfigLoadedAt = Date.now();
  return runtime;
}

function getRuntimeConfigGroup(group) {
  const runtime = getRuntimeConfig();
  return runtime[group] || {};
}

function nextCaseId(cases, guildId) {
  const prefix = `C-${guildId.slice(-4)}-`;
  const max = cases
    .filter(c => c.guildId === guildId && typeof c.caseId === "string" && c.caseId.startsWith(prefix))
    .map(c => Number(c.caseId.replace(prefix, "")) || 0)
    .reduce((acc, n) => Math.max(acc, n), 0);
  return `${prefix}${String(max + 1).padStart(5, "0")}`;
}

function addCase(data) {
  const cases = readJson(casesPath, []);
  const entry = {
    caseId: nextCaseId(cases, data.guildId),
    guildId: data.guildId,
    moderatorId: data.moderatorId || "system",
    targetId: data.targetId || null,
    reason: data.reason || "No reason provided",
    timestamp: Date.now(),
    durationMs: data.durationMs || null,
    type: data.type || "note",
    meta: data.meta || {}
  };
  cases.push(entry);
  writeJson(casesPath, cases);
  return entry;
}

function getCase(guildId, caseId) {
  const cases = readJson(casesPath, []);
  return cases.find(c => c.guildId === guildId && c.caseId === caseId) || null;
}

function getCasesForUser(guildId, userId, limit = 20) {
  const cases = readJson(casesPath, []);
  return cases
    .filter(c => c.guildId === guildId && c.targetId === userId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

function addNote(guildId, userId, moderatorId, text) {
  const notes = readJson(notesPath, {});
  if (!notes[guildId]) notes[guildId] = {};
  if (!notes[guildId][userId]) notes[guildId][userId] = [];

  const id = `N-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id,
    moderatorId,
    text,
    timestamp: Date.now()
  };
  notes[guildId][userId].push(entry);
  writeJson(notesPath, notes);
  return entry;
}

function removeNote(guildId, userId, noteId) {
  const notes = readJson(notesPath, {});
  const arr = notes[guildId]?.[userId];
  if (!arr?.length) return false;
  const before = arr.length;
  notes[guildId][userId] = arr.filter(n => n.id !== noteId);
  const changed = notes[guildId][userId].length !== before;
  if (changed) writeJson(notesPath, notes);
  return changed;
}

function getNotes(guildId, userId) {
  const notes = readJson(notesPath, {});
  return notes[guildId]?.[userId] || [];
}

function appendTimeline(entry) {
  const items = readJson(timelinePath, []);
  items.push({
    ...entry,
    timestamp: entry.timestamp || Date.now()
  });
  if (items.length > 15000) items.splice(0, items.length - 15000);
  writeJson(timelinePath, items);
}

function getTimeline(guildId, options = {}) {
  const items = readJson(timelinePath, []);
  const userId = options.userId || null;
  const type = options.type || null;
  const limit = options.limit || 30;

  return items
    .filter(item => item.guildId === guildId)
    .filter(item => (userId ? item.targetId === userId || item.actorId === userId : true))
    .filter(item => (type ? item.type === type : true))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

function adjustRisk(guildId, userId, delta, reason = "n/a") {
  const data = readJson(riskPath, {});
  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) data[guildId][userId] = { score: 0, lastUpdatedAt: Date.now(), reasons: [] };

  const current = data[guildId][userId];
  current.score = Math.max(0, Math.min(100, (Number(current.score) || 0) + delta));
  current.lastUpdatedAt = Date.now();
  current.reasons = [...(current.reasons || []), { reason, delta, time: Date.now() }].slice(-25);
  writeJson(riskPath, data);
  return current.score;
}

function getRisk(guildId, userId) {
  const data = readJson(riskPath, {});
  return data[guildId]?.[userId]?.score || 0;
}

function decayRiskAll(step = 1) {
  const data = readJson(riskPath, {});
  for (const guildId of Object.keys(data)) {
    for (const userId of Object.keys(data[guildId] || {})) {
      const item = data[guildId][userId];
      item.score = Math.max(0, (Number(item.score) || 0) - step);
      item.lastUpdatedAt = Date.now();
    }
  }
  writeJson(riskPath, data);
}

function incrementAnalytics(guildId, key, amount = 1) {
  if (!analyticsCache) analyticsCache = readJson(analyticsPath, {});
  if (!analyticsCache[guildId]) analyticsCache[guildId] = {};
  analyticsCache[guildId][key] = (Number(analyticsCache[guildId][key]) || 0) + amount;
  analyticsCache[guildId].updatedAt = Date.now();
  analyticsDirtyGuilds.add(guildId);

  if (analyticsFlushTimer) return;
  analyticsFlushTimer = setTimeout(() => {
    analyticsFlushTimer = null;
    if (!analyticsDirtyGuilds.size || !analyticsCache) return;
    writeJson(analyticsPath, analyticsCache);
    analyticsDirtyGuilds.clear();
  }, 1500);
  if (typeof analyticsFlushTimer.unref === "function") analyticsFlushTimer.unref();
}

function flushPersistence() {
  if (analyticsFlushTimer) {
    clearTimeout(analyticsFlushTimer);
    analyticsFlushTimer = null;
  }
  if (!analyticsDirtyGuilds.size || !analyticsCache) return false;
  writeJson(analyticsPath, analyticsCache);
  analyticsDirtyGuilds.clear();
  return true;
}

function getAnalytics(guildId) {
  if (!analyticsCache) analyticsCache = readJson(analyticsPath, {});
  return analyticsCache[guildId] || {};
}

function getLockdownState(guildId) {
  const data = readJson(lockdownPath, {});
  return data[guildId] || null;
}

function setLockdownState(guildId, value) {
  const data = readJson(lockdownPath, {});
  data[guildId] = value;
  writeJson(lockdownPath, data);
}

function clearLockdownState(guildId) {
  const data = readJson(lockdownPath, {});
  delete data[guildId];
  writeJson(lockdownPath, data);
}

function getSchedulerState() {
  return readJson(schedulerPath, {});
}

function setSchedulerState(value) {
  writeJson(schedulerPath, value || {});
}

module.exports = {
  mergeWithRuntime,
  getRuntimeConfigGroup,
  setRuntimeConfigValue,
  addCase,
  getCase,
  getCasesForUser,
  addNote,
  removeNote,
  getNotes,
  appendTimeline,
  getTimeline,
  adjustRisk,
  getRisk,
  decayRiskAll,
  incrementAnalytics,
  flushPersistence,
  getAnalytics,
  getLockdownState,
  setLockdownState,
  clearLockdownState,
  getSchedulerState,
  setSchedulerState
};
