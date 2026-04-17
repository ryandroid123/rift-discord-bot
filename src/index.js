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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
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

ensureDataFile("giveaways.json", []);
ensureDataFile("streams.json", []);
ensureDataFile("warnings.json", {});
ensureDataFile("antinuke.json", {});
ensureDataFile("state.json", { lastRiddleDate: null, inviteCounts: [] });
ensureDataFile("afk.json", {});
ensureDataFile("snipe.json", {});
ensureDataFile("automod.json", {});
ensureDataFile("moderation-log.json", []);
ensureDataFile("backups.json", []);
if (!fs.existsSync(transcriptDir)) fs.mkdirSync(transcriptDir, { recursive: true });

const automodCache = new Map();
const giveawayTimers = new Map();
const inviteCache = new Map();
const memberInviteStats = new Map();
const joinRaidCache = new Map();
const logQueueByChannel = new Map();
const streamCheckState = { running: false };
const antiNukeDedupe = new Map();

function logChannel(guild) {
  return getChannelByName(guild, config.channels.logs);
}

function getLogChannelByType(guild, kind = "general") {
  const channels = config.channels || {};
  const map = {
    general: channels.logs,
    moderation: channels.moderationLogs || channels.logs,
    security: channels.securityLogs || channels.logs,
    message: channels.messageLogs || channels.logs,
    member: channels.memberLogs || channels.logs
  };
  return getChannelByName(guild, map[kind] || channels.logs);
}

function transcriptChannel(guild) {
  return getChannelByName(guild, config.channels.transcripts);
}

function state() {
  return readJson(statePath, { lastRiddleDate: null, inviteCounts: [] });
}

function saveState(value) {
  writeJson(statePath, value);
}

function loadGiveaways() {
  return readJson(giveawaysPath, []);
}

function saveGiveaways(data) {
  writeJson(giveawaysPath, data);
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

function appendModerationLog(entry) {
  const items = readJson(moderationLogPath, []);
  items.push(entry);
  if (items.length > 5000) {
    items.splice(0, items.length - 5000);
  }
  writeJson(moderationLogPath, items);
}

function getAutoModSettings() {
  const automod = config.automod || {};
  return {
    enabled: automod.enabled !== false,
    whitelistRoles: automod.whitelistRoles || [],
    whitelistChannels: automod.whitelistChannels || [],
    whitelistUserIds: automod.whitelistUserIds || [],
    blockedWords: (automod.blockedWords || []).map(x => String(x).toLowerCase()),
    blockedTerms: (automod.blockedTerms || []).map(x => String(x).toLowerCase()),
    suspiciousLinkPatterns: (automod.suspiciousLinkPatterns || []).map(x => String(x).toLowerCase()),
    maxMentions: automod.maxMentions ?? 5,
    capsThreshold: automod.capsThreshold ?? 0.72,
    capsMinLetters: automod.capsMinLetters ?? 12,
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
    antiPhishing: automod.antiPhishing !== false
  };
}

function getAntiNukeSettings() {
  const antinuke = config.antinuke || {};
  return {
    threshold: antinuke.threshold ?? 3,
    windowMs: antinuke.windowMs ?? 30000,
    punishmentTimeoutMs: antinuke.punishmentTimeoutMs ?? 7 * 24 * 60 * 60 * 1000,
    trustedUserIds: antinuke.trustedUserIds || [],
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

function detectAutoModTrigger(message, settings) {
  const content = message.content || "";
  const minAggressiveLen = config.automod?.minMessageLengthForAggressiveChecks ?? 6;
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

  const historyItem = {
    time: now,
    text: content,
    normalized,
    links,
    attachments
  };
  storeAutoModHistory(key, history, historyItem);

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
    const riskyLink = links.find(link =>
      link.includes("@") ||
      link.includes("xn--") ||
      /https?:\/\/[^\/]+\.(zip|mov|click)(\/|$)/i.test(link)
    );
    if (riskyLink) {
      return { rule: "phishing-heuristic", reason: "Potential phishing link detected", evidence: riskyLink };
    }
  }

  if (mentions >= settings.maxMentions) {
    return { rule: "mention-spam", reason: "Too many mentions", evidence: `${mentions} mentions` };
  }

  if (!bypassCaps && letters.length >= settings.capsMinLetters && caps / letters.length >= settings.capsThreshold) {
    return { rule: "mass-caps", reason: "Excessive capitalization", evidence: `${caps}/${letters.length} capital letters` };
  }

  if (emojiCount >= settings.maxEmoji) {
    return { rule: "emoji-spam", reason: "Too many emojis", evidence: `${emojiCount} emojis` };
  }

  if (lineBreaks >= settings.maxLineBreaks) {
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
  if (recentSpam.length >= settings.spamLimit) {
    return { rule: "rapid-spam", reason: "Messages sent too quickly", evidence: `${recentSpam.length} messages in ${settings.spamWindowMs}ms` };
  }

  const recentRepeat = history.filter(x => now - x.time <= settings.repeatWindowMs);
  const repeatedExact = recentRepeat.filter(x => x.text && x.text === content).length;
  if (content && repeatedExact >= settings.repeatLimit) {
    return { rule: "repeat-spam", reason: "Repeated identical messages", evidence: `${repeatedExact} repeated messages` };
  }

  const recentDuplicate = history.filter(x => now - x.time <= settings.duplicateWindowMs);
  const repeatedNormalized = recentDuplicate.filter(x => x.normalized && x.normalized === normalized).length;
  if (normalized && repeatedNormalized >= settings.duplicateLimit) {
    return { rule: "duplicate-message", reason: "Duplicate/near-duplicate spam", evidence: `${repeatedNormalized} duplicate messages` };
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

async function applyAutoModAction(message, trigger) {
  const settings = getAutoModSettings();
  const member = message.member;
  if (!member) return false;

  await message.delete().catch(() => {});
  const warningReason = `AutoMod (${trigger.rule}): ${trigger.reason}`;
  const offences = addWarning(message.guild.id, message.author.id, "AutoMod", warningReason);

  let action = "warn";
  let actionDetail = "Warned user and removed message";

  if (offences >= settings.banThreshold && settings.allowBan) {
    action = "ban";
    actionDetail = "Banned user for repeated AutoMod violations";
    await message.guild.members.ban(message.author.id, { reason: `AutoMod: ${trigger.rule}` }).catch(() => {});
  } else if (offences >= settings.kickThreshold && settings.allowKick) {
    action = "kick";
    actionDetail = "Kicked user for repeated AutoMod violations";
    await member.kick(`AutoMod: ${trigger.rule}`).catch(() => {});
  } else if (offences >= settings.severeTimeoutThreshold && member.moderatable) {
    action = "timeout";
    actionDetail = `Timed out for ${Math.floor(settings.severeTimeoutMs / 60000)} minutes`;
    await member.timeout(settings.severeTimeoutMs, `AutoMod: ${trigger.rule}`).catch(() => {});
  } else if (offences >= settings.timeoutThreshold && member.moderatable) {
    action = "timeout";
    actionDetail = `Timed out for ${Math.floor(settings.timeoutMs / 60000)} minutes`;
    await member.timeout(settings.timeoutMs, `AutoMod: ${trigger.rule}`).catch(() => {});
  }

  await message.author.send({
    embeds: [makeEmbed("AutoMod Action", `Rule: **${trigger.rule}**\nReason: ${trigger.reason}\nAction: **${actionDetail}**`, "warn")]
  }).catch(() => {});

  await sendTypedLog(message.guild, "moderation", "AutoMod Action", `${message.author.tag} triggered ${trigger.rule}.`, "warn", [
    { name: "Rule", value: trigger.rule, inline: true },
    { name: "Action", value: action, inline: true },
    { name: "Warnings", value: String(offences), inline: true },
    { name: "Evidence", value: (trigger.evidence || "n/a").slice(0, 1000) },
    { name: "Message", value: (message.content || "[attachment-only]").slice(0, 1000) }
  ]);

  appendModerationLog({
    type: "automod",
    guildId: message.guild.id,
    userId: message.author.id,
    rule: trigger.rule,
    reason: trigger.reason,
    evidence: trigger.evidence || null,
    action,
    warnings: offences,
    time: Date.now()
  });

  const state = loadAutomodState();
  if (!state[message.guild.id]) state[message.guild.id] = {};
  if (!state[message.guild.id][message.author.id]) {
    state[message.guild.id][message.author.id] = {
      totalActions: 0,
      lastRule: null,
      lastAction: null,
      lastAt: null
    };
  }
  state[message.guild.id][message.author.id].totalActions += 1;
  state[message.guild.id][message.author.id].lastRule = trigger.rule;
  state[message.guild.id][message.author.id].lastAction = action;
  state[message.guild.id][message.author.id].lastAt = Date.now();
  saveAutomodState(state);

  return true;
}

function canUseModCommand(member) {
  return hasAnyRole(member, ["Founder", "Admin", "Moderator"]);
}

async function sendLog(guild, title, description, type = "info", fields = []) {
  const ch = getLogChannelByType(guild, "general");
  if (!ch) return;
  await queueLogSend(ch, { embeds: [makeEmbed(title, description, type, fields)] });
}

async function sendTypedLog(guild, kind, title, description, type = "info", fields = []) {
  const ch = getLogChannelByType(guild, kind);
  if (!ch) return;
  await queueLogSend(ch, { embeds: [makeEmbed(title, description, type, fields)] });
}

async function queueLogSend(channel, payload) {
  const channelId = channel.id;
  const queue = logQueueByChannel.get(channelId) || [];
  queue.push(payload);
  logQueueByChannel.set(channelId, queue);
  if (queue.processing) return;
  queue.processing = true;

  while (queue.length) {
    const next = queue.shift();
    await channel.send(next).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 350));
  }

  queue.processing = false;
}

async function sendTranscript(guild, ticketChannel, lines) {
  const ch = transcriptChannel(guild);
  if (!ch) return;

  const filePath = resolveDataPath("transcripts", `${ticketChannel.name}-${Date.now()}.txt`);
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");

  await ch.send({
    embeds: [makeEmbed("Ticket Transcript", `Transcript saved from ${ticketChannel.name}`, "info")],
    files: [filePath]
  }).catch(() => {});

  fs.unlink(filePath, () => {});
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
  const category = await createTicketsCategoryIfMissing(guild);
  const safe = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "user";
  const channelName = type === "support" ? `support-${safe}` : `application-${safe}`;

  const existing = guild.channels.cache.find(c => c.parentId === category.id && c.name === channelName);
  if (existing) return { channel: existing, exists: true };

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: buildTicketOverwrites(guild, user.id)
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("claim_ticket").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("close_ticket_button").setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
  );

  const fields = [
    { name: "Opened By", value: user.tag, inline: true },
    { name: "Type", value: type === "support" ? "Support" : "Staff Application", inline: true }
  ];

  if (answers) {
    fields.push(
      { name: "Age", value: answers.age },
      { name: "Timezone", value: answers.timezone },
      { name: "Experience", value: answers.experience },
      { name: "Why", value: answers.why }
    );
  }

  await channel.send({
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
    components: [row]
  });

  await sendLog(guild, "Ticket Opened", `${user.tag} opened a ${type} ticket.`, "success", [
    { name: "Channel", value: `${channel}` }
  ]);

  return { channel, exists: false };
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
  return new Map(s.inviteCounts || []);
}

function saveInviteCountsToState(map) {
  const s = state();
  s.inviteCounts = [...map.entries()];
  saveState(s);
}

async function endGiveaway(messageId) {
  const giveaways = loadGiveaways();
  const giveaway = giveaways.find(g => g.messageId === messageId);
  if (!giveaway || giveaway.ended) return;

  const guild = client.guilds.cache.get(giveaway.guildId);
  if (!guild) return;
  const channel = guild.channels.cache.get(giveaway.channelId);
  if (!channel) return;

  giveaway.ended = true;

  let winnerText = "No one entered.";
  if (giveaway.entries.length) {
    const winnerId = giveaway.entries[Math.floor(Math.random() * giveaway.entries.length)];
    giveaway.winnerId = winnerId;
    winnerText = `<@${winnerId}>`;
  }

  saveGiveaways(giveaways);

  const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);
  if (msg) {
    await msg.edit({
      embeds: [makeEmbed("🎉 Giveaway Ended", `**Prize:** ${giveaway.prize}\n**Winner:** ${winnerText}`, "success")],
      components: []
    }).catch(() => {});
  }

  await channel.send({
    embeds: [makeEmbed("Giveaway Finished", `**Prize:** ${giveaway.prize}\n**Winner:** ${winnerText}`, "success")]
  }).catch(() => {});

  await sendLog(guild, "Giveaway Ended", `Giveaway ended in ${channel}.`, "info", [
    { name: "Prize", value: giveaway.prize, inline: true },
    { name: "Winner", value: winnerText, inline: true }
  ]);
}

function scheduleGiveaway(giveaway) {
  const delay = Math.max(0, giveaway.endsAt - Date.now());
  if (giveawayTimers.has(giveaway.messageId)) {
    clearTimeout(giveawayTimers.get(giveaway.messageId));
  }
  const timer = setTimeout(async () => {
    await endGiveaway(giveaway.messageId);
  }, delay);
  giveawayTimers.set(giveaway.messageId, timer);
}

function isTrustedAntiNukeActor(guild, member, settings) {
  if (!member) return true;
  if (member.id === guild.ownerId) return true;
  if (member.user?.bot) return settings.trustedUserIds.includes(member.id);
  if (settings.trustedUserIds.includes(member.id)) return true;
  return false;
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

async function stripDangerousPermsFromMember(member, reason) {
  for (const role of member.roles.cache.values()) {
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

async function antiNukeCheck(guild, executorId, action, extra = {}) {
  if (shouldSkipAntiNukeDuplicate(guild.id, executorId, action, extra.target || "")) return;

  const settings = getAntiNukeSettings();
  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return;
  if (isTrustedAntiNukeActor(guild, member, settings)) return;
  if (!hasStaffRole(member) && !member.permissions.has(PermissionFlagsBits.ManageGuild)) return;

  const counts = recordAntiNuke(guild.id, executorId, action, settings);

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

  const reason = `Anti-nuke triggered (${action})`;
  if (settings.emergency.stripDangerousPermissions) {
    await stripDangerousPermsFromMember(member, reason);
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
}

async function cacheInvitesForGuild(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;
  inviteCache.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses || 0])));
}

async function checkJoinRaid(member) {
  const antiRaid = config.automod?.antiRaid || {};
  const enabled = antiRaid.enabled !== false;
  if (!enabled) return;

  const windowMs = antiRaid.windowMs ?? 15000;
  const joinLimit = antiRaid.joinLimit ?? 8;
  const action = antiRaid.action || "log";
  const key = member.guild.id;
  const now = Date.now();
  const timestamps = (joinRaidCache.get(key) || []).filter(t => now - t <= windowMs);
  timestamps.push(now);
  joinRaidCache.set(key, timestamps);

  if (timestamps.length < joinLimit) return;

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
}

async function runStreamChecksSafely() {
  if (streamCheckState.running) return;
  streamCheckState.running = true;
  try {
    await checkStreams(client, config, makeEmbed);
  } catch {}
  streamCheckState.running = false;
}

function shouldSkipAntiNukeDuplicate(guildId, executorId, action, target = "") {
  const key = `${guildId}:${executorId}:${action}:${target}`;
  const now = Date.now();
  const last = antiNukeDedupe.get(key) || 0;
  antiNukeDedupe.set(key, now);

  for (const [k, t] of antiNukeDedupe.entries()) {
    if (now - t > 30000) antiNukeDedupe.delete(k);
  }

  return now - last < 2500;
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

async function maybePostDailyRiddle() {
  const s = state();
  const now = londonNowParts();
  if (s.lastRiddleDate === now.dateKey) return;
  if (now.hour < config.riddle.hour) return;
  if (now.hour === config.riddle.hour && now.minute < config.riddle.minute) return;

  const r = config.riddle.riddles[Math.floor(Math.random() * config.riddle.riddles.length)];

  for (const guild of client.guilds.cache.values()) {
    const ch = getChannelByName(guild, config.channels.chat);
    if (!ch) continue;
    await ch.send({
      embeds: [
        makeEmbed(
          "🧩 Riddle of the Day",
          `**Riddle:** ${r}\n\nReply in chat with your guess.`,
          "info"
        )
      ]
    }).catch(() => {});
  }

  s.lastRiddleDate = now.dateKey;
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
  const storedInviteCounts = loadInviteCountsFromState();
  for (const [key, value] of storedInviteCounts.entries()) {
    memberInviteStats.set(key, value);
  }

  const giveaways = loadGiveaways();
  let scheduled = 0;
  let recoveredEnded = 0;
  for (const g of giveaways) {
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

  for (const guild of client.guilds.cache.values()) {
    cacheInvitesForGuild(guild).catch(() => {});
  }

  setInterval(() => {
    runStreamChecksSafely().catch(() => {});
  }, config.social?.checkIntervalMs || 2 * 60 * 1000);
  runStreamChecksSafely().catch(() => {});

  startRiddleLoop();
});

client.on(Events.GuildMemberAdd, async member => { 
  await checkJoinRaid(member).catch(() => {});

  const role = getRoleByName(member.guild, config.autoRole);
  if (role) {
    await member.roles.add(role).catch(() => {});
  }

  let inviterText = "Unknown";
  let inviterId = null;

  const oldMap = inviteCache.get(member.guild.id) || new Map();
  const newInvites = await member.guild.invites.fetch().catch(() => null);

  if (newInvites) {
    const used = newInvites.find(inv => (inv.uses || 0) > (oldMap.get(inv.code) || 0));
    if (used?.inviter) {
      inviterText = `${used.inviter.tag} (${used.code})`;
      inviterId = used.inviter.id;

      const key = `${member.guild.id}:${inviterId}`;
      memberInviteStats.set(key, (memberInviteStats.get(key) || 0) + 1);
      saveInviteCountsToState(memberInviteStats);
    }

    inviteCache.set(member.guild.id, new Map(newInvites.map(inv => [inv.code, inv.uses || 0])));
  }

  await sendTypedLog(member.guild, "member", "Member Joined", `${member.user.tag} joined and received the ${config.autoRole} role.`, "success", [
    { name: "Invited By", value: inviterText }
  ]);

  const landing = getChannelByName(member.guild, config.channels.landing);
  if (landing) {
    await landing.send({
      embeds: [
        makeEmbed(
          "Welcome to Rift Studios",
          `Welcome ${member} to **${member.guild.name}**.\n\nThank you for joining **.gg/riftstudios**!\nStay tuned for the game's release 👀`,
          "success"
        )
      ]
    }).catch(() => {});
  }

  await member.send({
    embeds: [
      makeEmbed(
        "Welcome to Rift Studios",
        "Thank you for joining **.gg/riftstudios**!\n\nStay tuned for the game's release 👀",
        "success"
      )
    ]
  }).catch(() => {});
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

  const takeoff = getChannelByName(member.guild, config.channels.takeoff);
  if (takeoff) {
    await takeoff.send({
      embeds: [
        makeEmbed(
          "Member Left",
          `**${member.user.tag}** has left **${member.guild.name}**.`,
          "warn"
        )
      ]
    }).catch(() => {});
  }
});

client.on(Events.MessageDelete, async message => {
  if (!message.guild || !message.author || message.author.bot) return;
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

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;
  if (Date.now() - message.createdTimestamp > 15000) return;
  if (!message.content && !message.attachments?.size) return;

  const afk = loadAFK();
  if (afk[message.author.id]) {
    delete afk[message.author.id];
    saveAFK(afk);
    await message.reply("Welcome back, AFK removed.").catch(() => {});
  }

  message.mentions.users.forEach(async user => {
    if (afk[user.id]) {
      await message.reply(`${user.tag} is AFK: ${afk[user.id]}`).catch(() => {});
    }
  });

  const settings = getAutoModSettings();
  if (isAutoModBypassed(message, settings)) return;

  const trigger = detectAutoModTrigger(message, settings);
  if (!trigger) return;

  await applyAutoModAction(message, trigger);
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
        if (!isTicketChannel(interaction.channel)) {
          await interaction.reply({ embeds: [makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
          return;
        }

        const messages = await interaction.channel.messages.fetch({ limit: 200 }).catch(() => null);
        const lines = [...(messages?.values() || [])]
          .reverse()
          .map(m => `[${new Date(m.createdTimestamp).toLocaleString()}] ${m.author.tag}: ${m.content || "[embed/attachment]"}`);

        await sendTranscript(interaction.guild, interaction.channel, lines);

        await interaction.reply({ embeds: [makeEmbed("Closing Ticket", "This ticket will be deleted in 5 seconds.", "warn")] });
        await sendLog(interaction.guild, "Ticket Closed", `${interaction.user.tag} closed ${interaction.channel.name}.`, "warn");

        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
        return;
      }

      if (cmd === "timeout") {
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
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

        await sendTypedLog(interaction.guild, "member", "Timeout Removed", `${interaction.user.tag} removed ${user.tag}'s timeout.`, "success", [
          { name: "Reason", value: reason }
        ]);
        return;
      }

      if (cmd === "ban") {
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || "No reason provided";

        await interaction.guild.members.ban(user.id, { reason });

        await interaction.reply({ embeds: [makeEmbed("Member Banned", `${user.tag} has been banned.`, "error")] });
        await sendTypedLog(interaction.guild, "member", "Member Banned", `${interaction.user.tag} banned ${user.tag}.`, "error", [
          { name: "Reason", value: reason }
        ]);
        return;
      }

      if (cmd === "kick") {
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
        if (!canUseModCommand(member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can use this.", "error")], ephemeral: true });
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
        const user = interaction.options.getUser("user") || interaction.user;
        const key = `${interaction.guild.id}:${user.id}`;
        const count = memberInviteStats.get(key) || 0;

        await interaction.reply({
          embeds: [makeEmbed("Invite Count", `**${user.tag}** has **${count}** tracked invite${count === 1 ? "" : "s"}.`, "info")]
        });
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
          const maxStored = Math.max(1, config.backup?.maxStored || 20);
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

        if (action === "restore") {
          const backupId = interaction.options.getString("backup_id");
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
        const durationMs = ms(duration);

        if (!durationMs) {
          await interaction.reply({ embeds: [makeEmbed("Error", "Use a valid duration like 10m, 1h, or 1d.", "error")], ephemeral: true });
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
        const afk = loadAFK();
        afk[interaction.user.id] = reason;
        saveAFK(afk);

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
      if (interaction.customId === "open_support_ticket") {
        const result = await createTicket(interaction.guild, interaction.user, "support");

        await interaction.reply({
          embeds: [makeEmbed(result.exists ? "Ticket Already Open" : "Support Ticket Opened", `${result.channel}`, result.exists ? "warn" : "success")],
          ephemeral: true
        });
        return;
      }

      if (interaction.customId === "open_application_ticket") {
        const modal = new ModalBuilder()
          .setCustomId("staff_application_modal")
          .setTitle("Staff Application");

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("age").setLabel("How old are you?").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("timezone").setLabel("What is your timezone?").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("experience").setLabel("Do you have staff experience?").setStyle(TextInputStyle.Paragraph).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("why").setLabel("Why do you want to be staff?").setStyle(TextInputStyle.Paragraph).setRequired(true)
          )
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "claim_ticket") {
        if (!hasStaffRole(interaction.member)) {
          await interaction.reply({ embeds: [makeEmbed("No Permission", "Only Founder, Admin, and Moderator can claim tickets.", "error")], ephemeral: true });
          return;
        }

        await interaction.reply({ embeds: [makeEmbed("Ticket Claimed", `${interaction.user} claimed this ticket.`, "success")] });
        await sendLog(interaction.guild, "Ticket Claimed", `${interaction.user.tag} claimed ${interaction.channel.name}.`, "info");
        return;
      }

      if (interaction.customId === "close_ticket_button") {
        if (!isTicketChannel(interaction.channel)) {
          await interaction.reply({ embeds: [makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
          return;
        }

        const messages = await interaction.channel.messages.fetch({ limit: 200 }).catch(() => null);
        const lines = [...(messages?.values() || [])]
          .reverse()
          .map(m => `[${new Date(m.createdTimestamp).toLocaleString()}] ${m.author.tag}: ${m.content || "[embed/attachment]"}`);

        await sendTranscript(interaction.guild, interaction.channel, lines);

        await interaction.reply({ embeds: [makeEmbed("Closing Ticket", "This ticket will be deleted in 5 seconds.", "warn")] });
        await sendLog(interaction.guild, "Ticket Closed", `${interaction.user.tag} closed ${interaction.channel.name}.`, "warn");

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

    if (interaction.isModalSubmit() && interaction.customId === "staff_application_modal") {
      const result = await createTicket(interaction.guild, interaction.user, "application", {
        age: interaction.fields.getTextInputValue("age"),
        timezone: interaction.fields.getTextInputValue("timezone"),
        experience: interaction.fields.getTextInputValue("experience"),
        why: interaction.fields.getTextInputValue("why")
      });

      await interaction.reply({
        embeds: [makeEmbed(result.exists ? "Application Already Open" : "Application Submitted", `${result.channel}`, result.exists ? "warn" : "success")],
        ephemeral: true
      });
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

client.on("error", console.error);
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

console.log("ABOUT TO LOGIN...");
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log("LOGIN CALLED"))
  .catch(err => console.error("LOGIN ERROR:", err));
