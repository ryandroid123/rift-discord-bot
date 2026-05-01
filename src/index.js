require("dotenv").config();

console.log("STARTING BOT...");
console.log("TOKEN EXISTS:", !!process.env.DISCORD_TOKEN);
console.log("CLIENT_ID:", process.env.CLIENT_ID);
console.log("GUILD_ID:", process.env.GUILD_ID);

const fs = require("fs");
const ms = require("ms");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AuditLogEvent
} = require("discord.js");

const config = require("./config");
const commands = require("./commands");
const { makeEmbed } = require("./utils/embeds");
const {
  readJson,
  writeJson,
  ensureDataFile,
  resolveDataPath,
  getDataDirInfo
} = require("./utils/storage");
const {
  getChannelByName,
  getCategoryByName,
  getRoleByName,
  hasStaffRole,
  hasAnyRole,
  getStaffRoles,
  createTicketsCategoryIfMissing,
  panicLockdown
} = require("./utils/setup");
const { checkStreams, loadStreams, saveStreams, checkTwitch, checkYouTube, checkKick, checkTikTok } = require("./utils/socials");
const { createGuildBackupSnapshot, restoreGuildBackupSnapshot } = require("./utils/backup");
const governance = require("./utils/governance");
const featureHub = require("./utils/feature-hub");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent
  ]
});

const { dataDir, source: dataDirSource } = getDataDirInfo();
const giveawaysPath = resolveDataPath("giveaways.json");
const antinukePath = resolveDataPath("antinuke.json");
const warningsPath = resolveDataPath("warnings.json");
const statePath = resolveDataPath("state.json");
const afkPath = resolveDataPath("afk.json");
const snipePath = resolveDataPath("snipe.json");
const automodPath = resolveDataPath("automod.json");
const moderationLogPath = resolveDataPath("moderation-log.json");
const backupsPath = resolveDataPath("backups.json");
const transcriptDir = resolveDataPath("transcripts");
const ticketMetaPath = resolveDataPath("ticket-meta.json");

ensureDataFile("giveaways.json", []);
ensureDataFile("streams.json", []);
ensureDataFile("warnings.json", {});
ensureDataFile("antinuke.json", {});
ensureDataFile("state.json", { lastRiddleDate: null, inviteCounts: [], riddleByGuild: {}, geniusByGuild: {} });
ensureDataFile("afk.json", {});
ensureDataFile("snipe.json", {});
ensureDataFile("automod.json", {});
ensureDataFile("moderation-log.json", []);
ensureDataFile("backups.json", []);
ensureDataFile("ticket-meta.json", {});
if (!fs.existsSync(transcriptDir)) fs.mkdirSync(transcriptDir, { recursive: true });

const automodCache = new Map();
const giveawayTimers = new Map();
const inviteCache = new Map();
const memberInviteStats = new Map();
const joinRaidCache = new Map();
const logQueueByChannel = new Map();
const streamCheckState = { running: false };
const antiNukeDedupe = new Map();
const coordinatedSpamCache = new Map();
const autoModActionDedupe = new Map();
const automodRecoveryDedupe = new Map();
const ticketCreateInFlight = new Map();
let afkCache = null;
let startupCompleted = false;
let shutdownFlushed = false;
const AUTOMOD_WARNING_PREFIX = "AutoMod (";

function logRuntimeError(label, error) {
  if (!error) {
    console.error(`[runtime] ${label}: unknown error`);
    return;
  }
  if (error instanceof Error) {
    console.error(`[runtime] ${label}: ${error.message}\n${error.stack || ""}`);
    return;
  }
  console.error(`[runtime] ${label}:`, error);
}

async function runStartupTask(name, fn, options = {}) {
  const critical = options.critical === true;
  console.log(`[startup] starting: ${name}`);
  try {
    await fn();
    console.log(`[startup] finished: ${name}`);
    return true;
  } catch (err) {
    logRuntimeError(`[startup] failed: ${name}`, err);
    if (critical) throw err;
    return false;
  }
}

function runIntervalSafely(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      result.catch(err => logRuntimeError(`[interval] ${name}`, err));
    }
  } catch (err) {
    logRuntimeError(`[interval] ${name}`, err);
  }
}

function runDetached(label, fn) {
  setImmediate(() => {
    Promise.resolve()
      .then(fn)
      .catch(err => logRuntimeError(label, err));
  });
}

function flushRuntimePersistence(reason = "runtime") {
  if (shutdownFlushed) return;
  shutdownFlushed = true;
  try {
    saveInviteCountsToState(memberInviteStats);
  } catch (err) {
    logRuntimeError(`flush invite counts (${reason})`, err);
  }
  try {
    if (typeof featureHub.flushPersistence === "function") {
      featureHub.flushPersistence();
    }
  } catch (err) {
    logRuntimeError(`flush feature hub (${reason})`, err);
  }
  try {
    if (typeof governance.flushPersistence === "function") {
      governance.flushPersistence();
    }
  } catch (err) {
    logRuntimeError(`flush governance (${reason})`, err);
  }
}

function logChannel(guild) {
  const cfg = governance.mergeWithRuntime(config);
  return getChannelByName(guild, cfg.channels.logs);
}

function getLogChannelByType(guild, kind = "general") {
  const cfg = governance.mergeWithRuntime(config);
  const channels = cfg.channels || {};
  const moderationPreferred = getChannelByName(guild, "📝┃mod-logs") || getChannelByName(guild, "mod-logs");
  const map = {
    general: channels.logs,
    moderation: moderationPreferred?.name || channels.moderationLogs || channels.logs,
    security: channels.securityLogs || channels.logs,
    message: channels.messageLogs || channels.logs,
    member: channels.memberLogs || channels.logs
  };
  return getChannelByName(guild, map[kind] || channels.logs);
}

function transcriptChannel(guild) {
  const cfg = governance.mergeWithRuntime(config);
  return getChannelByName(guild, cfg.channels.transcripts);
}

function state() {
  return readJson(statePath, { lastRiddleDate: null, inviteCounts: [], riddleByGuild: {}, geniusByGuild: {} });
}

function saveState(value) {
  writeJson(statePath, value);
}

function loadGiveaways() {
  const raw = readJson(giveawaysPath, []);
  if (!Array.isArray(raw)) return [];
  const normalized = normalizeGiveawayRecords(raw);
  if (JSON.stringify(normalized) !== JSON.stringify(raw)) {
    writeJson(giveawaysPath, normalized);
  }
  return normalized;
}

function saveGiveaways(data) {
  writeJson(giveawaysPath, normalizeGiveawayRecords(Array.isArray(data) ? data : []));
}

function normalizeRoleRuleList(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = String(item?.roleId || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      roleId: id,
      entries: Math.max(0, Math.min(100, Number(item.entries) || 0))
    });
  }
  return out;
}

function normalizeIdList(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = String(item || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeGiveawayRecord(raw = {}) {
  const entries = normalizeIdList(raw.entries || []);
  const entryCounts = {};
  if (raw.entryCounts && typeof raw.entryCounts === "object") {
    for (const [userIdRaw, countRaw] of Object.entries(raw.entryCounts)) {
      const userId = String(userIdRaw || "");
      if (!userId) continue;
      entryCounts[userId] = Math.max(1, Math.min(500, Number(countRaw) || 1));
    }
  }
  for (const userId of entries) {
    if (!entryCounts[userId]) entryCounts[userId] = 1;
  }

  const winnerIds = normalizeIdList(raw.winnerIds || []);
  const winnerId = raw.winnerId ? String(raw.winnerId) : (winnerIds[0] || null);
  if (winnerId && !winnerIds.includes(winnerId)) winnerIds.unshift(winnerId);

  return {
    messageId: String(raw.messageId || ""),
    channelId: String(raw.channelId || ""),
    guildId: String(raw.guildId || ""),
    hostId: String(raw.hostId || ""),
    prize: String(raw.prize || "Unknown prize"),
    endsAt: Number(raw.endsAt) || Date.now(),
    winners: Math.max(1, Math.min(25, Number(raw.winners) || 1)),
    requiredRoleIds: normalizeIdList(raw.requiredRoleIds || []),
    blacklistRoleIds: normalizeIdList(raw.blacklistRoleIds || []),
    bonusEntries: normalizeRoleRuleList(raw.bonusEntries || []),
    entries,
    entryCounts,
    entrySnapshots: raw.entrySnapshots && typeof raw.entrySnapshots === "object" ? raw.entrySnapshots : {},
    ended: raw.ended === true,
    endReason: String(raw.endReason || ""),
    createdAt: Number(raw.createdAt) || Date.now(),
    endedAt: Number(raw.endedAt) || null,
    winnerId,
    winnerIds,
    winnerDmHistory: Array.isArray(raw.winnerDmHistory) ? raw.winnerDmHistory : [],
    rerollHistory: Array.isArray(raw.rerollHistory) ? raw.rerollHistory : []
  };
}

function normalizeGiveawayRecords(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const normalized = normalizeGiveawayRecord(row);
    if (!normalized.messageId) continue;
    map.set(normalized.messageId, normalized);
  }
  return [...map.values()];
}

function loadWarnings() {
  return readJson(warningsPath, {});
}

function saveWarnings(data) {
  writeJson(warningsPath, data);
}

function loadAFK() {
  return readJson(afkPath, {});
}

function saveAFK(data) {
  writeJson(afkPath, data);
}

function getAFKStateCached() {
  if (!afkCache) afkCache = loadAFK();
  return afkCache;
}

function updateAFKStateAndPersist(mutator) {
  const current = getAFKStateCached();
  mutator(current);
  saveAFK(current);
}

function loadSnipes() {
  return readJson(snipePath, {});
}

function saveSnipes(data) {
  writeJson(snipePath, data);
}

function loadBackups() {
  return readJson(backupsPath, []);
}

function saveBackups(data) {
  writeJson(backupsPath, data);
}

function parseConfigValue(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      return JSON.parse(text);
    } catch {}
  }
  return text;
}

function parseDurationExtended(raw) {
  const input = String(raw || "").trim().toLowerCase();
  if (!input) return null;
  const direct = ms(input);
  if (direct) return direct;

  const monthMatch = input.match(/^(\d+)\s*(mo|mos|month|months)$/i);
  if (monthMatch) {
    const n = Number(monthMatch[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n * 30 * 24 * 60 * 60 * 1000;
  }
  return null;
}

function currentConfig() {
  return governance.mergeWithRuntime(config);
}

function addCaseAndTimeline(guildId, type, moderatorId, targetId, reason, durationMs = null, meta = {}) {
  const c = governance.addCase({
    guildId,
    type,
    moderatorId,
    targetId,
    reason,
    durationMs,
    meta
  });
  governance.appendTimeline({
    guildId,
    type,
    actorId: moderatorId,
    targetId,
    reason,
    caseId: c.caseId,
    details: meta
  });
  return c;
}

function formatCaseLine(c) {
  return `\`${c.caseId}\` • ${c.type} • <t:${Math.floor(c.timestamp / 1000)}:R> • ${c.reason}`;
}

function getUserHistorySummary(guildId, userId) {
  const warnings = getWarnings(guildId, userId);
  const cases = governance.getCasesForUser(guildId, userId, 30);
  const timeline = governance.getTimeline(guildId, { userId, limit: 30 });
  const automodHits = timeline.filter(x => x.type === "automod").length;
  const antiNukeHits = timeline.filter(x => String(x.type || "").includes("antinuke")).length;
  return {
    warnings,
    cases,
    timeline,
    automodHits,
    antiNukeHits
  };
}

function adjustRiskForRule(guildId, userId, rule, baseDelta = 0) {
  const weights = {
    "phishing-heuristic": 9,
    "suspicious-link-pattern": 8,
    "invite-link": 5,
    "rapid-spam": 4,
    "repeat-spam": 4,
    "duplicate-message": 4,
    "repeated-link-spam": 6,
    "repeated-attachment-spam": 6,
    "unicode-obfuscation": 5,
    "zalgo-obfuscation": 4
  };
  const delta = (weights[rule] || 3) + baseDelta;
  return governance.adjustRisk(guildId, userId, delta, `rule:${rule}`);
}

function getThreatAdjustedValue(base, risk, maxTightening = 3, minValue = 1) {
  const tighten = Math.min(maxTightening, Math.floor(risk / 20));
  return Math.max(minValue, base - tighten);
}

function isLinkContent(text) {
  return /https?:\/\/|discord(?:app)?\.com\/invite\/|discord\.gg\//i.test(text || "");
}

async function runAdvancedPurge(channel, options) {
  const scanLimit = Math.min(500, Math.max(1, options.limit || 100));
  const minutes = options.minutes || null;
  const keyword = String(options.keyword || "").toLowerCase();
  const mode = options.mode;
  const userId = options.userId || null;
  const cutoffTs = minutes ? Date.now() - (minutes * 60 * 1000) : null;

  const batchCount = Math.ceil(scanLimit / 100);
  let before = null;
  const all = [];

  for (let i = 0; i < batchCount; i += 1) {
    const fetched = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!fetched?.size) break;
    const arr = [...fetched.values()];
    all.push(...arr);
    before = arr[arr.length - 1]?.id || null;
    if (!before) break;
    if (all.length >= scanLimit) break;
  }

  const scanned = all.slice(0, scanLimit);
  const filtered = scanned.filter(m => {
    if (cutoffTs && m.createdTimestamp < cutoffTs) return false;
    if (mode === "all") return true;
    if (mode === "user") return userId ? m.author.id === userId : false;
    if (mode === "keyword") return keyword ? String(m.content || "").toLowerCase().includes(keyword) : false;
    if (mode === "links") return isLinkContent(m.content);
    if (mode === "attachments") return (m.attachments?.size || 0) > 0;
    return false;
  });

  let deleted = 0;
  const now = Date.now();
  const bulk = filtered.filter(m => now - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
  const old = filtered.filter(m => now - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000);

  if (bulk.length) {
    const chunks = [];
    for (let i = 0; i < bulk.length; i += 100) chunks.push(bulk.slice(i, i + 100));
    for (const chunk of chunks) {
      const result = await channel.bulkDelete(chunk.map(m => m.id), true).catch(() => null);
      deleted += result?.size || 0;
    }
  }

  for (const msg of old) {
    const ok = await msg.delete().then(() => true).catch(() => false);
    if (ok) deleted += 1;
  }

  return { scanned: scanned.length, matched: filtered.length, deleted };
}

function formatBackupList(backups, guildId) {
  const scoped = backups.filter(b => b.guildId === guildId).slice(0, 10);
  if (!scoped.length) return "No backups found for this server.";
  return scoped
    .map(b => {
      const created = `<t:${Math.floor((b.createdAt || 0) / 1000)}:R>`;
      const roles = b.stats?.roleCount ?? (b.roles?.length || 0);
      const channels = b.stats?.channelCount ?? (b.channels?.length || 0);
      return `• \`${b.id}\` • ${created} • roles: ${roles}, channels: ${channels}`;
    })
    .join("\n");
}

function loadAutomodState() {
  return readJson(automodPath, {});
}

function saveAutomodState(data) {
  writeJson(automodPath, data);
}

function createDefaultAutomodUserState() {
  return {
    totalActions: 0,
    lastRule: null,
    lastAction: null,
    lastAt: null,
    lastPunishmentAt: 0,
    punishmentCooldownUntil: 0,
    lastSuppressedAt: null,
    lastSuppressedRule: null,
    graceStartedAt: 0,
    graceUntil: 0,
    enforcementResetAt: 0,
    lastRecoveryAt: 0,
    lastRecoveryReason: null,
    lastRecoveryBy: null
  };
}

function getAutomodUserState(state, guildId, userId) {
  if (!state[guildId]) state[guildId] = {};
  if (!state[guildId][userId]) {
    state[guildId][userId] = createDefaultAutomodUserState();
  } else {
    state[guildId][userId] = {
      ...createDefaultAutomodUserState(),
      ...state[guildId][userId]
    };
  }
  return state[guildId][userId];
}

function shouldSkipAutomodRecovery(guildId, userId, windowMs = 5000) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const last = automodRecoveryDedupe.get(key) || 0;
  automodRecoveryDedupe.set(key, now);

  for (const [k, t] of automodRecoveryDedupe.entries()) {
    if (now - t > Math.max(60000, windowMs * 8)) automodRecoveryDedupe.delete(k);
  }

  return now - last < windowMs;
}

function clearAutomodRuntimeCacheForUser(guildId, userId) {
  const key = `${guildId}:${userId}`;
  automodCache.delete(key);

  const dedupePrefix = `${guildId}:${userId}:`;
  for (const dedupeKey of autoModActionDedupe.keys()) {
    if (dedupeKey.startsWith(dedupePrefix)) autoModActionDedupe.delete(dedupeKey);
  }

  for (const [coordKey, coordItem] of coordinatedSpamCache.entries()) {
    if (!coordItem?.users) continue;
    coordItem.users.delete(userId);
    if (!coordItem.users.size) coordinatedSpamCache.delete(coordKey);
  }
}

function clearAutomodWarningsForUser(guildId, userId) {
  const data = loadWarnings();
  const existing = data[guildId]?.[userId];
  if (!Array.isArray(existing) || !existing.length) return 0;

  const kept = existing.filter(w => !String(w.reason || "").startsWith(AUTOMOD_WARNING_PREFIX));
  const removed = existing.length - kept.length;
  if (!removed) return 0;

  data[guildId][userId] = kept;
  saveWarnings(data);
  return removed;
}

function getAutomodWarningsCount(guildId, userId, since = 0) {
  const warnings = getWarnings(guildId, userId);
  return warnings.filter(w => String(w.reason || "").startsWith(AUTOMOD_WARNING_PREFIX) && Number(w.time || 0) >= since).length;
}

function activateAutomodRecovery(guild, userId, options = {}) {
  if (!guild || !userId) return null;
  if (shouldSkipAutomodRecovery(guild.id, userId, options.dedupeWindowMs || 5000)) return null;

  const now = Date.now();
  const settings = getAutoModSettings();
  const graceMs = settings.recoveryGraceMs;

  clearAutomodRuntimeCacheForUser(guild.id, userId);
  const removedWarnings = clearAutomodWarningsForUser(guild.id, userId);

  const riskBefore = governance.getRisk(guild.id, userId);
  const targetRisk = Math.min(riskBefore, settings.recoveryRiskFloor);
  const riskDelta = targetRisk - riskBefore;
  if (riskDelta !== 0) {
    governance.adjustRisk(guild.id, userId, riskDelta, `automod-recovery:${options.reason || "timeout-recovered"}`);
  }

  const state = loadAutomodState();
  const userState = getAutomodUserState(state, guild.id, userId);
  userState.lastRule = null;
  userState.lastAction = null;
  userState.lastAt = null;
  userState.lastPunishmentAt = 0;
  userState.punishmentCooldownUntil = 0;
  userState.lastSuppressedAt = null;
  userState.lastSuppressedRule = null;
  userState.graceStartedAt = now;
  userState.graceUntil = now + graceMs;
  userState.enforcementResetAt = now;
  userState.lastRecoveryAt = now;
  userState.lastRecoveryReason = options.reason || "timeout-recovered";
  userState.lastRecoveryBy = options.actorId || null;
  saveAutomodState(state);

  return {
    graceMs,
    removedWarnings,
    riskBefore,
    riskAfter: governance.getRisk(guild.id, userId)
  };
}

function appendModerationLog(entry) {
  const items = readJson(moderationLogPath, []);
  items.push(entry);
  if (items.length > 5000) {
    items.splice(0, items.length - 5000);
  }
  writeJson(moderationLogPath, items);
}

function getAutoModSettings() {
  const automod = currentConfig().automod || {};
  return {
    enabled: automod.enabled !== false,
    whitelistRoles: automod.whitelistRoles || [],
    whitelistChannels: automod.whitelistChannels || [],
    whitelistUserIds: automod.whitelistUserIds || [],
    blockedWords: (automod.blockedWords || []).map(x => String(x).toLowerCase()),
    blockedTerms: (automod.blockedTerms || []).map(x => String(x).toLowerCase()),
    suspiciousLinkPatterns: (automod.suspiciousLinkPatterns || []).map(x => String(x).toLowerCase()),
    maxMentions: automod.maxMentions ?? 5,
    capsThreshold: automod.capsThreshold ?? 0.78,
    capsMinLetters: automod.capsMinLetters ?? 16,
    maxEmoji: automod.maxEmoji ?? 10,
    maxLineBreaks: automod.maxLineBreaks ?? 10,
    maxChars: automod.maxChars ?? 1200,
    charFloodRepeat: automod.charFloodRepeat ?? 20,
    maxZalgoMarks: automod.maxZalgoMarks ?? 10,
    spamWindowMs: automod.spamWindowMs ?? 6000,
    spamLimit: automod.spamLimit ?? 6,
    repeatWindowMs: automod.repeatWindowMs ?? 8000,
    repeatLimit: automod.repeatLimit ?? 3,
    duplicateWindowMs: automod.duplicateWindowMs ?? 20000,
    duplicateLimit: automod.duplicateLimit ?? 4,
    repeatedLinkLimit: automod.repeatedLinkLimit ?? 3,
    repeatedAttachmentLimit: automod.repeatedAttachmentLimit ?? 3,
    capsBypassRoles: automod.capsBypassRoles || [],
    timeoutThreshold: automod.timeoutThreshold ?? 2,
    severeTimeoutThreshold: automod.severeTimeoutThreshold ?? 4,
    severeTimeoutMs: automod.severeTimeoutMs ?? 60 * 60 * 1000,
    timeoutMs: automod.timeoutMs ?? 10 * 60 * 1000,
    kickThreshold: automod.kickThreshold ?? 6,
    banThreshold: automod.banThreshold ?? 8,
    allowKick: automod.allowKick === true,
    allowBan: automod.allowBan === true,
    antiInvite: automod.antiInvite !== false,
    antiPhishing: automod.antiPhishing !== false,
    punishmentCooldownMs: Math.min(10 * 60 * 1000, Math.max(5 * 60 * 1000, automod.punishmentCooldownMs ?? 7 * 60 * 1000)),
    actionDedupeMs: Math.max(1000, automod.actionDedupeMs ?? 4000),
    recoveryGraceMs: Math.max(30 * 1000, Math.min(10 * 60 * 1000, automod.recoveryGraceMs ?? 90 * 1000)),
    recoveryRiskFloor: Math.max(0, Math.min(40, automod.recoveryRiskFloor ?? 12)),
    adaptive: automod.adaptive || { enabled: false, maxRiskTightening: 0 },
    context: automod.context || { safeChannels: [], strictChannels: [] },
    escalationLadder: automod.escalationLadder || []
  };
}

function getAntiNukeSettings() {
  const antinuke = currentConfig().antinuke || {};
  return {
    threshold: antinuke.threshold ?? 3,
    windowMs: antinuke.windowMs ?? 30000,
    punishmentTimeoutMs: antinuke.punishmentTimeoutMs ?? 7 * 24 * 60 * 60 * 1000,
    punishmentCooldownMs: Math.max(30 * 1000, antinuke.punishmentCooldownMs ?? 8 * 60 * 1000),
    actionDedupeMs: Math.max(1000, antinuke.actionDedupeMs ?? 2500),
    trustedUserIds: antinuke.trustedUserIds || [],
    protectedRoles: antinuke.protectedRoles || [],
    actionThresholds: antinuke.actionThresholds || {},
    emergency: {
      stripDangerousPermissions: antinuke.emergency?.stripDangerousPermissions !== false,
      panicLockdown: antinuke.emergency?.panicLockdown !== false,
      timeoutOffender: antinuke.emergency?.timeoutOffender !== false,
      kickOffender: antinuke.emergency?.kickOffender === true,
      banOffender: antinuke.emergency?.banOffender === true
    }
  };
}

function normalizeMessageText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\uFEFF\u2060]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getMessageLinks(text) {
  const matches = String(text || "").match(/(?:https?:\/\/[^\s<]+|discord(?:app)?\.com\/invite\/[^\s<]+|discord\.gg\/[^\s<]+)/gi);
  return (matches || []).map(x => x.toLowerCase());
}

function getSuspiciousLinkEvidence(links = []) {
  const shorteners = new Set([
    "bit.ly", "t.co", "tinyurl.com", "goo.gl", "is.gd", "cutt.ly", "rb.gy", "shorturl.at"
  ]);
  const riskyTlds = new Set(["zip", "mov", "click", "top", "xyz", "gq", "tk", "work"]);

  for (const rawLink of links) {
    const cleaned = String(rawLink || "").trim();
    if (!cleaned) continue;

    if (cleaned.includes("@")) return `${cleaned} (contains @ in URL)`;
    if (cleaned.includes("xn--")) return `${cleaned} (punycode hostname)`;

    let parsed = null;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }

    const host = String(parsed.hostname || "").toLowerCase();
    if (!host) continue;
    if (shorteners.has(host)) return `${cleaned} (URL shortener)`;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return `${cleaned} (raw IP host)`;

    const parts = host.split(".").filter(Boolean);
    if (parts.length >= 5) return `${cleaned} (excessive subdomains)`;

    const tld = parts[parts.length - 1] || "";
    if (riskyTlds.has(tld)) return `${cleaned} (risky TLD .${tld})`;
    if (/[^\x00-\x7F]/.test(host)) return `${cleaned} (non-ASCII hostname)`;
  }

  return null;
}

function getAttachmentFingerprints(message) {
  if (!message.attachments?.size) return [];
  return [...message.attachments.values()].map(a => `${a.name || "file"}:${a.size || 0}:${a.contentType || ""}`);
}

function countEmojiLike(content) {
  const custom = (content.match(/<a?:\w+:\d+>/g) || []).length;
  const unicode = (content.match(/\p{Extended_Pictographic}/gu) || []).length;
  return custom + unicode;
}

function countZalgoMarks(content) {
  return (content.match(/[\u0300-\u036f]/g) || []).length;
}

function detectSuspiciousUnicode(content) {
  if (!content) return false;
  const hasBiDi = /[\u202A-\u202E\u2066-\u2069]/.test(content);
  const hasZeroWidth = /[\u200B-\u200F\uFEFF\u2060]/.test(content);
  const normalized = content.normalize("NFKC");
  const hasConfusableShift = normalized !== content && /[A-Za-z0-9]/.test(normalized);
  return hasBiDi || hasZeroWidth || hasConfusableShift;
}

function isAutoModBypassed(message, settings) {
  if (!settings.enabled) return true;
  if (!message.member) return true;
  if (hasAnyRole(message.member, ["Head Moderator"])) return true;
  if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (settings.whitelistUserIds.includes(message.author.id)) return true;
  if (settings.whitelistChannels.includes(message.channel.id)) return true;
  if (hasAnyRole(message.member, settings.whitelistRoles)) return true;
  return false;
}

function getAutoModHistoryKey(message) {
  return `${message.guild.id}:${message.author.id}`;
}

function getAutoModHistory(message, settings) {
  const key = getAutoModHistoryKey(message);
  const now = Date.now();
  const maxWindow = Math.max(
    settings.spamWindowMs,
    settings.repeatWindowMs,
    settings.duplicateWindowMs
  );
  const history = (automodCache.get(key) || []).filter(x => now - x.time <= maxWindow);
  return { key, history, now };
}

function storeAutoModHistory(key, history, item) {
  history.push(item);
  if (history.length > 60) history.splice(0, history.length - 60);
  automodCache.set(key, history);
}

function detectAutoModTrigger(message, settings, options = {}) {
  const shouldRecordHistory = options.recordHistory !== false;
  const content = message.content || "";
  const minAggressiveLen = currentConfig().automod?.minMessageLengthForAggressiveChecks ?? 6;
  const aggressiveEligible = content.length >= minAggressiveLen;
  const lower = content.toLowerCase();
  const links = getMessageLinks(content);
  const attachments = getAttachmentFingerprints(message);
  const normalized = normalizeMessageText(content);
  const mentions = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
  const lineBreaks = (content.match(/\n/g) || []).length;
  const emojiCount = countEmojiLike(content);
  const zalgoMarks = countZalgoMarks(content);
  const letters = content.replace(/[^a-z]/gi, "");
  const caps = letters.replace(/[^A-Z]/g, "").length;
  const bypassCaps = hasAnyRole(message.member, settings.capsBypassRoles || []);
  const { key, history, now } = getAutoModHistory(message, settings);
  const risk = governance.getRisk(message.guild.id, message.author.id);

  const strictChannel = (settings.context?.strictChannels || []).includes(message.channel.id);
  const safeChannel = (settings.context?.safeChannels || []).includes(message.channel.id);

  let maxMentions = settings.maxMentions;
  let spamLimit = settings.spamLimit;
  let repeatLimit = settings.repeatLimit;
  let duplicateLimit = settings.duplicateLimit;
  let maxEmoji = settings.maxEmoji;
  let maxLineBreaks = settings.maxLineBreaks;
  let capsThreshold = settings.capsThreshold;

  if (settings.adaptive?.enabled) {
    const tightenMax = settings.adaptive.maxRiskTightening ?? 3;
    spamLimit = getThreatAdjustedValue(spamLimit, risk, tightenMax);
    repeatLimit = getThreatAdjustedValue(repeatLimit, risk, tightenMax);
    duplicateLimit = getThreatAdjustedValue(duplicateLimit, risk, tightenMax);
    maxMentions = getThreatAdjustedValue(maxMentions, risk, tightenMax);
    maxEmoji = getThreatAdjustedValue(maxEmoji, risk, tightenMax);
    maxLineBreaks = getThreatAdjustedValue(maxLineBreaks, risk, tightenMax);
    capsThreshold = Math.max(0.55, capsThreshold - Math.min(0.12, Math.floor(risk / 20) * 0.03));
  }

  if (strictChannel) {
    spamLimit = Math.max(2, spamLimit - 1);
    repeatLimit = Math.max(2, repeatLimit - 1);
    duplicateLimit = Math.max(2, duplicateLimit - 1);
    maxMentions = Math.max(2, maxMentions - 1);
    maxEmoji = Math.max(4, maxEmoji - 2);
  }

  if (safeChannel) {
    spamLimit += 1;
    repeatLimit += 1;
    duplicateLimit += 1;
    maxMentions += 1;
    maxEmoji += 2;
  }

  if (shouldRecordHistory) {
    const historyItem = {
      time: now,
      text: content,
      normalized,
      links,
      attachments
    };
    storeAutoModHistory(key, history, historyItem);
  }

  const isInviteLink = settings.antiInvite && links.some(link =>
    /discord(?:app)?\.com\/invite\/|discord\.gg\//i.test(link)
  );
  if (isInviteLink) {
    return { rule: "invite-link", reason: "Invite link detected", evidence: links.join("\n").slice(0, 1000) };
  }

  const blockedHit = [...settings.blockedWords, ...settings.blockedTerms].find(term => term && lower.includes(term));
  if (blockedHit) {
    return { rule: "blocked-terms", reason: "Blocked term detected", evidence: blockedHit };
  }

  if (settings.antiPhishing) {
    const suspiciousPattern = settings.suspiciousLinkPatterns.find(p => p && lower.includes(p));
    if (suspiciousPattern) {
      return { rule: "suspicious-link-pattern", reason: "Suspicious link pattern detected", evidence: suspiciousPattern };
    }
    const suspiciousEvidence = getSuspiciousLinkEvidence(links);
    if (suspiciousEvidence) {
      return { rule: "phishing-heuristic", reason: "Potential malicious link detected", evidence: suspiciousEvidence };
    }
  }

  if (mentions >= maxMentions) {
    return { rule: "mention-spam", reason: "Too many mentions", evidence: `${mentions} mentions` };
  }

  if (!bypassCaps && letters.length >= settings.capsMinLetters && caps / letters.length >= capsThreshold) {
    return { rule: "mass-caps", reason: "Excessive capitalization", evidence: `${caps}/${letters.length} capital letters` };
  }

  if (emojiCount >= maxEmoji) {
    return { rule: "emoji-spam", reason: "Too many emojis", evidence: `${emojiCount} emojis` };
  }

  if (lineBreaks >= maxLineBreaks) {
    return { rule: "line-break-flood", reason: "Too many line breaks", evidence: `${lineBreaks} line breaks` };
  }

  if (aggressiveEligible && content.length >= settings.maxChars) {
    return { rule: "char-flood", reason: "Message too long", evidence: `${content.length} characters` };
  }

  if (aggressiveEligible && new RegExp(`(.)\\1{${Math.max(2, settings.charFloodRepeat)}}`).test(content)) {
    return { rule: "character-repeat", reason: "Character flooding detected", evidence: "Repeated character sequence" };
  }

  if (aggressiveEligible && zalgoMarks >= settings.maxZalgoMarks) {
    return { rule: "zalgo-obfuscation", reason: "Excessive combining characters", evidence: `${zalgoMarks} combining marks` };
  }

  if (aggressiveEligible && detectSuspiciousUnicode(content)) {
    return { rule: "unicode-obfuscation", reason: "Suspicious Unicode obfuscation detected", evidence: "BiDi/zero-width/confusable Unicode patterns" };
  }

  const recentSpam = history.filter(x => now - x.time <= settings.spamWindowMs);
  if (recentSpam.length >= spamLimit) {
    return { rule: "rapid-spam", reason: "Messages sent too quickly", evidence: `${recentSpam.length} messages in ${settings.spamWindowMs}ms` };
  }

  const recentRepeat = history.filter(x => now - x.time <= settings.repeatWindowMs);
  const repeatedExact = recentRepeat.filter(x => x.text && x.text === content).length;
  if (content && repeatedExact >= repeatLimit) {
    return { rule: "repeat-spam", reason: "Repeated identical messages", evidence: `${repeatedExact} repeated messages` };
  }

  const recentDuplicate = history.filter(x => now - x.time <= settings.duplicateWindowMs);
  const repeatedNormalized = recentDuplicate.filter(x => x.normalized && x.normalized === normalized).length;
  if (normalized && repeatedNormalized >= duplicateLimit) {
    return { rule: "duplicate-message", reason: "Duplicate/near-duplicate spam", evidence: `${repeatedNormalized} duplicate messages` };
  }

  const slowSpamRecent = history.filter(x => now - x.time <= 60 * 1000);
  const slowSpamCount = slowSpamRecent.filter(x => x.normalized === normalized).length;
  if (normalized && slowSpamCount >= 6) {
    return { rule: "slow-spam", reason: "Repeated content over extended period", evidence: `${slowSpamCount} repeated messages in 60s` };
  }

  if (normalized) {
    const cKey = `${message.guild.id}:${message.channel.id}:${normalized.slice(0, 80)}`;
    const cItem = coordinatedSpamCache.get(cKey) || { users: new Map(), last: 0 };
    cItem.users.set(message.author.id, now);
    cItem.last = now;
    coordinatedSpamCache.set(cKey, cItem);
    for (const [u, t] of cItem.users.entries()) {
      if (now - t > 30000) cItem.users.delete(u);
    }
    if (cItem.users.size >= 4) {
      return { rule: "coordinated-spam", reason: "Multiple users posting the same pattern", evidence: `${cItem.users.size} users in 30s` };
    }
  }

  if (links.length) {
    const recentLinks = recentDuplicate.flatMap(x => x.links || []);
    const repeatedLink = links.find(link => recentLinks.filter(existing => existing === link).length >= settings.repeatedLinkLimit);
    if (repeatedLink) {
      return { rule: "repeated-link-spam", reason: "Repeated link spam", evidence: repeatedLink };
    }
  }

  if (attachments.length) {
    const recentAttachments = recentDuplicate.flatMap(x => x.attachments || []);
    const repeatedAttachment = attachments.find(att => recentAttachments.filter(existing => existing === att).length >= settings.repeatedAttachmentLimit);
    if (repeatedAttachment) {
      return { rule: "repeated-attachment-spam", reason: "Repeated attachment spam", evidence: repeatedAttachment };
    }
  }

  return null;
}

function shouldSkipAutoModDuplicate(guildId, userId, action, rule, settings) {
  const key = `${guildId}:${userId}:${action}:${rule}`;
  const now = Date.now();
  const last = autoModActionDedupe.get(key) || 0;
  autoModActionDedupe.set(key, now);

  const dedupeWindowMs = settings.actionDedupeMs;
  for (const [k, t] of autoModActionDedupe.entries()) {
    if (now - t > Math.max(30000, dedupeWindowMs * 4)) autoModActionDedupe.delete(k);
  }

  return now - last < dedupeWindowMs;
}

async function applyAutoModAction(message, trigger) {
  const settings = getAutoModSettings();
  const member = message.member;
  if (!member) return false;

  const now = Date.now();
  const state = loadAutomodState();
  const userState = getAutomodUserState(state, message.guild.id, message.author.id);

  if (Number(userState.punishmentCooldownUntil) > now) {
    await message.delete().catch(() => {});
    userState.lastSuppressedAt = now;
    userState.lastSuppressedRule = trigger.rule;
    saveAutomodState(state);
    governance.incrementAnalytics(message.guild.id, "automodSuppressedByCooldown", 1);
    runDetached("automod-cooldown-log", () => sendTypedLog(
      message.guild,
      "moderation",
      "AutoMod Action Suppressed",
      `${message.author.tag} matched ${trigger.rule}, but punishment was suppressed by cooldown.`,
      "info",
      [
        { name: "Rule", value: trigger.rule, inline: true },
        { name: "Cooldown Remaining", value: `${Math.ceil((userState.punishmentCooldownUntil - now) / 1000)}s`, inline: true },
        { name: "Evidence", value: (trigger.evidence || "n/a").slice(0, 1000) }
      ]
    ));
    return false;
  }

  const warningReason = `AutoMod (${trigger.rule}): ${trigger.reason}`;
  addWarning(message.guild.id, message.author.id, "AutoMod", warningReason);
  const offences = getAutomodWarningsCount(message.guild.id, message.author.id, Number(userState.enforcementResetAt) || 0);
  governance.incrementAnalytics(message.guild.id, "automodTriggers", 1);
  const riskScore = adjustRiskForRule(message.guild.id, message.author.id, trigger.rule);
  const severityBase = Math.min(10, Math.max(1, Math.floor(offences / 2) + Math.floor(riskScore / 15)));

  const severityWeights = {
    "phishing-heuristic": 4,
    "suspicious-link-pattern": 3,
    "coordinated-spam": 3,
    "slow-spam": 2,
    "repeated-link-spam": 2
  };
  const severity = Math.min(10, severityBase + (severityWeights[trigger.rule] || 0));

  let action = "warn";
  let actionDetail = "Warned user and removed message";
  let durationMs = null;

  const ladder = [...(settings.escalationLadder || [])]
    .sort((a, b) => (a.minSeverity || 0) - (b.minSeverity || 0));
  let selected = null;
  for (const step of ladder) {
    if (severity >= (step.minSeverity || 0)) selected = step;
  }

  if (!selected) {
    if (offences >= settings.banThreshold && settings.allowBan) {
      selected = { action: "ban" };
    } else if (offences >= settings.kickThreshold && settings.allowKick) {
      selected = { action: "kick" };
    } else if (offences >= settings.severeTimeoutThreshold) {
      selected = { action: "timeout", durationMs: settings.severeTimeoutMs };
    } else if (offences >= settings.timeoutThreshold) {
      selected = { action: "timeout", durationMs: settings.timeoutMs };
    } else {
      selected = { action: "warn" };
    }
  }

  if (selected.requireFlag && settings[selected.requireFlag] !== true) {
    selected = { action: "timeout", durationMs: settings.timeoutMs };
  }

  const historyRules = new Set([
    "rapid-spam",
    "repeat-spam",
    "duplicate-message",
    "slow-spam",
    "coordinated-spam",
    "repeated-link-spam",
    "repeated-attachment-spam"
  ]);
  const inRecoveryGrace = Number(userState.graceUntil) > now;
  if (inRecoveryGrace && historyRules.has(trigger.rule) && ["timeout", "kick", "ban"].includes(selected.action)) {
    selected = { action: "warn" };
    governance.incrementAnalytics(message.guild.id, "automodSuppressedByGrace", 1);
    runDetached("automod-grace-log", () => sendTypedLog(
      message.guild,
      "moderation",
      "AutoMod Grace Suppression",
      `${message.author.tag} matched ${trigger.rule}, but escalation was suppressed during recovery grace.`,
      "info",
      [
        { name: "Rule", value: trigger.rule, inline: true },
        { name: "Grace Remaining", value: `${Math.ceil((userState.graceUntil - now) / 1000)}s`, inline: true },
        { name: "Evidence", value: (trigger.evidence || "n/a").slice(0, 1000) }
      ]
    ));
  }

  if (shouldSkipAutoModDuplicate(message.guild.id, message.author.id, selected.action, trigger.rule, settings)) {
    await message.delete().catch(() => {});
    governance.incrementAnalytics(message.guild.id, "automodSuppressedByDedupe", 1);
    runDetached("automod-dedupe-log", () => sendTypedLog(
      message.guild,
      "moderation",
      "AutoMod Duplicate Suppressed",
      `${message.author.tag} matched ${trigger.rule}, but a duplicate action was suppressed.`,
      "info",
      [{ name: "Rule", value: trigger.rule, inline: true }]
    ));
    return false;
  }

  await message.delete().catch(() => {});

  if (selected.action === "ban") {
    action = "ban";
    actionDetail = "Banned user for repeated AutoMod violations";
    await message.guild.members.ban(message.author.id, { reason: `AutoMod: ${trigger.rule}` }).catch(() => {});
    governance.incrementAnalytics(message.guild.id, "automodBans", 1);
  } else if (selected.action === "kick") {
    action = "kick";
    actionDetail = "Kicked user for repeated AutoMod violations";
    await member.kick(`AutoMod: ${trigger.rule}`).catch(() => {});
    governance.incrementAnalytics(message.guild.id, "automodKicks", 1);
  } else if (selected.action === "timeout" && member.moderatable) {
    durationMs = selected.durationMs || settings.timeoutMs;
    action = "timeout";
    actionDetail = `Timed out for ${Math.floor(durationMs / 60000)} minutes`;
    await member.timeout(durationMs, `AutoMod: ${trigger.rule}`).catch(() => {});
    governance.incrementAnalytics(message.guild.id, "automodTimeouts", 1);
  } else if (selected.action === "delete") {
    action = "delete";
    actionDetail = "Deleted message";
  }

  const punishmentAt = Date.now();
  userState.totalActions += 1;
  userState.lastRule = trigger.rule;
  userState.lastAction = action;
  userState.lastAt = punishmentAt;
  userState.lastPunishmentAt = punishmentAt;
  userState.punishmentCooldownUntil = punishmentAt + settings.punishmentCooldownMs;
  saveAutomodState(state);

  runDetached("automod-dm", () => message.author.send({
    embeds: [makeEmbed("AutoMod Action", `Rule: **${trigger.rule}**\nReason: ${trigger.reason}\nAction: **${actionDetail}**`, "warn")]
  }).catch(() => {}));

  runDetached("automod-log", async () => {
    sendTypedLog(message.guild, "moderation", "AutoMod Action", `${message.author.tag} triggered ${trigger.rule}.`, "warn", [
      { name: "Rule", value: trigger.rule, inline: true },
      { name: "Action", value: action, inline: true },
      { name: "Severity", value: String(severity), inline: true },
      { name: "Risk", value: String(riskScore), inline: true },
      { name: "Warnings", value: String(offences), inline: true },
      { name: "Evidence", value: (trigger.evidence || "n/a").slice(0, 1000) },
      { name: "Message", value: (message.content || "[attachment-only]").slice(0, 1000) }
    ]);

    const autoCase = addCaseAndTimeline(
      message.guild.id,
      "automod",
      client.user?.id || "system",
      message.author.id,
      `${trigger.rule}: ${trigger.reason}`,
      durationMs,
      { action, evidence: trigger.evidence || null, severity, warnings: offences, risk: riskScore }
    );

    appendModerationLog({
      type: "automod",
      guildId: message.guild.id,
      userId: message.author.id,
      rule: trigger.rule,
      reason: trigger.reason,
      evidence: trigger.evidence || null,
      action,
      warnings: offences,
      caseId: autoCase.caseId,
      time: Date.now()
    });
  });

  return true;
}

function canUseModCommand(member) {
  return hasAnyRole(member, ["Founder", "Admin", "Head Moderator", "Moderator"]);
}

function canUseBasicModCommand(member) {
  return hasAnyRole(member, ["Founder", "Admin", "Head Moderator", "Moderator", "Trial Moderator"]);
}

function canManageTicketsCommand(member) {
  return canUseBasicModCommand(member);
}

function featureContext() {
  return {
    commands,
    makeEmbed,
    governance,
    canUseModCommand,
    canUseBasicModCommand,
    canManageTicketsCommand,
    currentConfig,
    getChannelByName,
    sendLog,
    sendTypedLog,
    isTicketChannel,
    loadGiveaways,
    saveGiveaways,
    scheduleGiveaway,
    endGiveaway,
    pickGiveawayWinners,
    notifyGiveawayWinners,
    loadBackups,
    sendTranscript,
    createTicket
  };
}

async function sendLog(guild, title, description, type = "info", fields = []) {
  const ch = getLogChannelByType(guild, "general");
  if (!ch) return;
  queueLogSend(ch, { embeds: [makeEmbed(title, description, type, fields)] });
}

async function sendTypedLog(guild, kind, title, description, type = "info", fields = []) {
  const ch = getLogChannelByType(guild, kind);
  if (!ch) return;
  queueLogSend(ch, { embeds: [makeEmbed(title, description, type, fields)] });
}

function queueLogSend(channel, payload) {
  const channelId = channel.id;
  const queue = logQueueByChannel.get(channelId) || { items: [], processing: false, channel, channelId };
  queue.items.push(payload);
  logQueueByChannel.set(channelId, queue);
  if (!queue.processing) drainLogQueue(queue);
}

function drainLogQueue(queue) {
  queue.processing = true;
  runDetached(`log-queue:${queue.channelId}`, async () => {
    while (queue.items.length) {
      const next = queue.items.shift();
      await queue.channel.send(next).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    queue.processing = false;
    if (queue.items.length) drainLogQueue(queue);
  });
}

function parseTicketOwnerId(channel) {
  const topic = String(channel?.topic || "");
  const m = topic.match(/owner:(\d{15,25})/);
  return m ? m[1] : null;
}

function parseTicketType(channel) {
  const topic = String(channel?.topic || "");
  const m = topic.match(/type:([a-z-]+)/i);
  return m ? String(m[1]).toLowerCase() : "unknown";
}

function findExistingTicketChannel(guild, categoryId, ownerId, type, channelName) {
  return guild.channels.cache.find(c => {
    if (c.parentId !== categoryId) return false;
    if (c.name === channelName) return true;
    return parseTicketOwnerId(c) === ownerId && parseTicketType(c) === type;
  }) || null;
}

function formatTranscriptMessage(message) {
  const ts = new Date(message.createdTimestamp || Date.now()).toISOString();
  const author = message.author ? `${message.author.tag} (${message.author.id})` : "Unknown";
  const text = String(message.content || "").trim();
  const body = [];
  body.push(`[${ts}] ${author}`);
  body.push(text ? text : "[no text]");

  const attachments = [...(message.attachments?.values?.() || [])];
  if (attachments.length) {
    body.push("Attachments:");
    for (const a of attachments) {
      const name = a.name || "file";
      const url = a.url || a.proxyURL || "";
      body.push(`- ${name}${url ? ` -> ${url}` : ""}`);
    }
  }

  const embeds = [...(message.embeds || [])];
  if (embeds.length) {
    body.push("Embeds:");
    embeds.forEach((e, idx) => {
      const parts = [];
      if (e.title) parts.push(`title="${String(e.title).slice(0, 200)}"`);
      if (e.description) parts.push(`desc="${String(e.description).slice(0, 280)}"`);
      if (e.url) parts.push(`url=${e.url}`);
      if (e.type) parts.push(`type=${e.type}`);
      body.push(`- [${idx + 1}] ${parts.join(" | ") || "embed"}`);
    });
  }

  return body.join("\n");
}

function buildTranscriptText(ticketChannel, messages, meta = {}) {
  const lines = [];
  const nowIso = new Date().toISOString();
  const ownerId = meta.ticketOwnerId || parseTicketOwnerId(ticketChannel);
  const messageCount = messages.length;

  lines.push(`# Transcript: ${ticketChannel?.name || "unknown-channel"}`);
  lines.push(`Generated: ${nowIso}`);
  lines.push(`Channel Created: ${ticketChannel?.createdTimestamp ? new Date(ticketChannel.createdTimestamp).toISOString() : "Unknown"}`);
  lines.push(`Channel ID: ${ticketChannel?.id || "unknown"}`);
  lines.push(`Ticket Owner: ${ownerId ? `<@${ownerId}> (${ownerId})` : "Unknown"}`);
  lines.push(`Ticket Type: ${meta.ticketType || parseTicketType(ticketChannel) || "unknown"}`);
  lines.push(`Ticket Status: ${meta.ticketStatus || "closed"}`);
  lines.push(`Ticket Priority: ${meta.priority || "normal"}`);
  lines.push(`Claimed By: ${meta.claimedBy ? `<@${meta.claimedBy}> (${meta.claimedBy})` : "Unclaimed"}`);
  lines.push(`Closed By: ${meta.closedBy ? `<@${meta.closedBy}> (${meta.closedBy})` : "Unknown"}`);
  lines.push(`Close Reason: ${meta.closeReason || "No reason provided"}`);
  lines.push(`Message Count: ${messageCount}`);
  lines.push("");
  lines.push("----- Conversation -----");
  lines.push("");

  if (!messages.length) {
    lines.push("[Channel had no readable messages at close time.]");
  } else {
    for (const m of messages) {
      lines.push(formatTranscriptMessage(m));
      lines.push("");
    }
  }

  const out = lines.join("\n").trim() + "\n";
  return out;
}

async function sendTranscript(guild, ticketChannel, linesOrMessages, meta = {}) {
  const ch = transcriptChannel(guild);
  if (!ch) return null;

  const items = Array.isArray(linesOrMessages) ? linesOrMessages : [];
  const isMessageObject = items.length ? typeof items[0] === "object" && items[0] !== null && "createdTimestamp" in items[0] : false;
  const transcriptText = isMessageObject
    ? buildTranscriptText(ticketChannel, items, meta)
    : String((items || []).join("\n")).trim() + "\n";

  const safeName = String(ticketChannel.name || "ticket").replace(/[^a-zA-Z0-9-_]/g, "_");
  const fileName = `${safeName}-${Date.now()}.txt`;
  const filePath = resolveDataPath("transcripts", fileName);
  fs.writeFileSync(filePath, transcriptText, "utf8");
  const sizeBytes = Buffer.byteLength(transcriptText, "utf8");
  const sizeKb = (sizeBytes / 1024).toFixed(2);

  await ch.send({
    embeds: [makeEmbed("Ticket Transcript Saved", `Channel: ${ticketChannel.name}\nMessages: **${meta.messageCount || items.length || 0}**\nSize: **${sizeKb} KB**\nClosed By: ${meta.closedBy ? `<@${meta.closedBy}>` : "Unknown"}`, "info", [
      { name: "Reason", value: (meta.closeReason || "No reason provided").slice(0, 1000) }
    ])],
    files: [filePath]
  }).catch(() => {});

  fs.unlink(filePath, () => {});
  return {
    fileName,
    sizeBytes,
    sizeKb: Number(sizeKb),
    messageCount: meta.messageCount || items.length || 0
  };
}

function isTicketChannel(channel) {
  return channel?.parent && channel.parent.name === config.categories.tickets;
}

function buildTicketOverwrites(guild, userId) {
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles
      ]
    }
  ];

  for (const role of getStaffRoles(guild)) {
    overwrites.push({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages
      ]
    });
  }

  return overwrites;
}

async function createTicket(guild, user, type, answers = null) {
  const key = `${guild.id}:${user.id}:${String(type || "").toLowerCase()}`;
  if (ticketCreateInFlight.has(key)) {
    return ticketCreateInFlight.get(key);
  }

  const task = (async () => {
    const category = await createTicketsCategoryIfMissing(guild);
    const safe = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "user";
    const channelName = type === "support" ? `support-${safe}` : `application-${safe}`;

    const existing = findExistingTicketChannel(guild, category.id, user.id, type, channelName);
    if (existing) return { channel: existing, exists: true };

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `owner:${user.id};type:${type}`,
      permissionOverwrites: buildTicketOverwrites(guild, user.id)
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("claim_ticket").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unclaim_ticket").setLabel("Unclaim").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("close_ticket_button").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("reopen_ticket").setLabel("Reopen Ticket").setStyle(ButtonStyle.Success).setDisabled(true)
    );
    const priorityRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_priority_cycle").setLabel("Priority: Normal").setStyle(ButtonStyle.Secondary)
    );

    const fields = [
      { name: "Opened By", value: user.tag, inline: true },
      { name: "Type", value: type === "support" ? "Support" : "Staff Application", inline: true },
      { name: "Status", value: "Open", inline: true },
      { name: "Priority", value: "Normal", inline: true },
      { name: "Claimed By", value: "Unclaimed", inline: true }
    ];

  if (answers) {
    fields.push(
      { name: "Age", value: answers.age },
      { name: "Timezone", value: answers.timezone },
      { name: "Experience", value: answers.experience },
      { name: "Availability", value: answers.availability || "Not provided" },
      { name: "Why", value: answers.why }
    );
    if (answers.applicationId) {
      fields.push({ name: "Application ID", value: answers.applicationId, inline: true });
    }
  }

    const staffPing = type === "support"
      ? getStaffRoles(guild)
        .filter(r => ["Head Moderator", "Moderator", "Trial Moderator"].includes(r.name))
        .map(r => `<@&${r.id}>`)
        .join(" ")
      : "";

    const panel = await channel.send({
      content: type === "support" ? staffPing : "",
      embeds: [
        makeEmbed(
          type === "support" ? "Support Ticket Created" : "Staff Application Submitted",
          `${user}\n\n${
            type === "support"
              ? "Please explain your issue clearly. Staff will reply soon."
              : "Your application has been submitted for review."
          }`,
          "info",
          fields
        )
      ],
      components: [row, priorityRow]
    });

    const allTicketMeta = readJson(ticketMetaPath, {});
    if (!allTicketMeta[guild.id]) allTicketMeta[guild.id] = {};
    allTicketMeta[guild.id][channel.id] = {
      claimedBy: null,
      claimedAt: null,
      claimHistory: [],
      notes: [],
      closeHistory: [],
      reopenHistory: [],
      status: "open",
      priority: "normal",
      ownerId: user.id,
      ticketType: type,
      openedAt: Date.now(),
      panelMessageId: panel.id,
      actionHistory: [{ action: "opened", by: user.id, at: Date.now(), source: "create-ticket" }]
    };
    writeJson(ticketMetaPath, allTicketMeta);

    await sendLog(guild, "Ticket Opened", `${user.tag} opened a ${type} ticket.`, "success", [
      { name: "Channel", value: `${channel}` }
    ]);

    return { channel, exists: false };
  })();

  ticketCreateInFlight.set(key, task);
  try {
    return await task;
  } finally {
    ticketCreateInFlight.delete(key);
  }
}

async function ensureRulesMessage(guild) {
  const rulesChannel = getChannelByName(guild, config.channels.rules);
  if (!rulesChannel) return;

  const recent = await rulesChannel.messages.fetch({ limit: 20 }).catch(() => null);
  const alreadyPosted = recent?.find(
    m => m.author.id === client.user.id && m.embeds?.[0]?.title === "Rift Studios Rules"
  );

  if (alreadyPosted) return;

  await rulesChannel.send({
    embeds: [
      makeEmbed(
        "Rift Studios Rules",
        config.rules.map((rule, i) => `**${i + 1}.** ${rule}`).join("\n"),
        "warn"
      )
    ]
  }).catch(() => {});
}

function loadInviteCountsFromState() {
  const s = state();
  const out = new Map();
  for (const [key, value] of (s.inviteCounts || [])) {
    out.set(String(key), Number(value) || 0);
  }
  return out;
}

function saveInviteCountsToState(map) {
  const s = state();
  s.inviteCounts = [...map.entries()];
  saveState(s);
}

function incrementInviteStat(guildId, inviterId, amount = 1) {
  if (!guildId || !inviterId) return;
  const key = `${guildId}:${inviterId}`;
  const next = (Number(memberInviteStats.get(key)) || 0) + Math.max(0, Number(amount) || 0);
  memberInviteStats.set(key, next);
  saveInviteCountsToState(memberInviteStats);
}

async function syncInviteStatsFromGuild(guild, options = {}) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return false;

  const overwrite = options.overwrite === true;
  const perUser = new Map();
  for (const inv of invites.values()) {
    const inviterId = inv.inviter?.id;
    if (!inviterId) continue;
    const uses = Number(inv.uses || 0);
    perUser.set(inviterId, (perUser.get(inviterId) || 0) + uses);
  }

  let changed = false;
  for (const [inviterId, uses] of perUser.entries()) {
    const key = `${guild.id}:${inviterId}`;
    const current = Number(memberInviteStats.get(key)) || 0;
    const next = overwrite ? uses : Math.max(current, uses);
    if (next !== current) {
      memberInviteStats.set(key, next);
      changed = true;
    }
  }
  if (changed) saveInviteCountsToState(memberInviteStats);
  inviteCache.set(guild.id, new Map(invites.map(inv => [inv.code, Number(inv.uses || 0)])));
  return true;
}

function buildInviteLeaderboard(guildId, limit = 10) {
  const rows = [];
  const prefix = `${guildId}:`;
  for (const [key, value] of memberInviteStats.entries()) {
    if (!String(key).startsWith(prefix)) continue;
    const inviterId = String(key).slice(prefix.length);
    rows.push({ inviterId, count: Number(value) || 0 });
  }
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, Math.max(1, Math.min(25, limit)));
}

function getGiveawayEntryPool(giveaway, guild, options = {}) {
  const excluded = new Set((options.excludeUserIds || []).map(String));
  const pool = [];

  const explicitCounts = giveaway?.entryCounts && typeof giveaway.entryCounts === "object"
    ? giveaway.entryCounts
    : null;
  if (explicitCounts && Object.keys(explicitCounts).length) {
    for (const [userIdRaw, countRaw] of Object.entries(explicitCounts)) {
      const userId = String(userIdRaw || "");
      if (!userId || excluded.has(userId)) continue;
      const count = Math.max(1, Number(countRaw) || 1);
      for (let i = 0; i < count; i += 1) pool.push(userId);
    }
    return pool;
  }

  for (const userIdRaw of giveaway.entries || []) {
    const userId = String(userIdRaw || "");
    if (!userId || excluded.has(userId)) continue;
    let weight = 1;
    const member = guild?.members?.cache?.get(userId);
    for (const bonus of giveaway.bonusEntries || []) {
      if (member?.roles?.cache?.has(bonus.roleId)) {
        weight += Math.max(0, Number(bonus.entries) || 0);
      }
    }
    for (let i = 0; i < weight; i += 1) pool.push(userId);
  }
  return pool;
}

function pickGiveawayWinners(giveaway, guild, options = {}) {
  const pool = getGiveawayEntryPool(giveaway, guild, options);
  const mutablePool = [...pool];
  const winnerCount = Math.max(1, Number(giveaway.winners) || 1);
  const winners = [];

  while (mutablePool.length && winners.length < winnerCount) {
    const idx = Math.floor(Math.random() * mutablePool.length);
    const picked = mutablePool[idx];
    winners.push(picked);
    for (let i = mutablePool.length - 1; i >= 0; i -= 1) {
      if (mutablePool[i] === picked) mutablePool.splice(i, 1);
    }
  }

  return winners;
}

async function notifyGiveawayWinners(guild, giveaway, winnerIds, options = {}) {
  const uniqueIds = [...new Set((winnerIds || []).map(String).filter(Boolean))];
  if (!uniqueIds.length) return { sent: 0, failed: 0, failedUserIds: [] };

  const results = [];
  const channelMention = giveaway?.channelId ? `<#${giveaway.channelId}>` : "the server";
  for (const userId of uniqueIds) {
    try {
      const user = await client.users.fetch(userId);
      await user.send({
        embeds: [makeEmbed(
          "You Won a Giveaway",
          `You won **${giveaway.prize}** in **${guild.name}**.\nLocation: ${channelMention}`,
          "success",
          [
            { name: "Server", value: guild.name, inline: true },
            { name: "Prize", value: giveaway.prize, inline: true },
            { name: "Type", value: options.source === "reroll" ? "Reroll Winner" : "Giveaway Winner", inline: true }
          ]
        )]
      });
      results.push({ userId, ok: true });
    } catch {
      results.push({ userId, ok: false });
    }
  }

  const sent = results.filter(x => x.ok).length;
  const failedUserIds = results.filter(x => !x.ok).map(x => x.userId);
  const failed = failedUserIds.length;

  giveaway.winnerDmHistory = giveaway.winnerDmHistory || [];
  giveaway.winnerDmHistory.push({
    at: Date.now(),
    source: options.source || "end",
    actorId: options.actorId || null,
    winnerIds: uniqueIds,
    sent,
    failed,
    failedUserIds
  });

  return { sent, failed, failedUserIds };
}

async function endGiveaway(messageId) {
  const giveaways = loadGiveaways();
  const giveaway = giveaways.find(g => g.messageId === messageId);
  if (!giveaway || giveaway.ended) return;

  if (giveawayTimers.has(messageId)) {
    clearTimeout(giveawayTimers.get(messageId));
    giveawayTimers.delete(messageId);
  }
  giveaway.ended = true;
  giveaway.endedAt = Date.now();
  giveaway.endReason = giveaway.endReason || "completed";

  const guild = client.guilds.cache.get(giveaway.guildId);
  const winners = guild ? pickGiveawayWinners(giveaway, guild) : [];
  giveaway.winnerId = winners[0] || null;
  giveaway.winnerIds = winners;

  saveGiveaways(giveaways);

  if (!guild) return;
  const channel = guild.channels.cache.get(giveaway.channelId);
  const winnerText = winners.length ? winners.map(id => `<@${id}>`).join(", ") : "No one entered.";

  if (channel) {
    const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (msg) {
      await msg.edit({
        embeds: [makeEmbed("Giveaway Ended", `**Prize:** ${giveaway.prize}\n**Winner(s):** ${winnerText}`, "success")],
        components: []
      }).catch(() => {});
    }

    await channel.send({
      embeds: [makeEmbed("Giveaway Finished", `**Prize:** ${giveaway.prize}\n**Winner(s):** ${winnerText}`, "success") ]
    }).catch(() => {});
  }

  const dmStatus = await notifyGiveawayWinners(guild, giveaway, winners, {
    source: "end",
    actorId: giveaway.hostId || null
  }).catch(() => ({ sent: 0, failed: winners.length || 0, failedUserIds: winners || [] }));
  saveGiveaways(giveaways);

  await sendLog(guild, "Giveaway Ended", `Giveaway ended in ${channel || "unknown channel"}.`, "info", [
    { name: "Prize", value: giveaway.prize, inline: true },
    { name: "Winner(s)", value: winnerText, inline: true },
    { name: "Entries", value: String((giveaway.entries || []).length), inline: true },
    { name: "Winner DMs", value: `Sent ${dmStatus.sent}, Failed ${dmStatus.failed}`, inline: true }
  ]);

  if (dmStatus.failed) {
    await sendTypedLog(guild, "moderation", "Giveaway Winner DM Failed", `${dmStatus.failed} giveaway winner DM(s) failed.`, "warn", [
      { name: "Giveaway", value: giveaway.messageId, inline: true },
      { name: "Failed IDs", value: dmStatus.failedUserIds.map(id => `<@${id}>`).join(", ").slice(0, 1000) || "n/a" }
    ]);
  }
}
function scheduleGiveaway(giveaway) {
  const delay = Math.max(0, giveaway.endsAt - Date.now());
  if (giveawayTimers.has(giveaway.messageId)) {
    clearTimeout(giveawayTimers.get(giveaway.messageId));
  }
  const timer = setTimeout(async () => {
    await endGiveaway(giveaway.messageId);
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
  giveawayTimers.set(giveaway.messageId, timer);
}

function isTrustedAntiNukeActor(guild, member, settings) {
  if (!member) return true;
  if (member.id === guild.ownerId) return true;
  if (member.user?.bot) return settings.trustedUserIds.includes(member.id);
  if (settings.trustedUserIds.includes(member.id)) return true;
  return false;
}

function getProtectedRoleNameSet(settings = null) {
  const antinukeSettings = settings || getAntiNukeSettings();
  return new Set(["founder", ...(antinukeSettings.protectedRoles || []).map(name => String(name || "").toLowerCase())]);
}

function isProtectedRoleName(name, settings = null) {
  return getProtectedRoleNameSet(settings).has(String(name || "").toLowerCase());
}

function memberHasProtectedRole(member, settings = null) {
  if (!member?.roles?.cache?.size) return false;
  const protectedNames = getProtectedRoleNameSet(settings);
  for (const role of member.roles.cache.values()) {
    if (protectedNames.has(String(role.name || "").toLowerCase())) return true;
  }
  return false;
}

function getProtectionImmunity(member, guild, settings = null) {
  if (!member) {
    return { immune: true, reason: "missing-member" };
  }

  if (hasAnyRole(member, ["Founder"])) {
    return { immune: true, reason: "founder-role" };
  }
  if (hasAnyRole(member, ["Head Moderator"])) {
    return { immune: true, reason: "head-moderator-role" };
  }

  if (guild && member.id === guild.ownerId) {
    return { immune: true, reason: "guild-owner" };
  }

  if (settings && settings.trustedUserIds?.includes(member.id)) {
    return { immune: true, reason: "trusted-user" };
  }

  return { immune: false, reason: null };
}

function getDangerousPermissionFlags() {
  return [
    PermissionsBitField.Flags.Administrator,
    PermissionsBitField.Flags.ManageGuild,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.BanMembers,
    PermissionsBitField.Flags.KickMembers,
    PermissionsBitField.Flags.ModerateMembers,
    PermissionsBitField.Flags.ManageWebhooks
  ];
}

async function stripDangerousPermsFromMember(member, reason, settings = null) {
  if (!member) return;
  if (memberHasProtectedRole(member, settings)) return;
  const protectedNames = getProtectedRoleNameSet(settings);
  for (const role of member.roles.cache.values()) {
    if (protectedNames.has(String(role.name || "").toLowerCase())) continue;
    if (role.managed || role.id === member.guild.id || !role.editable) continue;
    const perms = new PermissionsBitField(role.permissions.bitfield);
    const before = perms.bitfield;
    perms.remove(...getDangerousPermissionFlags());
    if (perms.bitfield !== before) {
      await role.setPermissions(perms, reason).catch(() => {});
    }
  }
}

function recordAntiNuke(guildId, userId, action, settings) {
  const data = readJson(antinukePath, {});
  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) data[guildId][userId] = { events: [] };

  if (Array.isArray(data[guildId][userId])) {
    data[guildId][userId] = { events: data[guildId][userId] };
  }
  if (!Array.isArray(data[guildId][userId].events)) {
    data[guildId][userId].events = [];
  }

  const now = Date.now();
  const actionCfg = settings.actionThresholds[action] || {};
  const actionWindowMs = actionCfg.windowMs ?? settings.windowMs;
  const actionThreshold = actionCfg.threshold ?? settings.threshold;

  const history = data[guildId][userId].events.filter(x => now - x.time <= Math.max(actionWindowMs, settings.windowMs));
  history.push({ action, time: now });
  data[guildId][userId].events = history;
  writeJson(antinukePath, data);

  const actionCount = history.filter(x => x.action === action && now - x.time <= actionWindowMs).length;
  const globalCount = history.filter(x => now - x.time <= settings.windowMs).length;

  return {
    actionCount,
    globalCount,
    actionThreshold,
    globalThreshold: settings.threshold
  };
}

function getAntiNukePunishmentCooldownRemaining(guildId, userId, settings) {
  const data = readJson(antinukePath, {});
  const record = data?.[guildId]?.[userId];
  const lastPunishmentAt = Number(record?.lastPunishmentAt) || 0;
  if (!lastPunishmentAt) return 0;
  return Math.max(0, (lastPunishmentAt + settings.punishmentCooldownMs) - Date.now());
}

function markAntiNukePunishment(guildId, userId, action) {
  const data = readJson(antinukePath, {});
  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) data[guildId][userId] = { events: [] };
  if (Array.isArray(data[guildId][userId])) {
    data[guildId][userId] = { events: data[guildId][userId] };
  }
  if (!Array.isArray(data[guildId][userId].events)) {
    data[guildId][userId].events = [];
  }
  data[guildId][userId].lastPunishmentAt = Date.now();
  data[guildId][userId].lastPunishmentAction = action;
  writeJson(antinukePath, data);
}

async function antiNukeCheck(guild, executorId, action, extra = {}) {
  if (shouldSkipAntiNukeDuplicate(guild.id, executorId, action, extra.target || "")) return;

  const settings = getAntiNukeSettings();
  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return;
  const immunity = getProtectionImmunity(member, guild, settings);
  if (immunity.immune) {
    await sendTypedLog(guild, "security", "Anti-Nuke Ignored (Immune)", `${member.user.tag} triggered ${action}, but no action was taken due to immunity.`, "info", [
      { name: "Reason", value: immunity.reason, inline: true },
      { name: "Target", value: extra.target || "n/a", inline: true }
    ]);
    governance.appendTimeline({
      guildId: guild.id,
      type: "antinuke-ignored",
      actorId: member.id,
      targetId: extra.targetId || null,
      reason: `${action} ignored due to immunity`,
      details: { immunity: immunity.reason, target: extra.target || null }
    });
    return;
  }
  if (isTrustedAntiNukeActor(guild, member, settings)) return;
  if (!hasStaffRole(member) && !member.permissions.has(PermissionFlagsBits.ManageGuild)) return;

  const counts = recordAntiNuke(guild.id, executorId, action, settings);
  governance.incrementAnalytics(guild.id, "antiNukeAlerts", 1);

  await sendTypedLog(guild, "security", "Anti-Nuke Alert", `Suspicious action detected: ${action}`, "warn", [
    { name: "User", value: member.user.tag, inline: true },
    { name: "Action Count", value: String(counts.actionCount), inline: true },
    { name: "Global Count", value: String(counts.globalCount), inline: true },
    { name: "Target", value: extra.target || "n/a", inline: true }
  ]);

  appendModerationLog({
    type: "antinuke-alert",
    guildId: guild.id,
    userId: member.id,
    action,
    counts,
    target: extra.target || null,
    time: Date.now()
  });

  const shouldPunish = counts.actionCount >= counts.actionThreshold || counts.globalCount >= counts.globalThreshold;
  if (!shouldPunish) return;

  const cooldownRemaining = getAntiNukePunishmentCooldownRemaining(guild.id, member.id, settings);
  if (cooldownRemaining > 0) {
    sendTypedLog(guild, "security", "Anti-Nuke Action Suppressed", `${member.user.tag} hit anti-nuke thresholds, but action was suppressed due to cooldown.`, "warn", [
      { name: "Action", value: action, inline: true },
      { name: "Cooldown Remaining", value: `${Math.ceil(cooldownRemaining / 1000)}s`, inline: true }
    ]);
    appendModerationLog({
      type: "antinuke-action-suppressed",
      guildId: guild.id,
      userId: member.id,
      action,
      counts,
      cooldownRemainingMs: cooldownRemaining,
      time: Date.now()
    });
    governance.appendTimeline({
      guildId: guild.id,
      type: "antinuke-action-suppressed",
      actorId: client.user?.id || "system",
      targetId: member.id,
      reason: `Suppressed duplicate anti-nuke action for ${action}`,
      details: { cooldownRemainingMs: cooldownRemaining }
    });
    return;
  }

  const reason = `Anti-nuke triggered (${action})`;
  if (settings.emergency.stripDangerousPermissions) {
    await stripDangerousPermsFromMember(member, reason, settings);
  }
  if (settings.emergency.timeoutOffender && member.moderatable) {
    await member.timeout(settings.punishmentTimeoutMs, reason).catch(() => {});
  }
  if (settings.emergency.kickOffender && member.kickable) {
    await member.kick(reason).catch(() => {});
  }
  if (settings.emergency.banOffender) {
    await guild.members.ban(member.id, { reason }).catch(() => {});
  }
  if (settings.emergency.panicLockdown) {
    await panicLockdown(guild, "Anti-nuke lockdown triggered").catch(() => {});
  }

  markAntiNukePunishment(guild.id, member.id, action);

  await sendTypedLog(guild, "security", "Anti-Nuke Action", `${member.user.tag} hit anti-nuke thresholds. Emergency response executed.`, "error", [
    { name: "Action", value: action, inline: true },
    { name: "Action Count", value: String(counts.actionCount), inline: true },
    { name: "Global Count", value: String(counts.globalCount), inline: true }
  ]);

  appendModerationLog({
    type: "antinuke-action",
    guildId: guild.id,
    userId: member.id,
    action,
    counts,
    emergency: settings.emergency,
    time: Date.now()
  });
  governance.incrementAnalytics(guild.id, "antiNukeActions", 1);
  addCaseAndTimeline(
    guild.id,
    "antinuke",
    client.user?.id || "system",
    member.id,
    `Anti-nuke response for ${action}`,
    settings.emergency?.timeoutOffender ? settings.punishmentTimeoutMs : null,
    { action, counts, target: extra.target || null }
  );
}

async function cacheInvitesForGuild(guild) {
  await syncInviteStatsFromGuild(guild, { overwrite: false }).catch(() => {});
}

async function checkJoinRaid(member) {
  const antiRaid = currentConfig().automod?.antiRaid || {};
  const enabled = antiRaid.enabled !== false;
  if (!enabled) return;
  const immunity = getProtectionImmunity(member, member.guild);
  if (immunity.immune) {
    await sendTypedLog(member.guild, "security", "Anti-Raid Ignored (Immune)", `${member.user.tag} join event ignored by anti-raid due to immunity.`, "info", [
      { name: "Reason", value: immunity.reason, inline: true }
    ]);
    return;
  }

  const windowMs = antiRaid.windowMs ?? 15000;
  const joinLimit = antiRaid.joinLimit ?? 8;
  const action = antiRaid.action || "log";
  const key = member.guild.id;
  const now = Date.now();
  const timestamps = (joinRaidCache.get(key) || []).filter(t => now - t <= windowMs);
  timestamps.push(now);
  joinRaidCache.set(key, timestamps);

  if (timestamps.length < joinLimit) return;
  governance.incrementAnalytics(member.guild.id, "raidAttempts", 1);

  await sendTypedLog(member.guild, "security", "Anti-Raid Alert", `Join spike detected: ${timestamps.length} joins in ${Math.floor(windowMs / 1000)}s.`, "warn");
  appendModerationLog({
    type: "anti-raid",
    guildId: member.guild.id,
    joinCount: timestamps.length,
    windowMs,
    time: now
  });

  if (action === "lockdown") {
    await panicLockdown(member.guild, "Anti-raid lockdown triggered").catch(() => {});
    await sendTypedLog(member.guild, "security", "Anti-Raid Action", "Panic lockdown triggered by join spike.", "error");
  } else if (action === "slowmode") {
    const chat = getChannelByName(member.guild, config.channels.chat);
    const seconds = antiRaid.slowmodeSeconds ?? 10;
    if (chat?.manageable) {
      await chat.setRateLimitPerUser(seconds).catch(() => {});
      await sendTypedLog(member.guild, "security", "Anti-Raid Action", `Applied ${seconds}s slowmode to ${chat}.`, "warn");
    }
  }

  governance.appendTimeline({
    guildId: member.guild.id,
    type: "anti-raid",
    actorId: client.user?.id || "system",
    targetId: null,
    reason: `Join spike ${timestamps.length} in ${windowMs}ms`,
    details: { action }
  });
}

async function runStreamChecksSafely() {
  if (streamCheckState.running) return;
  streamCheckState.running = true;
  try {
    await checkStreams(client, config, makeEmbed);
  } catch (err) {
    logRuntimeError("stream-check", err);
  } finally {
    streamCheckState.running = false;
  }
}

async function monitorGuildIntegrity(guild) {
  const cfg = currentConfig();
  const missing = [];
  if (!getChannelByName(guild, cfg.channels.logs)) missing.push(cfg.channels.logs);
  if (!getChannelByName(guild, cfg.channels.chat)) missing.push(cfg.channels.chat);
  if (!getChannelByName(guild, cfg.channels.streams)) missing.push(cfg.channels.streams);

  if (missing.length) {
    await sendTypedLog(guild, "security", "Config/Channel Warning", `Missing configured channels: ${missing.join(", ")}`, "warn");
  }
}

async function runMonitorLoop() {
  for (const guild of client.guilds.cache.values()) {
    await monitorGuildIntegrity(guild).catch(err => {
      logRuntimeError(`integrity-monitor guild ${guild.id}`, err);
    });
  }
}

function createScheduledBackupsIfNeeded() {
  const cfg = currentConfig();
  if (!cfg.backup?.schedulerEnabled) return;

  const state = governance.getSchedulerState();
  const intervalMs = Math.max(15 * 60 * 1000, cfg.backup.schedulerIntervalMs || 6 * 60 * 60 * 1000);
  const now = Date.now();
  if (state.nextBackupAt && now < state.nextBackupAt) return;

  const all = loadBackups();
  for (const guild of client.guilds.cache.values()) {
    try {
      const snapshot = createGuildBackupSnapshot(guild, client.user?.id || "system");
      if (!snapshot) {
        console.error(`[backup] scheduled snapshot skipped for guild ${guild.id}: empty snapshot`);
        continue;
      }
      all.unshift(snapshot);
      governance.incrementAnalytics(guild.id, "scheduledBackups", 1);
      governance.appendTimeline({
        guildId: guild.id,
        type: "backup-scheduled",
        actorId: client.user?.id || "system",
        targetId: null,
        reason: `Scheduled backup ${snapshot.id}`,
        details: { backupId: snapshot.id }
      });
    } catch (err) {
      console.error(`[backup] scheduled snapshot failed for guild ${guild.id}:`, err);
      continue;
    }
  }

  const maxStored = Math.max(1, cfg.backup.maxStored || 20);
  const grouped = new Map();
  const kept = [];
  for (const item of all) {
    const count = grouped.get(item.guildId) || 0;
    if (count >= maxStored) continue;
    grouped.set(item.guildId, count + 1);
    kept.push(item);
  }
  saveBackups(kept);
  governance.setSchedulerState({ nextBackupAt: now + intervalMs, lastBackupAt: now });
}

function runScheduledBackupsSafely() {
  try {
    createScheduledBackupsIfNeeded();
  } catch (err) {
    console.error("[backup] scheduler guard caught error:", err);
  }
}

function shouldSkipAntiNukeDuplicate(guildId, executorId, action, target = "") {
  const key = `${guildId}:${executorId}:${action}:${target}`;
  const now = Date.now();
  const last = antiNukeDedupe.get(key) || 0;
  antiNukeDedupe.set(key, now);
  const dedupeWindowMs = getAntiNukeSettings().actionDedupeMs;

  for (const [k, t] of antiNukeDedupe.entries()) {
    if (now - t > Math.max(30000, dedupeWindowMs * 4)) antiNukeDedupe.delete(k);
  }

  return now - last < dedupeWindowMs;
}

function londonNowParts() {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });

  const parts = Object.fromEntries(f.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

const RIDDLE_ANSWERS = {
  "what has keys but can't open locks": ["keyboard", "a keyboard"],
  "what gets wetter the more it dries": ["towel", "a towel"],
  "what has hands but cannot clap": ["clock", "a clock"],
  "the more you take the more you leave behind what am i": ["footsteps", "a footprint", "footprint"],
  "what can travel around the world while staying in one corner": ["stamp", "a stamp", "postage stamp"],
  "what has one eye but cannot see": ["needle", "a needle"],
  "what is full of holes but still holds water": ["sponge", "a sponge"],
  "what comes once in a minute twice in a moment but never in a thousand years": ["the letter m", "letter m", "m"],
  "what has a neck but no head": ["bottle", "a bottle"],
  "what has many teeth but cannot bite": ["comb", "a comb"],
  "what goes up but never comes down": ["your age", "age"],
  "what has one head one foot and four legs": ["bed", "a bed"],
  "what has words but never speaks": ["book", "a book"],
  "what kind of band never plays music": ["rubber band", "a rubber band"],
  "what has cities but no houses forests but no trees and water but no fish": ["map", "a map"],
  "what can you catch but not throw": ["cold", "a cold"],
  "what begins with t ends with t and has t in it": ["teapot", "a teapot"],
  "what belongs to you but other people use it more than you do": ["your name", "name", "my name"],
  "what has an eye but cannot see": ["hurricane", "a hurricane", "storm", "a storm"],
  "what gets bigger the more you take away from it": ["hole", "a hole"],
  "what has 13 hearts but no other organs": ["deck of cards", "a deck of cards", "cards"],
  "what has legs but doesn t walk": ["table", "a table"],
  "what can fill a room but takes up no space": ["light", "sunlight"],
  "what runs but never walks": ["water", "a river", "river"],
  "what breaks yet never falls and what falls yet never breaks": ["day breaks and night falls", "day and night", "day breaks night falls"],
  "what has to be broken before you can use it": ["egg", "an egg"],
  "i am tall when i am young and short when i am old what am i": ["candle", "a candle"],
  "what month of the year has 28 days": ["all of them", "all months", "every month"],
  "what is always in front of you but can t be seen": ["the future", "future"],
  "what can you break even if you never pick it up or touch it": ["a promise", "promise"],
  "what goes up and down but doesn t move": ["stairs", "staircase"],
  "a man who was outside in the rain without an umbrella or hat didn t get a single hair on his head wet why": ["he was bald", "he is bald", "bald"],
  "what can you keep after giving to someone": ["your word", "a promise", "promise"],
  "i shave every day but my beard stays the same what am i": ["barber", "a barber"],
  "you see me once in june twice in november and not at all in may what am i": ["the letter e", "letter e", "e"],
  "what can you hold in your left hand but not in your right": ["your right elbow", "right elbow"],
  "what is black when it s clean and white when it s dirty": ["chalkboard", "blackboard", "a chalkboard"],
  "what can you hear but not touch or see": ["your voice", "voice", "sound", "an echo", "echo"],
  "what invention lets you look right through a wall": ["window", "a window"],
  "what goes through cities and fields but never moves": ["road", "a road"],
  "what has a thumb and four fingers but is not alive": ["glove", "a glove"],
  "what has a head and a tail but no body": ["coin", "a coin"],
  "what kind of room has no doors or windows": ["mushroom", "a mushroom"],
  "what has four wheels and flies": ["garbage truck", "a garbage truck", "trash truck"],
  "what has one eye one horn and gives milk": ["cow", "a cow"],
  "what has lots of eyes but cannot see": ["potato", "a potato"],
  "what has many needles but does not sew": ["pine tree", "a pine tree"],
  "what has many branches but no fruit trunk or leaves": ["bank", "a bank"],
  "what can run but never walks has a mouth but never talks has a head but never weeps has a bed but never sleeps": ["river", "a river"],
  "what can clap without hands": ["thunder", "lightning", "thunderstorm"],
  "what can be cracked made told and played": ["joke", "a joke"],
  "what has no beginning end or middle": ["circle", "a circle", "ring"],
  "what comes down but never goes up": ["rain", "snow", "rain and snow"],
  "what can be as big as an elephant but weighs nothing": ["elephants shadow", "an elephants shadow", "shadow"],
  "what gets sharper the more you use it": ["brain", "your mind", "mind"],
  "what has a ring but no finger": ["phone", "a phone", "telephone"],
  "what has one letter and starts with e and ends with e": ["envelope", "an envelope"],
  "what can be measured but has no length width or height": ["time", "temperature"],
  "what can you serve but never eat": ["tennis ball", "volleyball", "a tennis ball"],
  "what can point in every direction but can t reach the destination by itself": ["compass", "a compass"],
  "what kind of coat is always wet when you put it on": ["coat of paint", "paint"],
  "what can go up a chimney down but can t go down a chimney up": ["umbrella", "an umbrella"],
  "what is easy to lift but hard to throw": ["feather", "a feather"],
  "what has a bottom at the top": ["legs", "your legs"],
  "what has many rings but no fingers": ["telephone", "phone", "tree"],
  "what has only two words but thousands of letters": ["post office", "a post office"],
  "what kind of tree can you carry in your hand": ["palm", "a palm"],
  "what can never be put in a saucepan": ["its lid", "a lid", "the lid"],
  "what starts with a p ends with an e and has thousands of letters": ["post office", "a post office"],
  "what has six faces but does not wear makeup has twenty one eyes but cannot see": ["dice", "a die", "die"],
  "what can be seen in water but never gets wet": ["reflection", "your reflection"],
  "what has no life but can die": ["battery", "a battery"],
  "what has a bank but no money": ["river", "a river"],
  "what comes once in a year twice in a week and never in a day": ["the letter e", "letter e", "e"],
  "what is so fragile that saying its name breaks it": ["silence"],
  "what can you put between 7 and 8 so the result is greater than 7 but less than 8": ["decimal point", "a decimal point", "."],
  "what has one eye but can still cry": ["needle", "a needle"],
  "what can be made of water but if you put it into water it dies": ["ice", "an ice cube", "ice cube"],
  "what can never ask a question but is often answered": ["doorbell", "phone", "telephone"],
  "what can you never eat for breakfast": ["lunch", "dinner"],
  "what can you always find in the middle of nowhere": ["the letter h", "letter h", "h"],
  "what has many stories but no pages": ["building", "a building"],
  "what can jump higher than a building": ["anything", "everything", "a flea"],
  "what has no body and no nose but can still smell": ["wind", "air"],
  "what has no voice but can still tell you everything": ["book", "a book", "library"]
};

function normalizeRiddleText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getRiddleAnswerSet(question) {
  const normalizedQuestion = normalizeRiddleText(question);
  let variants = RIDDLE_ANSWERS[normalizedQuestion] || [];

  if (!variants.length) {
    const fallbackMatchers = [
      { test: q => q.includes("gets wet while drying"), answers: ["towel", "a towel"] },
      { test: q => q.includes("many keys") && q.includes("open"), answers: ["keyboard", "a keyboard"] },
      { test: q => q.includes("face and two hands") || (q.includes("hands") && q.includes("no arms") && q.includes("no legs")), answers: ["clock", "a clock"] },
      { test: q => q.includes("used for sewing") || (q.includes("one eye") && q.includes("sew")), answers: ["needle", "a needle"] },
      { test: q => q.includes("cities but no houses"), answers: ["map", "a map"] },
      { test: q => q.includes("forests but no trees"), answers: ["map", "a map"] },
      { test: q => q.includes("water but no fish"), answers: ["map", "a map"] },
      { test: q => q.includes("many teeth") && q.includes("can t bite"), answers: ["comb", "a comb"] },
      { test: q => q.includes("travel all around the world") && q.includes("corner"), answers: ["stamp", "a stamp", "postage stamp"] },
      { test: q => q.includes("fill a room") && q.includes("no space"), answers: ["light", "sunlight"] }
    ];
    const matched = fallbackMatchers.find(item => item.test(normalizedQuestion));
    if (matched) variants = matched.answers;
  }

  const set = new Set(variants.map(normalizeRiddleText).filter(Boolean));
  return [...set];
}

async function ensureGeniusRole(guild) {
  let role = getRoleByName(guild, "Genius");
  if (role) return role;
  role = await guild.roles.create({
    name: "Genius",
    mentionable: true,
    reason: "Auto-created for riddle streak winner role."
  }).catch(() => null);
  return role;
}

async function handleRiddleGuess(message) {
  const s = state();
  const guildRiddle = s.riddleByGuild?.[message.guild.id];
  if (!guildRiddle || guildRiddle.winnerId) return;

  const normalizedGuess = normalizeRiddleText(message.content);
  if (!normalizedGuess) return;
  const answers = Array.isArray(guildRiddle.answers) ? guildRiddle.answers : [];
  if (!answers.includes(normalizedGuess)) return;

  guildRiddle.winnerId = message.author.id;
  guildRiddle.solvedAt = Date.now();
  if (!s.geniusByGuild) s.geniusByGuild = {};

  const previous = s.geniusByGuild[message.guild.id] || { userId: null, streak: 0 };
  const sameWinner = previous.userId === message.author.id;
  const nextStreak = sameWinner ? (Number(previous.streak) || 0) + 1 : 1;
  s.geniusByGuild[message.guild.id] = {
    userId: message.author.id,
    streak: nextStreak,
    updatedAt: Date.now()
  };
  saveState(s);

  const geniusRole = await ensureGeniusRole(message.guild);
  if (!geniusRole) return;

  if (previous.userId && previous.userId !== message.author.id) {
    const previousMember = await message.guild.members.fetch(previous.userId).catch(() => null);
    if (previousMember?.roles?.cache?.has(geniusRole.id)) {
      await previousMember.roles.remove(geniusRole, "Lost riddle streak").catch(() => {});
    }
  }

  const winnerMember = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (winnerMember && !winnerMember.roles.cache.has(geniusRole.id)) {
    await winnerMember.roles.add(geniusRole, "Won riddle first").catch(() => {});
  }

  const winnerName = winnerMember?.displayName || message.author.username || "Champion";
  const shoutName = String(winnerName).toUpperCase();
  const hypeLines = [
    `WOAH ${shoutName} WON!`,
    `${shoutName} JUST SNIPED THE ANSWER!`,
    `BIG BRAIN ALERT: ${shoutName}!`,
    `${shoutName} CRACKED IT FIRST!`
  ];
  const hype = hypeLines[Math.floor(Math.random() * hypeLines.length)];

  await message.channel.send({
    embeds: [
      makeEmbed(
        "Riddle Solved!",
        `${hype}\n${message.author} now holds the **Genius** role.\nCurrent streak: **${nextStreak}**`,
        "success"
      )
    ]
  }).catch(() => {});
}

async function maybePostDailyRiddle() {
  const s = state();
  const now = londonNowParts();
  const intervalMinutes = Math.max(1, Number(config.riddle?.intervalMinutes) || 30);
  const slot = Math.floor(((now.hour * 60) + now.minute) / intervalMinutes);
  const slotKey = `${now.dateKey}:${slot}`;
  if (s.lastRiddleSlot === slotKey) return;

  const candidateRiddles = (config.riddle.riddles || [])
    .map(question => ({ question, answers: getRiddleAnswerSet(question) }))
    .filter(item => item.answers.length > 0);
  if (!candidateRiddles.length) return;

  const picked = candidateRiddles[Math.floor(Math.random() * candidateRiddles.length)];
  const r = picked.question;
  const answers = picked.answers;
  if (!s.riddleByGuild) s.riddleByGuild = {};

  for (const guild of client.guilds.cache.values()) {
    const ch = getChannelByName(guild, config.channels.chat);
    if (!ch) continue;
    const sent = await ch.send({
      embeds: [
        makeEmbed(
          "Riddle Challenge",
          `**Riddle:** ${r}\n\nReply in chat with your guess.`,
          "info"
        )
      ]
    }).catch(() => null);
    s.riddleByGuild[guild.id] = {
      dateKey: now.dateKey,
      slotKey,
      question: r,
      answers,
      winnerId: null,
      solvedAt: null,
      messageId: sent?.id || null,
      channelId: ch.id
    };
  }

  s.lastRiddleDate = now.dateKey;
  s.lastRiddleSlot = slotKey;
  saveState(s);
}

function startRiddleLoop() {
  setInterval(() => {
    maybePostDailyRiddle().catch(() => {});
  }, 60 * 1000);
  maybePostDailyRiddle().catch(() => {});
}

function addWarning(guildId, userId, moderatorTag, reason) {
  const data = loadWarnings();
  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) data[guildId][userId] = [];
  data[guildId][userId].push({
    reason,
    moderatorTag,
    time: Date.now()
  });
  saveWarnings(data);
  return data[guildId][userId].length;
}

function getWarnings(guildId, userId) {
  const data = loadWarnings();
  return data[guildId]?.[userId] || [];
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Data directory: ${dataDir} (source: ${dataDirSource})`);
  console.log("[startup] post-ready startup sequence started");

  try {
    await runStartupTask("restore invite counters from state", async () => {
      const storedInviteCounts = loadInviteCountsFromState();
      for (const [key, value] of storedInviteCounts.entries()) {
        memberInviteStats.set(key, value);
      }
    });

    await runStartupTask("recover giveaways and schedule timers", async () => {
      const giveaways = loadGiveaways();
      let scheduled = 0;
      let recoveredEnded = 0;
      for (const g of giveaways) {
        if (!g.messageId) continue;
        if (g.ended) continue;
        if (typeof g.endsAt === "number" && g.endsAt <= Date.now()) {
          await endGiveaway(g.messageId).catch(() => {});
          recoveredEnded += 1;
          continue;
        }
        scheduleGiveaway(g);
        scheduled += 1;
      }
      console.log(`Giveaway recovery complete. Scheduled: ${scheduled}, ended on startup: ${recoveredEnded}, total records: ${giveaways.length}`);
    });

    await runStartupTask("cache guild invites", async () => {
      const jobs = [];
      for (const guild of client.guilds.cache.values()) {
        jobs.push(cacheInvitesForGuild(guild).catch(err => {
          logRuntimeError(`[startup] cacheInvitesForGuild ${guild.id}`, err);
        }));
      }
      await Promise.all(jobs);
    });

    await runStartupTask("start stream scheduler and initial stream check", async () => {
      const streamIntervalMs = config.social?.checkIntervalMs || 2 * 60 * 1000;
      setInterval(() => runIntervalSafely("stream-check", () => runStreamChecksSafely()), streamIntervalMs);
      await runStreamChecksSafely();
    });

    await runStartupTask("start integrity monitor scheduler and initial pass", async () => {
      const antinukeCfg = currentConfig().antinuke || {};
      const intervalMs = Math.max(15000, antinukeCfg.realtimeMonitorIntervalMs || 45000);
      setInterval(() => runIntervalSafely("integrity-monitor", () => runMonitorLoop()), intervalMs);
      await runMonitorLoop();
    });

    await runStartupTask("start risk decay scheduler", async () => {
      setInterval(() => runIntervalSafely("risk-decay", () => governance.decayRiskAll(1)), 5 * 60 * 1000);
    });

    await runStartupTask("start backup scheduler and initial scheduled backup pass", async () => {
      setInterval(() => runIntervalSafely("scheduled-backups", () => runScheduledBackupsSafely()), 5 * 60 * 1000);
      runScheduledBackupsSafely();
    });

    await runStartupTask("start riddle loop", async () => {
      startRiddleLoop();
    });

    await runStartupTask("start feature scheduler loop", async () => {
      await featureHub.onReady(client, featureContext());
    });
  } catch (err) {
    logRuntimeError("[startup] unexpected failure in startup sequence", err);
  }

  startupCompleted = true;
  console.log("[startup] post-ready startup sequence finished");
});

client.on(Events.GuildMemberAdd, async member => { 
  await checkJoinRaid(member).catch(() => {});
  governance.incrementAnalytics(member.guild.id, "joins", 1);

  const acctAgeMs = Date.now() - member.user.createdTimestamp;
  const youngAccount = acctAgeMs < 3 * 24 * 60 * 60 * 1000;
  const suspiciousName = /(free|nitro|gift|steam|admin|support|mod)/i.test(member.user.username);
  if (youngAccount || suspiciousName) {
    governance.incrementAnalytics(member.guild.id, "raidFingerprints", 1);
    governance.adjustRisk(member.guild.id, member.id, 3, "join-fingerprint");
    await sendTypedLog(member.guild, "security", "Raid Fingerprint", `${member.user.tag} matched suspicious join fingerprint.`, "warn", [
      { name: "Account Age", value: `${Math.floor(acctAgeMs / (60 * 60 * 1000))}h`, inline: true },
      { name: "Username Flag", value: suspiciousName ? "yes" : "no", inline: true }
    ]);
  }

  const role = getRoleByName(member.guild, config.autoRole);
  if (role) {
    await member.roles.add(role).catch(() => {});
  }

  let inviterText = "Unknown";
  let inviterId = null;

  const oldMap = inviteCache.get(member.guild.id) || new Map();
  const newInvites = await member.guild.invites.fetch().catch(() => null);

  if (newInvites) {
    const changed = [];
    for (const inv of newInvites.values()) {
      const before = Number(oldMap.get(inv.code) || 0);
      const after = Number(inv.uses || 0);
      if (after > before) {
        changed.push({
          invite: inv,
          delta: after - before
        });
      }
    }

    changed.sort((a, b) => b.delta - a.delta);
    const used = changed[0]?.invite || null;
    const usedDelta = changed[0]?.delta || 0;

    if (used?.inviter) {
      inviterText = `${used.inviter.tag} (${used.code})`;
      inviterId = used.inviter.id;
      incrementInviteStat(member.guild.id, inviterId, Math.max(1, usedDelta));
    } else {
      await syncInviteStatsFromGuild(member.guild, { overwrite: false }).catch(() => {});
    }

    inviteCache.set(member.guild.id, new Map(newInvites.map(inv => [inv.code, inv.uses || 0])));
  } else {
    await syncInviteStatsFromGuild(member.guild, { overwrite: false }).catch(() => {});
  }

  await sendTypedLog(member.guild, "member", "Member Joined", `${member.user.tag} joined and received the ${config.autoRole} role.`, "success", [
    { name: "Invited By", value: inviterText }
  ]);

  await featureHub.handleMemberAdd(member, featureContext()).catch(err => logRuntimeError("feature-member-add", err));
});

client.on(Events.GuildMemberRemove, async member => {
  const kickEntry = await fetchAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id, 12000);
  if (kickEntry?.executor) {
    await sendTypedLog(member.guild, "member", "Member Kicked", `${member.user.tag} was kicked from the server.`, "error", [
      { name: "Moderator", value: kickEntry.executor.tag, inline: true },
      { name: "Reason", value: kickEntry.reason || "No reason provided", inline: true }
    ]);
  } else {
    await sendTypedLog(member.guild, "member", "Member Left", `${member.user.tag} left the server.`, "warn");
  }

  await featureHub.handleMemberRemove(member, featureContext()).catch(err => logRuntimeError("feature-member-remove", err));
});

client.on(Events.InviteCreate, async invite => {
  if (!invite?.guild || !invite?.code) return;
  const guildMap = inviteCache.get(invite.guild.id) || new Map();
  guildMap.set(invite.code, Number(invite.uses || 0));
  inviteCache.set(invite.guild.id, guildMap);
});

client.on(Events.InviteDelete, async invite => {
  if (!invite?.guild || !invite?.code) return;
  const guildMap = inviteCache.get(invite.guild.id) || new Map();
  guildMap.delete(invite.code);
  inviteCache.set(invite.guild.id, guildMap);
});

client.on(Events.GuildCreate, async guild => {
  await cacheInvitesForGuild(guild).catch(err => logRuntimeError(`cache-invites-guild-create ${guild.id}`, err));
});

client.on(Events.MessageDelete, async message => {
  if (!message.guild || !message.author || message.author.bot) return;
  await featureHub.handleMessageDelete(message, featureContext()).catch(err => logRuntimeError("feature-message-delete", err));
  const snipes = loadSnipes();
  snipes[message.channel.id] = {
    content: message.content || "[embed/attachment]",
    author: message.author.tag,
    time: Date.now()
  };
  saveSnipes(snipes);

  await sendTypedLog(message.guild, "message", "Message Deleted", `A message by ${message.author.tag} was deleted in ${message.channel}.`, "warn", [
    { name: "Author", value: message.author.tag, inline: true },
    { name: "Channel", value: `${message.channel}`, inline: true },
    { name: "Content", value: (message.content || "[embed/attachment]").slice(0, 1000) }
  ]);
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (!newMessage.guild || !newMessage.author || newMessage.author.bot) return;
  const oldContent = oldMessage?.content || "";
  const newContent = newMessage?.content || "";
  if (!oldContent || oldContent === newContent) return;

  await sendTypedLog(newMessage.guild, "message", "Message Edited", `${newMessage.author.tag} edited a message in ${newMessage.channel}.`, "info", [
    { name: "Before", value: oldContent.slice(0, 1000) },
    { name: "After", value: newContent.slice(0, 1000) }
  ]);
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  await featureHub.handleReactionAdd(reaction, user, featureContext()).catch(err => logRuntimeError("feature-reaction-add", err));
});

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;
  if (Date.now() - message.createdTimestamp > 15000) return;
  if (!message.content && !message.attachments?.size) return;
  governance.incrementAnalytics(message.guild.id, "messagesSeen", 1);

  const featureResult = await featureHub.handleMessageCreate(message, featureContext()).catch(err => {
    logRuntimeError("feature-message-create", err);
    return { stop: false };
  });
  if (featureResult?.stop) return;
  await handleRiddleGuess(message).catch(() => {});

  const settings = getAutoModSettings();
  const immunity = getProtectionImmunity(message.member, message.guild);
  if (immunity.immune) {
    const ignoredTrigger = detectAutoModTrigger(message, settings, { recordHistory: false });
    if (ignoredTrigger) {
      await sendTypedLog(message.guild, "moderation", "AutoMod Ignored (Immune)", `${message.author.tag} matched rule ${ignoredTrigger.rule}, but no action was taken due to immunity.`, "info", [
        { name: "Reason", value: immunity.reason, inline: true },
        { name: "Evidence", value: (ignoredTrigger.evidence || "n/a").slice(0, 1000) }
      ]);
    }
    return;
  }
  if (isAutoModBypassed(message, settings)) return;

  const trigger = detectAutoModTrigger(message, settings);
  if (!trigger) return;

  applyAutoModAction(message, trigger).catch(err => logRuntimeError("automod-action", err));
  return;
});

async function fetchAuditEntry(guild, type, targetId = null, maxAgeMs = 30000) {
  const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
  if (!logs?.entries?.size) return null;

  const now = Date.now();
  for (const entry of logs.entries.values()) {
    const created = entry.createdTimestamp || 0;
    if (now - created > maxAgeMs) continue;
    if (targetId && entry.targetId && entry.targetId !== targetId) continue;
    return entry;
  }

  return null;
}

async function fetchExecutor(guild, type, targetId = null, maxAgeMs = 30000) {
  const entry = await fetchAuditEntry(guild, type, targetId, maxAgeMs);
  return entry?.executorId || null;
}

client.on(Events.ChannelDelete, async channel => {
  if (channel.guild) {
    await sendTypedLog(channel.guild, "security", "Channel Deleted", `${channel.name} was deleted.`, "error");
    const executorId = await fetchExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    if (executorId) {
      await antiNukeCheck(channel.guild, executorId, "channelDelete", { target: channel.name });
    } else {
      await sendTypedLog(channel.guild, "security", "Anti-Nuke Notice", "Could not attribute channel delete from audit logs.", "warn");
    }
  }
});

client.on(Events.ChannelCreate, async channel => {
  if (channel.guild) {
    await sendTypedLog(channel.guild, "moderation", "Channel Created", `${channel.name} was created.`, "success");
    const executorId = await fetchExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    if (executorId) {
      await antiNukeCheck(channel.guild, executorId, "channelCreate", { target: channel.name });
    }
  }
});

client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  if (newChannel.guild && oldChannel.name !== newChannel.name) {
    await sendTypedLog(newChannel.guild, "moderation", "Channel Updated", `${oldChannel.name} renamed to ${newChannel.name}.`, "info");
  }
});

client.on(Events.RoleDelete, async role => {
  if (role.guild) {
    await sendTypedLog(role.guild, "security", "Role Deleted", `${role.name} was deleted.`, "error");
    const executorId = await fetchExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
    if (executorId) await antiNukeCheck(role.guild, executorId, "roleDelete", { target: role.name });
  }
});

client.on(Events.RoleCreate, async role => {
  if (role.guild) {
    await sendTypedLog(role.guild, "moderation", "Role Created", `${role.name} was created.`, "success");
    const executorId = await fetchExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
    if (executorId) await antiNukeCheck(role.guild, executorId, "roleCreate", { target: role.name });
  }
});

client.on(Events.RoleUpdate, async (oldRole, newRole) => {
  if (oldRole.name !== newRole.name) {
    await sendTypedLog(newRole.guild, "moderation", "Role Updated", `${oldRole.name} renamed to ${newRole.name}.`, "info");
  }

  const antinukeCfg = getAntiNukeSettings();
  if (isProtectedRoleName(newRole.name, antinukeCfg)) {
    return;
  }

  const before = new PermissionsBitField(oldRole.permissions.bitfield);
  const after = new PermissionsBitField(newRole.permissions.bitfield);
  const dangerous = getDangerousPermissionFlags();
  const escalated = dangerous.some(flag => !before.has(flag) && after.has(flag));
  if (!escalated) return;

  const executorId = await fetchExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
  if (executorId) await antiNukeCheck(newRole.guild, executorId, "rolePermissionEscalation", { target: newRole.name });
});

client.on(Events.WebhooksUpdate, async channel => {
  if (!channel.guild) return;
  await sendTypedLog(channel.guild, "security", "Webhook Update", `Webhook update detected in ${channel.name}.`, "warn");
  const executorCreate = await fetchExecutor(channel.guild, AuditLogEvent.WebhookCreate, null, 20000);
  const executorDelete = await fetchExecutor(channel.guild, AuditLogEvent.WebhookDelete, null, 20000);
  const executorUpdate = await fetchExecutor(channel.guild, AuditLogEvent.WebhookUpdate, null, 20000);
  const executorId = executorCreate || executorDelete || executorUpdate;
  if (executorId) await antiNukeCheck(channel.guild, executorId, "webhookChange", { target: channel.name });
});

client.on(Events.GuildBanAdd, async ban => {
  await sendTypedLog(ban.guild, "member", "Member Banned", `${ban.user.tag} was banned.`, "error");
  const executorId = await fetchExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (executorId) await antiNukeCheck(ban.guild, executorId, "memberBan", { target: ban.user.tag });
});

client.on(Events.GuildAuditLogEntryCreate, async entry => {
  const guild = entry.guild;
  const executorId = entry.executorId;
  if (!guild || !executorId) return;

  let action = null;
  if (entry.action === AuditLogEvent.MemberKick) action = "memberKick";
  if (entry.action === AuditLogEvent.MemberUpdate && entry.changes?.some(c => c.key === "communication_disabled_until")) action = "memberTimeout";
  if (entry.action === AuditLogEvent.MemberPrune) action = "memberPrune";
  if (entry.action === AuditLogEvent.GuildUpdate) action = "guildUpdate";
  if (entry.action === AuditLogEvent.BotAdd) action = "botAdd";
  if (!action) return;

  if (action === "memberKick") {
    await sendTypedLog(guild, "member", "Member Kicked", `Audit log reports a member kick by <@${executorId}>.`, "warn");
  }
  if (action === "memberTimeout") {
    await sendTypedLog(guild, "member", "Member Timed Out", `Audit log reports a timeout by <@${executorId}>.`, "warn");
  }
  if (action === "guildUpdate") {
    await sendTypedLog(guild, "security", "Guild Updated", `Rapid guild setting update detected by <@${executorId}>.`, "warn");
  }
  if (action === "botAdd") {
    await sendTypedLog(guild, "security", "Bot Added", `A bot was added by <@${executorId}>.`, "warn");
  }

  await antiNukeCheck(guild, executorId, action, {
    target: entry.target?.tag || entry.target?.name || entry.targetId || "unknown"
  });
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const beforeTimeout = Number(oldMember.communicationDisabledUntilTimestamp || 0);
  const afterTimeout = Number(newMember.communicationDisabledUntilTimestamp || 0);
  const now = Date.now();
  const hadTimeout = beforeTimeout > now;
  const hasTimeout = afterTimeout > now;
  if (!hadTimeout || hasTimeout) return;

  const recovery = activateAutomodRecovery(newMember.guild, newMember.id, { reason: "timeout-ended" });
  if (!recovery) return;

  const userTag = newMember.user?.tag || newMember.id;
  await sendTypedLog(
    newMember.guild,
    "moderation",
    "AutoMod Recovery Grace",
    `${userTag} timeout ended; stale automod state was reset and grace mode was applied.`,
    "info",
    [
      { name: "Grace", value: `${Math.floor(recovery.graceMs / 1000)}s`, inline: true },
      { name: "Warnings Cleared", value: String(recovery.removedWarnings), inline: true },
      { name: "Risk", value: `${recovery.riskBefore} -> ${recovery.riskAfter}`, inline: true }
    ]
  );
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      const member = interaction.member;

      if (cmd === "registercmds" && interaction.user.id === "965922934801711164") {
        const rest2 = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
        await rest2.put(
          Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
          { body: commands }
        );
        await interaction.reply({ content: "Commands registered!", ephemeral: true });
        return;
      }

      if (cmd === "ping") {
        await interaction.reply({ embeds: [makeEmbed("Pong!", "The bot is online.", "success")] });
        return;
      }

      if (cmd === "allcommands") {
        if (!hasStaffRole(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }

        await interaction.reply({
          embeds: [makeEmbed("All Commands", commands.map(c => `/${c.name}`).join("\n"), "info")],
          ephemeral: true
        });
        return;
      }

      if (await featureHub.handleCommand(interaction, featureContext())) {
        return;
      }

      if (cmd === "setup-support-panel") {
        await interaction.deferReply({ ephemeral: true });

        await interaction.channel.send({
          embeds: [makeEmbed("Support Tickets", "Click below to open a private support ticket.", "info")],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("open_support_ticket")
                .setLabel("Open Support Ticket")
                .setStyle(ButtonStyle.Primary)
            )
          ]
        });

        await interaction.editReply({ embeds: [makeEmbed("Done", "Support panel posted.", "success")] });
        return;
      }

      if (cmd === "setup-application-panel") {
        await interaction.deferReply({ ephemeral: true });

        await interaction.channel.send({
          embeds: [makeEmbed("Staff Applications", "Click below to open a private application ticket.", "info")],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("open_application_ticket")
                .setLabel("Apply For Staff")
                .setStyle(ButtonStyle.Secondary)
            )
          ]
        });

        await interaction.editReply({ embeds: [makeEmbed("Done", "Application panel posted.", "success")] });
        return;
      }

      if (cmd === "close") {
        if (!canManageTicketsCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only staff can close tickets.", "error")], ephemeral: true });
          return;
        }
        if (!isTicketChannel(interaction.channel)) {
          await interaction.reply({ embeds: [makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
          return;
        }

        const reason = interaction.options.getString("reason") || "Closed via /close";
        const messages = await interaction.channel.messages.fetch({ limit: 200 }).catch(() => null);
        const orderedMessages = [...(messages?.values() || [])].reverse();
        await sendTranscript(interaction.guild, interaction.channel, orderedMessages, {
          ticketOwnerId: parseTicketOwnerId(interaction.channel),
          closedBy: interaction.user.id,
          closeReason: reason,
          messageCount: orderedMessages.length
        });

        await interaction.reply({ embeds: [makeEmbed("Closing Ticket", `Reason: ${reason}\nThis ticket will be deleted in 5 seconds.`, "warn")] });
        await sendTypedLog(interaction.guild, "moderation", "Ticket Closed", `${interaction.user.tag} closed ${interaction.channel.name}.`, "warn", [
          { name: "Reason", value: reason }
        ]);

        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
        return;
      }

      if (cmd === "timeout") {
        if (!canUseBasicModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Trial Moderator or higher can use this.", "error")], ephemeral: true });
          return;
        }

        const user = interaction.options.getUser("user");
        const duration = interaction.options.getString("duration");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        const durationMs = ms(duration);

        if (!target || !durationMs) {
          await interaction.reply({ embeds: [makeEmbed("Error", "Invalid user or duration.", "error")], ephemeral: true });
          return;
        }

        await target.timeout(durationMs, reason);
        await interaction.reply({ embeds: [makeEmbed("Timed Out", `${user.tag} has been timed out.`, "warn")] });

        await sendTypedLog(interaction.guild, "member", "Member Timed Out", `${interaction.user.tag} timed out ${user.tag}.`, "warn", [
          { name: "Duration", value: duration, inline: true },
          { name: "Reason", value: reason, inline: true }
        ]);
        await sendTypedLog(interaction.guild, "moderation", "Timeout Action", `${interaction.user.tag} timed out ${user.tag}.`, "warn", [
          { name: "Duration", value: duration, inline: true },
          { name: "Reason", value: reason, inline: true }
        ]);
        const c = addCaseAndTimeline(interaction.guild.id, "timeout", interaction.user.id, user.id, reason, durationMs, { duration });
        governance.incrementAnalytics(interaction.guild.id, "manualTimeouts", 1);
        await interaction.followUp({ embeds: [makeEmbed("Case Recorded", `Case ID: \`${c.caseId}\``, "info")], ephemeral: true }).catch(() => {});
        return;
      }

      if (cmd === "untimeout") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }

        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);

        if (!target) {
          await interaction.reply({ embeds: [makeEmbed("Error", "User not found.", "error")], ephemeral: true });
          return;
        }

        await target.timeout(null, reason);
        await interaction.reply({ embeds: [makeEmbed("Timeout Removed", `${user.tag}'s timeout was removed.`, "success")] });

        const recovery = activateAutomodRecovery(interaction.guild, user.id, {
          reason: `manual-untimeout:${reason}`,
          actorId: interaction.user.id
        });
        if (recovery) {
          await sendTypedLog(interaction.guild, "moderation", "AutoMod Recovery Reset", `${interaction.user.tag} reset automod state for ${user.tag} after untimeout.`, "info", [
            { name: "Grace", value: `${Math.floor(recovery.graceMs / 1000)}s`, inline: true },
            { name: "Warnings Cleared", value: String(recovery.removedWarnings), inline: true },
            { name: "Risk", value: `${recovery.riskBefore} -> ${recovery.riskAfter}`, inline: true }
          ]);
        }

        await sendTypedLog(interaction.guild, "member", "Timeout Removed", `${interaction.user.tag} removed ${user.tag}'s timeout.`, "success", [
          { name: "Reason", value: reason }
        ]);
        addCaseAndTimeline(interaction.guild.id, "untimeout", interaction.user.id, user.id, reason, null, {});
        return;
      }

      if (cmd === "clearautomod") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }

        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) {
          await interaction.reply({ embeds: [makeEmbed("Error", "User not found.", "error")], ephemeral: true });
          return;
        }

        const recovery = activateAutomodRecovery(interaction.guild, user.id, {
          reason: `manual-clearautomod:${reason}`,
          actorId: interaction.user.id,
          dedupeWindowMs: 1500
        });
        if (!recovery) {
          await interaction.reply({ embeds: [makeEmbed("Skipped", "AutoMod reset was already applied moments ago.", "info")], ephemeral: true });
          return;
        }

        await interaction.reply({
          embeds: [
            makeEmbed(
              "AutoMod State Reset",
              `${user.tag} automod carryover was cleared.\nGrace: **${Math.floor(recovery.graceMs / 1000)}s**\nWarnings cleared: **${recovery.removedWarnings}**\nRisk: **${recovery.riskBefore} -> ${recovery.riskAfter}**`,
              "success"
            )
          ]
        });

        await sendTypedLog(interaction.guild, "moderation", "AutoMod State Reset", `${interaction.user.tag} reset automod state for ${user.tag}.`, "info", [
          { name: "Reason", value: reason },
          { name: "Grace", value: `${Math.floor(recovery.graceMs / 1000)}s`, inline: true },
          { name: "Warnings Cleared", value: String(recovery.removedWarnings), inline: true },
          { name: "Risk", value: `${recovery.riskBefore} -> ${recovery.riskAfter}`, inline: true }
        ]);

        addCaseAndTimeline(interaction.guild.id, "automod-reset", interaction.user.id, user.id, reason, null, {
          graceMs: recovery.graceMs,
          warningsCleared: recovery.removedWarnings,
          riskBefore: recovery.riskBefore,
          riskAfter: recovery.riskAfter
        });
        return;
      }

      if (cmd === "ban") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || "No reason provided";

        await interaction.guild.members.ban(user.id, { reason });

        await interaction.reply({ embeds: [makeEmbed("Member Banned", `${user.tag} has been banned.`, "error")] });
        await sendTypedLog(interaction.guild, "member", "Member Banned", `${interaction.user.tag} banned ${user.tag}.`, "error", [
          { name: "Reason", value: reason }
        ]);
        const c = addCaseAndTimeline(interaction.guild.id, "ban", interaction.user.id, user.id, reason, null, {});
        governance.incrementAnalytics(interaction.guild.id, "manualBans", 1);
        await interaction.followUp({ embeds: [makeEmbed("Case Recorded", `Case ID: \`${c.caseId}\``, "info")], ephemeral: true }).catch(() => {});
        return;
      }

      if (cmd === "kick") {
        if (!canUseBasicModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Trial Moderator or higher can use this.", "error")], ephemeral: true });
          return;
        }
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);

        if (!target) {
          await interaction.reply({ embeds: [makeEmbed("Error", "User not found.", "error")], ephemeral: true });
          return;
        }

        await target.kick(reason);

        await interaction.reply({ embeds: [makeEmbed("Member Kicked", `${user.tag} has been kicked.`, "warn")] });
        await sendTypedLog(interaction.guild, "member", "Member Kicked", `${interaction.user.tag} kicked ${user.tag}.`, "warn", [
          { name: "Reason", value: reason }
        ]);
        await sendTypedLog(interaction.guild, "moderation", "Kick Action", `${interaction.user.tag} kicked ${user.tag}.`, "warn", [
          { name: "Reason", value: reason }
        ]);
        const c = addCaseAndTimeline(interaction.guild.id, "kick", interaction.user.id, user.id, reason, null, {});
        governance.incrementAnalytics(interaction.guild.id, "manualKicks", 1);
        await interaction.followUp({ embeds: [makeEmbed("Case Recorded", `Case ID: \`${c.caseId}\``, "info")], ephemeral: true }).catch(() => {});
        return;
      }

      if (cmd === "purge") {
        const amount = interaction.options.getInteger("amount");

        if (amount < 1 || amount > 100) {
          await interaction.reply({ embeds: [makeEmbed("Invalid Amount", "Pick a number from 1 to 100.", "error")], ephemeral: true });
          return;
        }

        const deleted = await interaction.channel.bulkDelete(amount, true);

        await interaction.reply({ embeds: [makeEmbed("Messages Deleted", `Deleted ${deleted.size} messages.`, "success")], ephemeral: true });
        await sendTypedLog(interaction.guild, "moderation", "Messages Purged", `${interaction.user.tag} purged messages in ${interaction.channel}.`, "warn", [
          { name: "Deleted", value: String(deleted.size) }
        ]);
        return;
      }

      if (cmd === "lock") {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });

        await interaction.reply({ embeds: [makeEmbed("Channel Locked", `${interaction.channel} has been locked.`, "warn")] });
        await sendTypedLog(interaction.guild, "moderation", "Channel Locked", `${interaction.user.tag} locked ${interaction.channel}.`, "warn");
        return;
      }

      if (cmd === "unlock") {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: true });

        await interaction.reply({ embeds: [makeEmbed("Channel Unlocked", `${interaction.channel} has been unlocked.`, "success")] });
        await sendTypedLog(interaction.guild, "moderation", "Channel Unlocked", `${interaction.user.tag} unlocked ${interaction.channel}.`, "success");
        return;
      }

      if (cmd === "slowmode") {
        const seconds = interaction.options.getInteger("seconds");

        if (seconds < 0 || seconds > 21600) {
          await interaction.reply({ embeds: [makeEmbed("Error", "Slowmode must be from 0 to 21600 seconds.", "error")], ephemeral: true });
          return;
        }

        await interaction.channel.setRateLimitPerUser(seconds);

        await interaction.reply({ embeds: [makeEmbed("Slowmode Updated", `Slowmode set to ${seconds} seconds.`, "success")] });
        return;
      }

      if (cmd === "warn") {
        if (!canUseBasicModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Trial Moderator or higher can use this.", "error")], ephemeral: true });
          return;
        }

        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");

        const count = addWarning(interaction.guild.id, user.id, interaction.user.tag, reason);

        await interaction.reply({
          embeds: [makeEmbed("Member Warned", `${user.tag} has been warned.`, "warn", [
            { name: "Reason", value: reason },
            { name: "Total Warnings", value: String(count) }
          ])]
        });

        await sendTypedLog(interaction.guild, "moderation", "Member Warned", `${interaction.user.tag} warned ${user.tag}.`, "warn", [
          { name: "Reason", value: reason },
          { name: "Total Warnings", value: String(count) }
        ]);
        const c = addCaseAndTimeline(interaction.guild.id, "warn", interaction.user.id, user.id, reason, null, { warnings: count });
        await interaction.followUp({ embeds: [makeEmbed("Case Recorded", `Case ID: \`${c.caseId}\``, "info")], ephemeral: true }).catch(() => {});
        return;
      }

      if (cmd === "warnings") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }

        const user = interaction.options.getUser("user");
        const warnings = getWarnings(interaction.guild.id, user.id);
        const description = warnings.length
          ? warnings.map((w, i) => `**${i + 1}.** ${w.reason} — ${w.moderatorTag}`).join("\n").slice(0, 4000)
          : "No warnings.";

        await interaction.reply({ embeds: [makeEmbed(`Warnings for ${user.tag}`, description, "info")], ephemeral: true });
        return;
      }

      if (cmd === "invites") {
        await syncInviteStatsFromGuild(interaction.guild, { overwrite: false }).catch(() => {});
        const user = interaction.options.getUser("user") || interaction.user;
        const key = `${interaction.guild.id}:${user.id}`;
        const count = Number(memberInviteStats.get(key)) || 0;

        await interaction.reply({
          embeds: [makeEmbed("Invite Count", `**${user.tag}** has **${count}** tracked invite${count === 1 ? "" : "s"}.`, "info")]
        });
        return;
      }

      if (cmd === "inviteleaderboard") {
        await syncInviteStatsFromGuild(interaction.guild, { overwrite: false }).catch(() => {});
        const top = buildInviteLeaderboard(interaction.guild.id, 10);
        const text = top.length
          ? top.map((row, idx) => `**#${idx + 1}** <@${row.inviterId}> - **${row.count}** invite${row.count === 1 ? "" : "s"}`).join("\n")
          : "No invite data yet.";

        await interaction.reply({
          embeds: [makeEmbed("Invite Leaderboard", text, "info")]
        });
        return;
      }

      if (cmd === "case") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const caseId = interaction.options.getString("caseid");
        const c = governance.getCase(interaction.guild.id, caseId);
        if (!c) {
          await interaction.reply({ embeds: [makeEmbed("Not Found", "Case not found.", "error")], ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [makeEmbed(`Case ${c.caseId}`, `Type: **${c.type}**\nModerator: <@${c.moderatorId}>\nTarget: ${c.targetId ? `<@${c.targetId}>` : "n/a"}\nReason: ${c.reason}\nWhen: <t:${Math.floor(c.timestamp / 1000)}:F>`, "info")]
        });
        return;
      }

      if (cmd === "cases") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const user = interaction.options.getUser("user");
        const limit = Math.min(20, Math.max(1, interaction.options.getInteger("limit") || 10));
        const items = governance.getCasesForUser(interaction.guild.id, user.id, limit);
        const text = items.length ? items.map(formatCaseLine).join("\n") : "No cases found.";
        await interaction.reply({ embeds: [makeEmbed(`Cases for ${user.tag}`, text.slice(0, 3900), "info")] });
        return;
      }

      if (cmd === "history") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const user = interaction.options.getUser("user");
        const h = getUserHistorySummary(interaction.guild.id, user.id);
        const summary = [
          `Warnings: **${h.warnings.length}**`,
          `Cases: **${h.cases.length}**`,
          `AutoMod Hits: **${h.automodHits}**`,
          `Anti-Nuke Events: **${h.antiNukeHits}**`,
          `Risk Score: **${governance.getRisk(interaction.guild.id, user.id)}**`
        ].join("\n");
        const latest = h.timeline.slice(0, 8).map(t => `• ${t.type} • <t:${Math.floor(t.timestamp / 1000)}:R>`).join("\n") || "No timeline entries.";
        await interaction.reply({
          embeds: [makeEmbed(`History for ${user.tag}`, `${summary}\n\n**Recent Timeline**\n${latest}`, "info")]
        });
        return;
      }

      if (cmd === "noteadd") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const user = interaction.options.getUser("user");
        const text = interaction.options.getString("text");
        const note = governance.addNote(interaction.guild.id, user.id, interaction.user.id, text);
        governance.appendTimeline({
          guildId: interaction.guild.id,
          type: "staff-note-add",
          actorId: interaction.user.id,
          targetId: user.id,
          reason: text,
          details: { noteId: note.id }
        });
        await interaction.reply({ embeds: [makeEmbed("Note Added", `Note ID: \`${note.id}\``, "success")], ephemeral: true });
        return;
      }

      if (cmd === "notes") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const user = interaction.options.getUser("user");
        const notes = governance.getNotes(interaction.guild.id, user.id);
        const text = notes.length
          ? notes.slice(-20).reverse().map(n => `• \`${n.id}\` • <@${n.moderatorId}> • <t:${Math.floor(n.timestamp / 1000)}:R>\n${n.text}`).join("\n\n")
          : "No notes.";
        await interaction.reply({ embeds: [makeEmbed(`Notes for ${user.tag}`, text.slice(0, 3900), "info")], ephemeral: true });
        return;
      }

      if (cmd === "noteremove") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const user = interaction.options.getUser("user");
        const noteId = interaction.options.getString("noteid");
        const ok = governance.removeNote(interaction.guild.id, user.id, noteId);
        if (!ok) {
          await interaction.reply({ embeds: [makeEmbed("Not Found", "Note not found.", "error")], ephemeral: true });
          return;
        }
        governance.appendTimeline({
          guildId: interaction.guild.id,
          type: "staff-note-remove",
          actorId: interaction.user.id,
          targetId: user.id,
          reason: `Removed note ${noteId}`
        });
        await interaction.reply({ embeds: [makeEmbed("Note Removed", `Removed \`${noteId}\`.`, "success")], ephemeral: true });
        return;
      }

      if (cmd === "configview") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const group = interaction.options.getString("group");
        const data = governance.getRuntimeConfigGroup(group);
        await interaction.reply({
          embeds: [makeEmbed(`Runtime Config: ${group}`, `\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 3600)}\n\`\`\``, "info")],
          ephemeral: true
        });
        return;
      }

      if (cmd === "configset") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const group = interaction.options.getString("group");
        const key = interaction.options.getString("key");
        const valueRaw = interaction.options.getString("value");
        const value = parseConfigValue(valueRaw);
        governance.setRuntimeConfigValue(group, key, value);
        governance.appendTimeline({
          guildId: interaction.guild.id,
          type: "config-set",
          actorId: interaction.user.id,
          targetId: null,
          reason: `${group}.${key} updated`,
          details: { value }
        });
        await interaction.reply({ embeds: [makeEmbed("Config Updated", `${group}.${key} set successfully.`, "success")], ephemeral: true });
        return;
      }

      if (cmd === "stats") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const scope = String(interaction.options.getString("scope") || "overview").toLowerCase();
        const a = governance.getAnalytics(interaction.guild.id);
        const rows = Object.entries(a)
          .filter(([k]) => !k.endsWith("At"))
          .filter(([k]) => scope === "overview" ? true : k.toLowerCase().includes(scope))
          .sort((a1, b1) => String(a1[0]).localeCompare(String(b1[0])));
        const text = rows.length ? rows.map(([k, v]) => `• ${k}: **${v}**`).join("\n") : "No analytics yet.";
        await interaction.reply({ embeds: [makeEmbed("Analytics", text.slice(0, 3900), "info")] });
        return;
      }

      if (cmd === "risk") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const user = interaction.options.getUser("user");
        const score = governance.getRisk(interaction.guild.id, user.id);
        await interaction.reply({ embeds: [makeEmbed(`Risk: ${user.tag}`, `Current risk score: **${score}/100**`, score >= 70 ? "error" : score >= 40 ? "warn" : "success")] });
        return;
      }

      if (cmd === "timeline") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const user = interaction.options.getUser("user");
        const limit = Math.min(30, Math.max(1, interaction.options.getInteger("limit") || 15));
        const items = governance.getTimeline(interaction.guild.id, { userId: user?.id || null, limit });
        const text = items.length
          ? items.map(t => `• ${t.type} • <t:${Math.floor(t.timestamp / 1000)}:R> • ${t.reason || "n/a"}`).join("\n")
          : "No timeline entries.";
        await interaction.reply({ embeds: [makeEmbed("Audit Timeline", text.slice(0, 3900), "info")] });
        return;
      }

      if (cmd === "purgeplus") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const mode = String(interaction.options.getString("mode") || "").toLowerCase();
        const limit = interaction.options.getInteger("limit");
        const user = interaction.options.getUser("user");
        const keyword = interaction.options.getString("keyword");
        const minutes = interaction.options.getInteger("minutes");

        if (!["all", "user", "keyword", "links", "attachments"].includes(mode)) {
          await interaction.reply({ embeds: [makeEmbed("Invalid Mode", "Use all/user/keyword/links/attachments.", "error")], ephemeral: true });
          return;
        }
        if (mode === "user" && !user) {
          await interaction.reply({ embeds: [makeEmbed("Missing User", "Provide `user` when mode is user.", "error")], ephemeral: true });
          return;
        }
        if (mode === "keyword" && !keyword) {
          await interaction.reply({ embeds: [makeEmbed("Missing Keyword", "Provide `keyword` when mode is keyword.", "error")], ephemeral: true });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        const result = await runAdvancedPurge(interaction.channel, {
          mode,
          limit,
          userId: user?.id || null,
          keyword,
          minutes
        });

        governance.incrementAnalytics(interaction.guild.id, "advancedPurges", 1);
        governance.appendTimeline({
          guildId: interaction.guild.id,
          type: "purgeplus",
          actorId: interaction.user.id,
          targetId: user?.id || null,
          reason: `mode=${mode}`,
          details: result
        });
        await interaction.editReply({
          embeds: [makeEmbed("Advanced Purge Complete", `Scanned: **${result.scanned}**\nMatched: **${result.matched}**\nDeleted: **${result.deleted}**`, "success")]
        });
        return;
      }

      if (cmd === "lockdown") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }
        const mode = String(interaction.options.getString("mode") || "").toLowerCase();
        const confirm = interaction.options.getBoolean("confirm") === true;
        if (!["on", "off", "panic"].includes(mode)) {
          await interaction.reply({ embeds: [makeEmbed("Invalid Mode", "Use mode on/off/panic.", "error")], ephemeral: true });
          return;
        }
        if (!confirm) {
          await interaction.reply({ embeds: [makeEmbed("Confirmation Required", "Set `confirm=true` to run lockdown action.", "warn")], ephemeral: true });
          return;
        }

        if (mode === "on" || mode === "panic") {
          const state = { mode, setBy: interaction.user.id, setAt: Date.now(), channels: [] };
          for (const ch of interaction.guild.channels.cache.values()) {
            if (!ch.isTextBased?.() && ch.type !== ChannelType.GuildText) continue;
            const before = ch.permissionOverwrites.cache.get(interaction.guild.id);
            state.channels.push({
              id: ch.id,
              allow: before?.allow?.bitfield?.toString?.() || "0",
              deny: before?.deny?.bitfield?.toString?.() || "0"
            });
            await ch.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false }).catch(() => {});
          }
          if (mode === "panic") {
            await panicLockdown(interaction.guild, "Manual panic lockdown").catch(() => {});
          }
          governance.setLockdownState(interaction.guild.id, state);
          governance.appendTimeline({
            guildId: interaction.guild.id,
            type: "lockdown-on",
            actorId: interaction.user.id,
            targetId: null,
            reason: `Lockdown ${mode}`
          });
          await interaction.reply({ embeds: [makeEmbed("Lockdown Enabled", `Mode: **${mode}**`, "warn")] });
          return;
        }

        const existing = governance.getLockdownState(interaction.guild.id);
        if (!existing) {
          await interaction.reply({ embeds: [makeEmbed("No Lockdown State", "No saved lockdown state found.", "warn")], ephemeral: true });
          return;
        }
        for (const item of existing.channels || []) {
          const ch = interaction.guild.channels.cache.get(item.id);
          if (!ch) continue;
          await ch.permissionOverwrites.edit(interaction.guild.id, { SendMessages: null }).catch(() => {});
        }
        governance.clearLockdownState(interaction.guild.id);
        governance.appendTimeline({
          guildId: interaction.guild.id,
          type: "lockdown-off",
          actorId: interaction.user.id,
          targetId: null,
          reason: "Lockdown disabled"
        });
        await interaction.reply({ embeds: [makeEmbed("Lockdown Disabled", "Channel restrictions restored to normal defaults.", "success")] });
        return;
      }

      if (cmd === "backup") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
          return;
        }

        const action = String(interaction.options.getString("action") || "").trim().toLowerCase();
        const backups = loadBackups();

        if (action === "create") {
          const snapshot = createGuildBackupSnapshot(interaction.guild, interaction.user.id);
          backups.unshift(snapshot);
          const maxStored = Math.max(1, currentConfig().backup?.maxStored || 20);
          const scopedCount = backups.filter(b => b.guildId === interaction.guild.id).length;
          if (scopedCount > maxStored) {
            let remaining = maxStored;
            const kept = [];
            for (const item of backups) {
              if (item.guildId === interaction.guild.id) {
                if (remaining > 0) {
                  kept.push(item);
                  remaining -= 1;
                }
                continue;
              }
              kept.push(item);
            }
            saveBackups(kept);
          } else {
            saveBackups(backups);
          }

          await interaction.reply({
            embeds: [makeEmbed("Backup Created", `Backup \`${snapshot.id}\` created.\nRoles: **${snapshot.stats.roleCount}**\nChannels: **${snapshot.stats.channelCount}**`, "success")],
            ephemeral: true
          });
          await sendTypedLog(interaction.guild, "security", "Backup Created", `${interaction.user.tag} created backup ${snapshot.id}.`, "info");
          return;
        }

        if (action === "list") {
          await interaction.reply({
            embeds: [makeEmbed("Available Backups", formatBackupList(backups, interaction.guild.id), "info")],
            ephemeral: true
          });
          return;
        }

        if (action === "restore" || action === "restorelatest") {
          const latest = backups.find(b => b.guildId === interaction.guild.id);
          const backupId = action === "restorelatest"
            ? latest?.id
            : interaction.options.getString("backup_id");
          const confirm = interaction.options.getBoolean("confirm") === true;
          if (!backupId) {
            await interaction.reply({ embeds: [makeEmbed("Missing Backup ID", "Provide `backup_id` when using restore.", "error")], ephemeral: true });
            return;
          }

          const snapshot = backups.find(b => b.id === backupId && b.guildId === interaction.guild.id);
          if (!snapshot) {
            await interaction.reply({ embeds: [makeEmbed("Backup Not Found", "No backup with that ID exists for this server.", "error")], ephemeral: true });
            return;
          }

          const result = await restoreGuildBackupSnapshot(interaction.guild, snapshot, { dryRun: !confirm });
          const modeText = result.dryRun ? "Dry Run (no changes applied)" : "Restore Applied";
          await interaction.reply({
            embeds: [makeEmbed("Backup Restore Result", `Mode: **${modeText}**\nRoles to create: **${result.rolesCreated}**\nChannels to create: **${result.channelsCreated}**\nExisting roles skipped: **${result.rolesSkippedExisting}**\nExisting channels skipped: **${result.channelsSkippedExisting}**\nUnsupported skipped: **${result.unsupportedChannelsSkipped}**\n\nSet \`confirm=true\` to apply restore.`, result.dryRun ? "warn" : "success")],
            ephemeral: true
          });
          await sendTypedLog(interaction.guild, "security", "Backup Restore", `${interaction.user.tag} ran ${result.dryRun ? "dry-run" : "applied"} restore for ${snapshot.id}.`, result.dryRun ? "warn" : "error");
          governance.incrementAnalytics(interaction.guild.id, result.dryRun ? "backupRestorePreviews" : "backupRestores", 1);
          governance.appendTimeline({
            guildId: interaction.guild.id,
            type: "backup-restore",
            actorId: interaction.user.id,
            targetId: null,
            reason: `${result.dryRun ? "preview" : "restore"} ${snapshot.id}`,
            details: result
          });
          return;
        }

        await interaction.reply({
          embeds: [makeEmbed("Invalid Action", "Use action `create`, `list`, or `restore`.", "error")],
          ephemeral: true
        });
        return;
      }

      if (cmd === "giveaway") {
        const duration = interaction.options.getString("duration");
        const prize = interaction.options.getString("prize");
        const durationMs = parseDurationExtended(duration);

        if (!durationMs) {
          await interaction.reply({ embeds: [makeEmbed("Error", "Use a valid duration like 10m, 1h, 7d, or 1mo.", "error")], ephemeral: true });
          return;
        }

        const channel = interaction.channel;
        const endsAt = Date.now() + durationMs;

        const sent = await channel.send({
          embeds: [makeEmbed("🎉 Giveaway Started", `**Prize:** ${prize}\n**Ends:** <t:${Math.floor(endsAt / 1000)}:R>\nEntries: **0**`, "info")]
        });

        await sent.edit({
          embeds: [makeEmbed("🎉 Giveaway Started", `**Prize:** ${prize}\n**Ends:** <t:${Math.floor(endsAt / 1000)}:R>\nEntries: **0**`, "info")],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`join_giveaway_${sent.id}`)
                .setLabel("Join Giveaway")
                .setStyle(ButtonStyle.Success)
            )
          ]
        });

        const giveaways = loadGiveaways();
        const giveaway = {
          messageId: sent.id,
          channelId: channel.id,
          guildId: interaction.guild.id,
          hostId: interaction.user.id,
          prize,
          endsAt,
          entries: [],
          ended: false,
          winnerId: null
        };

        giveaways.push(giveaway);
        saveGiveaways(giveaways);
        scheduleGiveaway(giveaway);

        await interaction.reply({ embeds: [makeEmbed("Giveaway Created", `Your giveaway was posted in ${channel}.`, "success")], ephemeral: true });
        await sendLog(interaction.guild, "Giveaway Created", `${interaction.user.tag} created a giveaway.`, "info", [
          { name: "Prize", value: prize }
        ]);
        return;
      }

      if (cmd === "reroll") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only staff can reroll giveaways.", "error")], ephemeral: true });
          return;
        }

        const messageId = interaction.options.getString("messageid");
        const giveaways = loadGiveaways();
        const giveaway = giveaways.find(g => g.messageId === messageId);

        if (!giveaway) {
          await interaction.reply({ embeds: [makeEmbed("Error", "Giveaway not found.", "error")], ephemeral: true });
          return;
        }

        if (!giveaway.entries.length) {
          await interaction.reply({ embeds: [makeEmbed("Error", "No entries to reroll.", "error")], ephemeral: true });
          return;
        }

        const winnerId = giveaway.entries[Math.floor(Math.random() * giveaway.entries.length)];
        giveaway.winnerId = winnerId;
        saveGiveaways(giveaways);

        await interaction.channel.send({
          embeds: [makeEmbed("🎉 Giveaway Rerolled", `New winner: <@${winnerId}>
**Prize:** ${giveaway.prize}`, "success")]
        });

        await interaction.reply({ embeds: [makeEmbed("Rerolled", `New winner is <@${winnerId}>`, "success")], ephemeral: true });
        return;
      }

      if (cmd === "userinfo") {
        const user = interaction.options.getUser("user") || interaction.user;
        const memberObj = await interaction.guild.members.fetch(user.id).catch(() => null);

        await interaction.reply({
          embeds: [makeEmbed(`User Info: ${user.tag}`, `ID: ${user.id}`, "info", [
            { name: "Created", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>` },
            { name: "Joined", value: memberObj ? `<t:${Math.floor(memberObj.joinedTimestamp / 1000)}:F>` : "Unknown" }
          ])]
        });
        return;
      }

      if (cmd === "serverstats") {
        await interaction.reply({
          embeds: [makeEmbed("Server Stats", `Stats for **${interaction.guild.name}**`, "info", [
            { name: "Members", value: String(interaction.guild.memberCount), inline: true },
            { name: "Channels", value: String(interaction.guild.channels.cache.size), inline: true },
            { name: "Roles", value: String(interaction.guild.roles.cache.size), inline: true }
          ])]
        });
        return;
      }

if (cmd === "poll") {
  const question = interaction.options.getString("question");
  const answers = [
    interaction.options.getString("answer1"),
    interaction.options.getString("answer2"),
    interaction.options.getString("answer3"),
    interaction.options.getString("answer4")
  ].filter(Boolean);

  const emojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];

  const description = answers
    .map((a, i) => `${emojis[i]} ${a}`)
    .join("\n");

  const msg = await interaction.channel.send({
    embeds: [makeEmbed("📊 Poll", `**${question}**\n\n${description}`, "info")]
  });

  for (let i = 0; i < answers.length; i++) {
    await msg.react(emojis[i]).catch(() => {});
  }

  await interaction.reply({
    embeds: [makeEmbed("Poll Created", "Your poll has been posted.", "success")],
    ephemeral: true
  });

  return;
}

      if (cmd === "sayembed") {
        const title = interaction.options.getString("title");
        const description = interaction.options.getString("description");

        await interaction.channel.send({ embeds: [makeEmbed(title, description, "info")] });
        await interaction.reply({ content: "Embed sent.", ephemeral: true });
        return;
      }

      if (cmd === "avatar") {
        const user = interaction.options.getUser("user") || interaction.user;

        await interaction.reply({
          embeds: [makeEmbed(`${user.tag}'s Avatar`, user.displayAvatarURL({ size: 1024 }), "info")]
        });
        return;
      }

      if (cmd === "roleinfo") {
        const role = interaction.options.getRole("role");

        await interaction.reply({
          embeds: [makeEmbed(`Role Info: ${role.name}`, `ID: ${role.id}`, "info", [
            { name: "Members", value: String(role.members.size), inline: true },
            { name: "Color", value: role.hexColor, inline: true },
            { name: "Position", value: String(role.position), inline: true }
          ])]
        });
        return;
      }

      if (cmd === "suggest") {
        const idea = interaction.options.getString("idea");

        const msg = await interaction.channel.send({
          embeds: [makeEmbed("💡 New Suggestion", idea, "info", [
            { name: "Suggested By", value: interaction.user.tag }
          ])]
        });

        await msg.react("✅").catch(() => {});
        await msg.react("❌").catch(() => {});
        await msg.react("🤔").catch(() => {});

        await interaction.reply({ embeds: [makeEmbed("Suggestion Posted", "Your suggestion has been posted.", "success")], ephemeral: true });
        return;
      }

      if (cmd === "riddle") {
        const r = config.riddle.riddles[Math.floor(Math.random() * config.riddle.riddles.length)];

        await interaction.reply({
          embeds: [makeEmbed("🧩 Random Riddle", `**Riddle:** ${r}\n\nReply with your guess.`, "info")]
        });
        return;
      }

      if (cmd === "addstream") {
        const name = interaction.options.getString("name");
        const platform = String(interaction.options.getString("platform") || "").trim().toLowerCase();
        const handle = interaction.options.getString("handle");

        const streams = loadStreams();

        if (streams.some(s => s.name.toLowerCase() === name.toLowerCase())) {
          await interaction.reply({
            embeds: [makeEmbed("Already Added", `${name} is already being tracked.`, "warn")],
            ephemeral: true
          });
          return;
        }

        let liveNow = false;
        try {
          if (platform === "twitch") liveNow = await checkTwitch(handle);
          if (platform === "youtube") liveNow = await checkYouTube(handle);
          if (platform === "kick") liveNow = await checkKick(handle);
          if (platform === "tiktok") liveNow = await checkTikTok(handle);
        } catch {}

        streams.push({ name, platform, handle, live: liveNow, lastPostId: null });
        saveStreams(streams);

        await interaction.reply({
          embeds: [makeEmbed("Added", `${name} added to tracking.${liveNow ? " They appear to be live right now, so no first-time alert will be sent." : ""}`, "success")],
          ephemeral: true
        });
        return;
      }

      if (cmd === "streams") {
        const streams = loadStreams();
        const desc = streams.length ? streams.map(s => `• ${s.name} (${s.platform}) → ${s.handle}`).join("\n") : "None";
        await interaction.reply({ embeds: [makeEmbed("Tracked Streams", desc, "info")] });
        return;
      }

      if (cmd === "removestream") {
        const name = interaction.options.getString("name");
        let streams = loadStreams();
        streams = streams.filter(s => s.name.toLowerCase() !== name.toLowerCase());
        saveStreams(streams);

        await interaction.reply({ embeds: [makeEmbed("Removed", `${name} removed from tracking.`, "warn")] });
        return;
      }

      if (cmd === "afk") {
        const reason = interaction.options.getString("reason") || "AFK";
        updateAFKStateAndPersist(current => {
          current[interaction.user.id] = reason;
        });

        await interaction.reply({ embeds: [makeEmbed("AFK Set", reason, "info")] });
        return;
      }

      if (cmd === "snipe") {
        const snipes = loadSnipes();
        const snipe = snipes[interaction.channel.id];

        if (!snipe) {
          await interaction.reply({ embeds: [makeEmbed("Nothing to Snipe", "No recently deleted message in this channel.", "warn")], ephemeral: true });
          return;
        }

        await interaction.reply({
          embeds: [makeEmbed("Sniped Message", `**Author:** ${snipe.author}\n**Content:** ${snipe.content}`, "info")]
        });
        return;
      }
    }

    if (interaction.isButton()) {
      if (await featureHub.handleButton(interaction, featureContext())) {
        return;
      }

      if (interaction.customId === "claim_ticket") {
        if (!canManageTicketsCommand(interaction.member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Trial Moderator or higher can claim tickets.", "error")], ephemeral: true });
          return;
        }
        if (!isTicketChannel(interaction.channel)) {
          await interaction.reply({ embeds: [makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
          return;
        }

        await interaction.reply({ embeds: [makeEmbed("Ticket Claimed", `${interaction.user} claimed this ticket.`, "success")] });
        await sendLog(interaction.guild, "Ticket Claimed", `${interaction.user.tag} claimed ${interaction.channel.name}.`, "info");
        return;
      }

      if (interaction.customId === "close_ticket_button") {
        if (!canManageTicketsCommand(interaction.member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only staff can close tickets.", "error")], ephemeral: true });
          return;
        }
        if (!isTicketChannel(interaction.channel)) {
          await interaction.reply({ embeds: [makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
          return;
        }

        const messages = await interaction.channel.messages.fetch({ limit: 200 }).catch(() => null);
        const orderedMessages = [...(messages?.values() || [])].reverse();
        await sendTranscript(interaction.guild, interaction.channel, orderedMessages, {
          ticketOwnerId: parseTicketOwnerId(interaction.channel),
          closedBy: interaction.user.id,
          closeReason: "Closed via ticket button",
          messageCount: orderedMessages.length
        });

        await interaction.reply({ embeds: [makeEmbed("Closing Ticket", "This ticket will be deleted in 5 seconds.", "warn")] });
        await sendTypedLog(interaction.guild, "moderation", "Ticket Closed", `${interaction.user.tag} closed ${interaction.channel.name}.`, "warn");

        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
        return;
      }

      if (interaction.customId.startsWith("join_giveaway_")) {
        const messageId = interaction.customId.replace("join_giveaway_", "");
        const giveaways = loadGiveaways();
        const giveaway = giveaways.find(g => g.messageId === messageId);

        if (!giveaway || giveaway.ended) {
          await interaction.reply({ embeds: [makeEmbed("Giveaway Ended", "This giveaway is no longer active.", "error")], ephemeral: true });
          return;
        }

        if (giveaway.entries.includes(interaction.user.id)) {
          await interaction.reply({ embeds: [makeEmbed("Already Entered", "You already joined this giveaway.", "warn")], ephemeral: true });
          return;
        }

        giveaway.entries.push(interaction.user.id);
        saveGiveaways(giveaways);

        const msg = await interaction.channel.messages.fetch(messageId).catch(() => null);
        if (msg) {
          await msg.edit({
            embeds: [makeEmbed("🎉 Giveaway Started", `**Prize:** ${giveaway.prize}\n**Ends:** <t:${Math.floor(giveaway.endsAt / 1000)}:R>\nEntries: **${giveaway.entries.length}**`, "info")],
            components: msg.components
          }).catch(() => {});
        }

        await interaction.reply({ embeds: [makeEmbed("Entry Confirmed", "You joined the giveaway.", "success")], ephemeral: true });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (await featureHub.handleModal(interaction, featureContext())) {
        return;
      }
    }

  } catch (err) {
    console.error("INTERACTION ERROR:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [makeEmbed("Error", "Something went wrong while running that action.", "error")],
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.on("error", err => {
  logRuntimeError("discord-client-error", err);
});

process.on("unhandledRejection", (reason, promise) => {
  const detail = reason instanceof Error ? `${reason.message}\n${reason.stack || ""}` : reason;
  console.error("[runtime] unhandledRejection:", detail);
  if (!startupCompleted) {
    console.error("[runtime] unhandledRejection occurred during startup phase.");
  }
  if (promise) {
    console.error("[runtime] unhandledRejection promise:", promise);
  }
});

process.on("uncaughtException", err => {
  logRuntimeError("uncaughtException", err);
  if (!startupCompleted) {
    console.error("[runtime] uncaughtException occurred during startup phase.");
  }
});

process.on("SIGTERM", signal => {
  flushRuntimePersistence(signal);
  console.warn(`[runtime] received ${signal}; process may be stopping due to platform lifecycle.`);
});

process.on("SIGINT", signal => {
  flushRuntimePersistence(signal);
  console.warn(`[runtime] received ${signal}; shutting down signal observed.`);
});

process.on("beforeExit", () => {
  flushRuntimePersistence("beforeExit");
});

console.log("ABOUT TO LOGIN...");
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log("LOGIN CALLED"))
  .catch(err => console.error("LOGIN ERROR:", err));


