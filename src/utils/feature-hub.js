const ms = require("ms");
const { DisTube } = require("distube");
const { YtDlpPlugin } = require("@distube/yt-dlp");
const { SpotifyPlugin } = require("@distube/spotify");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { ensureDataFile, readJson, writeJson, resolveDataPath } = require("./storage");
const fetchFn = typeof fetch === "function" ? fetch.bind(globalThis) : require("node-fetch");

const DATA_FILES = {
  guildSettings: "feature-settings.json",
  profiles: "profiles.json",
  suggestions: "suggestions.json",
  applications: "applications.json",
  partnerships: "partnerships.json",
  reminders: "reminders.json",
  tags: "tags.json",
  quotes: "quotes.json",
  birthdays: "birthdays.json",
  forms: "forms.json",
  formSubmissions: "form-submissions.json",
  reports: "reports.json",
  schedules: "schedules.json",
  commandControls: "command-controls.json",
  maintenance: "maintenance.json",
  ticketMeta: "ticket-meta.json",
  polls: "polls.json",
  ghostPings: "ghostpings.json",
  watchlist: "watchlist.json",
  bumpTracking: "bump-tracking.json",
  transcriptIndex: "transcript-index.json",
  shopItems: "shop-items.json",
  inventories: "inventories.json",
  reactionRoles: "reaction-roles.json",
  musicQueues: "music-queues.json",
  prestige: "prestige.json"
};

const FILE_DEFAULTS = {
  "feature-settings.json": {},
  "profiles.json": {},
  "suggestions.json": [],
  "applications.json": [],
  "partnerships.json": [],
  "reminders.json": [],
  "tags.json": {},
  "quotes.json": [],
  "birthdays.json": {},
  "forms.json": {},
  "form-submissions.json": [],
  "reports.json": [],
  "schedules.json": [],
  "command-controls.json": {},
  "maintenance.json": {},
  "ticket-meta.json": {},
  "polls.json": [],
  "ghostpings.json": [],
  "watchlist.json": [],
  "bump-tracking.json": {},
  "transcript-index.json": [],
  "shop-items.json": {},
  "inventories.json": {},
  "reaction-roles.json": {},
  "music-queues.json": {},
  "prestige.json": {}
};

for (const file of Object.values(DATA_FILES)) {
  ensureDataFile(file, FILE_DEFAULTS[file] ?? {});
}

const xpCooldown = new Map();
const selfbotWindow = new Map();
const stickyCooldown = new Map();
const ticketOpenBurstGuard = new Map();
const ticketDeleteInFlight = new Map();
const utilityCooldown = new Map();
const weatherCache = new Map();
const rateCache = new Map();
let distube = null;
let profilesCache = null;
let profilesDirty = false;
let profilesFlushTimer = null;

function load(name, fallback) {
  const file = DATA_FILES[name];
  return readJson(resolveDataPath(file), fallback);
}

function save(name, value) {
  const file = DATA_FILES[name];
  writeJson(resolveDataPath(file), value);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await fetchFn(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isUtilityRateLimited(guildId, userId, action, minSeconds = 7) {
  const key = `${guildId}:${userId}:${action}`;
  const now = Date.now();
  const last = utilityCooldown.get(key) || 0;
  if (now - last < minSeconds * 1000) {
    return Math.ceil((minSeconds * 1000 - (now - last)) / 1000);
  }
  utilityCooldown.set(key, now);
  return 0;
}

function saveMusicQueueSnapshot(guildId, snapshot) {
  if (!guildId) return;
  const all = load("musicQueues", {});
  all[guildId] = snapshot;
  save("musicQueues", all);
}

function getGuildPrestige(guildId, userId) {
  const all = load("prestige", {});
  if (!all[guildId]) all[guildId] = {};
  if (!all[guildId][userId]) all[guildId][userId] = { tier: 0, totalPrestiges: 0, lastAt: null };
  return { all, item: all[guildId][userId] };
}

function shouldBlockTicketOpenBurst(guildId, userId, type, windowMs = 5000) {
  const now = Date.now();
  const key = `${guildId}:${userId}:${String(type || "").toLowerCase()}`;
  const last = ticketOpenBurstGuard.get(key) || 0;
  ticketOpenBurstGuard.set(key, now);
  for (const [k, t] of ticketOpenBurstGuard.entries()) {
    if (now - t > Math.max(30000, windowMs * 4)) ticketOpenBurstGuard.delete(k);
  }
  return now - last < windowMs;
}

function buildApplicationModal() {
  const modal = new ModalBuilder()
    .setCustomId("staff_application_modal")
    .setTitle("Staff Application");
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("age")
        .setLabel("How old are you?")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("timezone")
        .setLabel("What is your timezone?")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("experience")
        .setLabel("Do you have staff experience?")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("availability")
        .setLabel("What is your availability?")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder("Days/times you can be active")
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("why")
        .setLabel("Why do you want to be staff?")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
    )
  );
  return modal;
}

function getProfilesData() {
  if (!profilesCache) profilesCache = load("profiles", {});
  return profilesCache;
}

function flushProfilesNow() {
  if (!profilesCache || !profilesDirty) return;
  save("profiles", profilesCache);
  profilesDirty = false;
}

function scheduleProfilesFlush() {
  profilesDirty = true;
  if (profilesFlushTimer) return;
  profilesFlushTimer = setTimeout(() => {
    profilesFlushTimer = null;
    flushProfilesNow();
  }, 1500);
  if (typeof profilesFlushTimer.unref === "function") profilesFlushTimer.unref();
}

function flushPersistence() {
  if (profilesFlushTimer) {
    clearTimeout(profilesFlushTimer);
    profilesFlushTimer = null;
  }
  flushProfilesNow();
}

function ensureGuild(data, guildId, fallback = {}) {
  if (!data[guildId]) data[guildId] = fallback;
  return data[guildId];
}

function getGuildSettings(guildId) {
  const all = load("guildSettings", {});
  const settings = ensureGuild(all, guildId, {
    leveling: { enabled: true, xpMin: 10, xpMax: 20, rewards: {} },
    economy: { enabled: true, currencyName: "Coins" },
    welcome: { customMessage: "Welcome {user} to **{server}**!", dmMessage: "Welcome to {server}!", autoRoles: [], onboardingPrompt: "Tell us what you're here for.", welcomeImage: null },
    leave: { message: "{userTag} left {server}." },
    mediaOnlyChannels: [],
    sticky: {},
    starboard: { enabled: false, channelId: null, emoji: "⭐", threshold: 3, entries: {} },
    nickname: { rule: null },
    scamProtection: { enabled: true },
    selfbot: { enabled: true },
    watchlist: { enabled: true, accountAgeHours: 72 },
    onboarding: { prompt: "Welcome! Read the rules and introduce yourself." },
    partnerships: { cooldownMs: 12 * 60 * 60 * 1000, channelId: null },
    bump: { cooldownMs: 2 * 60 * 60 * 1000, channelId: null }
  });
  save("guildSettings", all);
  return settings;
}

function setGuildSettings(guildId, updater) {
  const all = load("guildSettings", {});
  const current = ensureGuild(all, guildId, {});
  updater(current);
  save("guildSettings", all);
  return current;
}

function ensureProfile(all, guildId, userId) {
  if (!all[guildId]) all[guildId] = {};
  if (!all[guildId][userId]) {
    all[guildId][userId] = {
      xp: 0,
      level: 0,
      currency: 0,
      joins: 0,
      firstJoinAt: null,
      lastJoinAt: null,
      lastLeaveAt: null,
      afk: null,
      staff: { actions: 0, lastActionAt: null }
    };
  }
  return all[guildId][userId];
}

function profile(guildId, userId) {
  const all = getProfilesData();
  const p = ensureProfile(all, guildId, userId);
  scheduleProfilesFlush();
  return p;
}

function updateProfile(guildId, userId, updater) {
  const all = getProfilesData();
  const p = ensureProfile(all, guildId, userId);
  updater(p);
  scheduleProfilesFlush();
  return p;
}

function ensureGuildMap(data, guildId) {
  if (!data[guildId]) data[guildId] = {};
  return data[guildId];
}

function ensureInventory(data, guildId, userId) {
  const guildInv = ensureGuildMap(data, guildId);
  if (!Array.isArray(guildInv[userId])) guildInv[userId] = [];
  return guildInv[userId];
}

function getAchievementRows(p) {
  const xp = Number(p?.xp || 0);
  const lvl = Number(p?.level || 0);
  const coins = Number(p?.currency || 0);
  const joins = Number(p?.joins || 0);
  return [
    { key: "first_steps", name: "First Steps", unlocked: xp >= 25 },
    { key: "chatterbox", name: "Chatterbox", unlocked: xp >= 500 },
    { key: "grinder", name: "Grinder", unlocked: xp >= 2500 },
    { key: "rookie_leveler", name: "Rookie Leveler", unlocked: lvl >= 5 },
    { key: "elite_leveler", name: "Elite Leveler", unlocked: lvl >= 15 },
    { key: "wealthy", name: "Wealthy", unlocked: coins >= 1000 },
    { key: "veteran", name: "Veteran", unlocked: joins >= 10 }
  ];
}

function bumpStaffActivity(guildId, userId) {
  updateProfile(guildId, userId, p => {
    p.staff = p.staff || { actions: 0, lastActionAt: null };
    p.staff.actions = (p.staff.actions || 0) + 1;
    p.staff.lastActionAt = Date.now();
  });
}

function randomXp(min, max) {
  return Math.max(min, Math.floor(Math.random() * (max - min + 1)) + min);
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

function levelFromXp(xp) {
  return Math.floor(0.1 * Math.sqrt(Math.max(0, xp)));
}

function runCommandControl(interaction) {
  const guildId = interaction.guild.id;
  const controlsAll = load("commandControls", {});
  const controls = controlsAll[guildId] || {};
  const command = interaction.commandName;
  const giveawayCommands = new Set(["giveaway", "reroll", "giveawaymanage"]);
  const entries = controls[command];
  if (!entries) return null;

  if (entries.disabled === true) return "This command is currently disabled.";
  if (!giveawayCommands.has(command) && Array.isArray(entries.channels) && entries.channels.length && !entries.channels.includes(interaction.channelId)) {
    return "This command is restricted to specific channels.";
  }
  if (Array.isArray(entries.roles) && entries.roles.length) {
    const hasRole = interaction.member?.roles?.cache?.some(r => entries.roles.includes(r.id));
    if (!hasRole) return "You do not have an allowed role for this command.";
  }
  return null;
}

function isInMaintenance(interaction, ctx) {
  const all = load("maintenance", {});
  const mode = all[interaction.guild.id];
  if (!mode?.enabled) return null;
  if (ctx.canUseModCommand(interaction.member)) return null;
  return mode.reason || "Bot maintenance mode is active.";
}

function formatGiveawaySummary(g) {
  const explicitCounts = Object.values(g.entryCounts || {}).reduce((sum, n) => sum + Math.max(1, Number(n) || 1), 0);
  const totalEntries = explicitCounts || (g.entries || []).length;
  const req = (g.requiredRoleIds || []).map(id => `<@&${id}>`).join(", ") || "None";
  const blk = (g.blacklistRoleIds || []).map(id => `<@&${id}>`).join(", ") || "None";
  const bonus = (g.bonusEntries || []).map(b => `<@&${b.roleId}> (+${b.entries})`).join("\n") || "None";
  return [
    `**Prize:** ${g.prize}`,
    `**Ends:** <t:${Math.floor(g.endsAt / 1000)}:R>`,
    `**Winners:** ${g.winners || 1}`,
    `**Entries:** ${totalEntries} total from ${(g.entries || []).length} participant(s)`,
    `**Required Roles:** ${req}`,
    `**Blacklisted Roles:** ${blk}`,
    `**Bonus Entries:** ${bonus}`
  ].join("\n");
}

function buildWeightedPool(giveaway, guild, options = {}) {
  const excluded = new Set((options.excludeUserIds || []).map(String));
  const pool = [];
  const explicitCounts = giveaway.entryCounts && typeof giveaway.entryCounts === "object"
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
    const member = guild.members.cache.get(userId);
    for (const bonus of giveaway.bonusEntries || []) {
      if (member?.roles?.cache?.has(bonus.roleId)) {
        weight += Math.max(0, Number(bonus.entries) || 0);
      }
    }
    for (let i = 0; i < weight; i += 1) pool.push(userId);
  }
  return pool;
}

function pickWinners(giveaway, guild, options = {}) {
  const pool = buildWeightedPool(giveaway, guild, options);
  const mutablePool = [...pool];
  const winners = [];
  const winnerCount = Math.max(1, Number(giveaway.winners) || 1);

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

async function maybeRunReminders(client, ctx) {
  const reminders = load("reminders", []);
  if (!reminders.length) return;
  const now = Date.now();
  const due = reminders.filter(r => (r.time || 0) <= now);
  if (!due.length) return;
  const keep = reminders.filter(r => (r.time || 0) > now);
  save("reminders", keep);

  for (const r of due) {
    const user = await client.users.fetch(r.userId).catch(() => null);
    if (!user) continue;
    await user.send({ embeds: [ctx.makeEmbed("Reminder", r.text, "info")] }).catch(() => {});
  }
}

async function maybeRunSchedules(client, ctx) {
  const schedules = load("schedules", []);
  if (!schedules.length) return;
  const now = Date.now();
  let changed = false;

  for (const s of schedules) {
    if ((s.nextRunAt || 0) > now) continue;
    const guild = client.guilds.cache.get(s.guildId);
    const channel = guild?.channels?.cache?.get(s.channelId);
    if (channel?.isTextBased?.()) {
      await channel.send({ embeds: [ctx.makeEmbed("Scheduled Announcement", s.text, "info")] }).catch(() => {});
      if (ctx.governance) {
        ctx.governance.appendTimeline({
          guildId: s.guildId,
          type: "schedule-post",
          actorId: s.createdBy,
          targetId: null,
          reason: s.text.slice(0, 80)
        });
      }
    }
    changed = true;
    if (s.intervalMs) s.nextRunAt = now + s.intervalMs;
    else s.deleted = true;
  }

  if (changed) save("schedules", schedules.filter(s => !s.deleted));
}

async function onReady(client, ctx) {
  getProfilesData();
  if (!distube) {
    distube = new DisTube(client, {
      emitNewSongOnly: true,
      emitAddSongWhenCreatingQueue: false,
      plugins: [new YtDlpPlugin(), new SpotifyPlugin()]
    });

    distube
      .on("playSong", (queue, song) => {
        saveMusicQueueSnapshot(queue.textChannel?.guild?.id, {
          voiceChannelId: queue.voiceChannel?.id || null,
          textChannelId: queue.textChannel?.id || null,
          nowPlaying: { name: song.name, url: song.url, duration: song.formattedDuration || null },
          queued: queue.songs.slice(1, 25).map(s => ({ name: s.name, url: s.url, duration: s.formattedDuration || null })),
          updatedAt: Date.now()
        });
        queue.textChannel?.send({
          embeds: [ctx.makeEmbed("Now Playing", `**${song.name}**\n${song.url}`, "info")]
        }).catch(() => {});
      })
      .on("addSong", (queue, song) => {
        saveMusicQueueSnapshot(queue.textChannel?.guild?.id, {
          voiceChannelId: queue.voiceChannel?.id || null,
          textChannelId: queue.textChannel?.id || null,
          nowPlaying: queue.songs[0] ? { name: queue.songs[0].name, url: queue.songs[0].url, duration: queue.songs[0].formattedDuration || null } : null,
          queued: queue.songs.slice(1, 25).map(s => ({ name: s.name, url: s.url, duration: s.formattedDuration || null })),
          updatedAt: Date.now()
        });
      })
      .on("finish", queue => {
        saveMusicQueueSnapshot(queue.textChannel?.guild?.id, {
          voiceChannelId: queue.voiceChannel?.id || null,
          textChannelId: queue.textChannel?.id || null,
          nowPlaying: null,
          queued: [],
          updatedAt: Date.now()
        });
        queue.textChannel?.send({ embeds: [ctx.makeEmbed("Music Queue", "Queue finished.", "info")] }).catch(() => {});
      })
      .on("error", (channel, error) => {
        channel?.send({ embeds: [ctx.makeEmbed("Music Error", String(error?.message || error || "Unknown music error"), "error")] }).catch(() => {});
      });
  }

  const profileFlushTimer = setInterval(() => {
    flushProfilesNow();
  }, 30000);
  if (typeof profileFlushTimer.unref === "function") profileFlushTimer.unref();

  const timer = setInterval(() => {
    maybeRunReminders(client, ctx).catch(() => {});
    maybeRunSchedules(client, ctx).catch(() => {});
  }, 15000);
  if (typeof timer.unref === "function") timer.unref();
}

function checkScamPattern(message, settings) {
  if (settings.scamProtection?.enabled === false) return null;
  const text = String(message.content || "").toLowerCase();
  if (!text) return null;

  const fakeGiveaway = /(?:free\s+nitro|steam\s+gift|claim\s+prize|instant\s+winner)/i.test(text) && /https?:\/\//i.test(text);
  const fakeStaff = /(i\s*am\s*staff|official\s*support|discord\s*admin)/i.test(text) && /dm\s*me|send\s*me/i.test(text);
  if (fakeGiveaway || fakeStaff) {
    return fakeGiveaway ? "Possible fake giveaway scam pattern" : "Possible fake staff impersonation pattern";
  }
  return null;
}

function parseTicketTopicValue(channel, key) {
  const topic = String(channel?.topic || "");
  const safeKey = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = topic.match(new RegExp(`${safeKey}:([a-zA-Z0-9_-]{1,50})`, "i"));
  return m ? String(m[1]) : null;
}

function ensureTicketMeta(all, guildId, channel) {
  if (!all[guildId]) all[guildId] = {};
  const ownerId = parseTicketTopicValue(channel, "owner");
  const ticketType = (parseTicketTopicValue(channel, "type") || "support").toLowerCase();
  all[guildId][channel.id] = all[guildId][channel.id] || {
    ownerId: ownerId || null,
    ticketType,
    status: "open",
    priority: "normal",
    openedAt: channel?.createdTimestamp || Date.now(),
    panelMessageId: null,
    claimedBy: null,
    claimedAt: null,
    claimHistory: [],
    reopenHistory: [],
    notes: [],
    closeHistory: [],
    actionHistory: []
  };
  const meta = all[guildId][channel.id];
  if (!meta.ownerId && ownerId) meta.ownerId = ownerId;
  if (!meta.ticketType && ticketType) meta.ticketType = ticketType;
  if (!meta.status) meta.status = "open";
  if (!meta.priority) meta.priority = "normal";
  if (!Array.isArray(meta.claimHistory)) meta.claimHistory = [];
  if (!Array.isArray(meta.reopenHistory)) meta.reopenHistory = [];
  if (!Array.isArray(meta.notes)) meta.notes = [];
  if (!Array.isArray(meta.closeHistory)) meta.closeHistory = [];
  if (!Array.isArray(meta.actionHistory)) meta.actionHistory = [];
  return meta;
}

function canForceTicketReclaim(member) {
  if (!member?.roles?.cache) return false;
  return member.roles.cache.some(role => ["Founder", "Admin", "Head Moderator"].includes(role.name));
}

function normalizeTicketPriority(raw) {
  const value = String(raw || "").toLowerCase().trim();
  if (["low", "normal", "high", "urgent"].includes(value)) return value;
  return null;
}

function formatTicketPriority(priority) {
  const p = normalizeTicketPriority(priority) || "normal";
  return p[0].toUpperCase() + p.slice(1);
}

function buildTicketControls(meta) {
  const isClosed = String(meta.status || "open") === "closed";
  const priorityLabel = `Priority: ${formatTicketPriority(meta.priority)}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("claim_ticket").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary).setDisabled(isClosed),
    new ButtonBuilder().setCustomId("unclaim_ticket").setLabel("Unclaim").setStyle(ButtonStyle.Secondary).setDisabled(isClosed),
    new ButtonBuilder().setCustomId("close_ticket_button").setLabel("Close Ticket").setStyle(ButtonStyle.Danger).setDisabled(isClosed),
    new ButtonBuilder().setCustomId("reopen_ticket").setLabel("Reopen Ticket").setStyle(ButtonStyle.Success).setDisabled(!isClosed),
    new ButtonBuilder().setCustomId("delete_ticket_button").setLabel("Delete Ticket").setStyle(ButtonStyle.Danger).setDisabled(!isClosed)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_priority_cycle").setLabel(priorityLabel).setStyle(ButtonStyle.Secondary).setDisabled(isClosed)
  );
  return [row, row2];
}

function hasTicketTranscript(index, guildId, channelId) {
  return index.some(x => x.guildId === guildId && x.channelId === channelId);
}

async function ensureTranscriptBeforeDelete(interaction, ctx, meta, source = "delete-button") {
  const index = load("transcriptIndex", []);
  const alreadySaved = hasTicketTranscript(index, interaction.guild.id, interaction.channel.id);
  if (alreadySaved) return false;

  const messages = await interaction.channel.messages.fetch({ limit: 250 }).catch(() => null);
  const orderedMessages = [...(messages?.values() || [])].reverse();
  const transcriptInfo = await ctx.sendTranscript(interaction.guild, interaction.channel, orderedMessages, {
    ticketOwnerId: meta.ownerId || null,
    ticketType: meta.ticketType || "support",
    ticketStatus: meta.status || "closed",
    priority: meta.priority || "normal",
    claimedBy: meta.claimedBy || null,
    closedBy: meta.closedBy || interaction.user.id,
    closeReason: meta.closeReason || "No reason provided",
    messageCount: orderedMessages.length
  });

  index.push({
    guildId: interaction.guild.id,
    channelId: interaction.channel.id,
    channelName: interaction.channel.name,
    ticketOwnerId: meta.ownerId || null,
    ticketType: meta.ticketType || "support",
    status: meta.status || "closed",
    priority: meta.priority || "normal",
    claimedBy: meta.claimedBy || null,
    time: Date.now(),
    closedBy: meta.closedBy || interaction.user.id,
    reason: meta.closeReason || "Deleted after closure",
    source,
    transcriptFile: transcriptInfo?.fileName || null,
    preview: orderedMessages.map(m => m.content || "").join(" ").slice(0, 350)
  });
  save("transcriptIndex", index.slice(-5000));
  return true;
}

async function deleteClosedTicket(interaction, ctx, source = "delete-button-confirm") {
  if (!ctx.isTicketChannel(interaction.channel)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
    return true;
  }

  const all = load("ticketMeta", {});
  const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
  if (meta.status !== "closed") {
    await interaction.reply({ embeds: [ctx.makeEmbed("Close First", "Close the ticket before deleting it.", "warn")], ephemeral: true });
    return true;
  }

  const inflightKey = `${interaction.guild.id}:${interaction.channel.id}`;
  if (ticketDeleteInFlight.has(inflightKey)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Please Wait", "Ticket deletion is already in progress.", "info")], ephemeral: true });
    return true;
  }
  ticketDeleteInFlight.set(inflightKey, Date.now());

  try {
    const createdTranscript = await ensureTranscriptBeforeDelete(interaction, ctx, meta, source);
    const now = Date.now();
    meta.deletedAt = now;
    meta.deletedBy = interaction.user.id;
    meta.actionHistory.push({ action: "delete", by: interaction.user.id, at: now, source, transcriptCreated: createdTranscript });
    save("ticketMeta", all);

    await interaction.reply({ embeds: [ctx.makeEmbed("Deleting Ticket", "Ticket will be deleted in 4 seconds.", "warn")] });
    await ctx.sendTypedLog(interaction.guild, "moderation", "Ticket Deleted", `${interaction.user.tag} deleted ${interaction.channel.name}.`, "warn", [
      { name: "Status", value: String(meta.status || "closed").toUpperCase(), inline: true },
      { name: "Priority", value: formatTicketPriority(meta.priority), inline: true },
      { name: "Transcript", value: createdTranscript ? "Saved before delete" : "Already saved", inline: true }
    ]);

    setTimeout(() => interaction.channel.delete().catch(() => {}), 4000);
    return true;
  } finally {
    setTimeout(() => ticketDeleteInFlight.delete(inflightKey), 10000);
  }
}

function buildTicketStatusEmbed(ctx, interaction, meta) {
  const status = String(meta.status || "open");
  const openedAt = Number(meta.openedAt || interaction.channel?.createdTimestamp || Date.now());
  return ctx.makeEmbed("Ticket Control Panel", [
    `Status: **${status.toUpperCase()}**`,
    `Priority: **${formatTicketPriority(meta.priority)}**`,
    `Owner: ${meta.ownerId ? `<@${meta.ownerId}>` : "Unknown"}`,
    `Claimed By: ${meta.claimedBy ? `<@${meta.claimedBy}>` : "Unclaimed"}`,
    `Type: **${meta.ticketType || "support"}**`,
    `Opened: <t:${Math.floor(openedAt / 1000)}:R>`
  ].join("\n"), status === "closed" ? "warn" : "info");
}

async function syncTicketPanel(interaction, ctx, meta, all = null) {
  const guildId = interaction.guild.id;
  const payload = {
    embeds: [buildTicketStatusEmbed(ctx, interaction, meta)],
    components: buildTicketControls(meta)
  };
  if (!meta.panelMessageId) {
    const recent = await interaction.channel.messages.fetch({ limit: 25 }).catch(() => null);
    const panel = recent?.find(m => m.author?.id === interaction.client.user.id && m.components?.length);
    if (panel) meta.panelMessageId = panel.id;
  }
  if (!meta.panelMessageId) {
    const sent = await interaction.channel.send(payload).catch(() => null);
    if (sent) meta.panelMessageId = sent.id;
    return;
  }
  const panel = await interaction.channel.messages.fetch(meta.panelMessageId).catch(() => null);
  if (panel) {
    await panel.edit(payload).catch(() => {});
    return;
  }
  const sent = await interaction.channel.send(payload).catch(() => null);
  if (sent) meta.panelMessageId = sent.id;
  if (all) save("ticketMeta", all);
}

async function claimTicket(interaction, ctx, source = "unknown", targetUserId = null) {
  if (!ctx.isTicketChannel(interaction.channel)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
    return true;
  }
  const all = load("ticketMeta", {});
  const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
  if (!Array.isArray(meta.claimHistory)) meta.claimHistory = [];
  const targetId = targetUserId || interaction.user.id;
  if (targetId !== interaction.user.id && !canForceTicketReclaim(interaction.member)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only Head Moderator+ can assign a ticket to someone else.", "error")], ephemeral: true });
    return true;
  }
  if (targetId !== interaction.user.id) {
    const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
    const targetCanManage = targetMember
      ? (typeof ctx.canManageTicketsCommand === "function" ? ctx.canManageTicketsCommand(targetMember) : ctx.canUseModCommand(targetMember))
      : false;
    if (!targetCanManage) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Invalid Staff Target", "You can only assign tickets to ticket staff.", "error")], ephemeral: true });
      return true;
    }
  }
  const previousClaimedBy = meta.claimedBy || null;
  if (previousClaimedBy === targetId) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Already Claimed", "You already claimed this ticket.", "info")], ephemeral: true });
    return true;
  }
  if (previousClaimedBy && previousClaimedBy !== interaction.user.id && !canForceTicketReclaim(interaction.member)) {
    await interaction.reply({
      embeds: [ctx.makeEmbed("Already Claimed", `This ticket is already claimed by <@${previousClaimedBy}>. Ask a Head Moderator+ to reassign it.`, "warn")],
      ephemeral: true
    });
    return true;
  }

  const now = Date.now();
  meta.claimedBy = targetId;
  meta.claimedAt = now;
  meta.claimHistory.push({
    by: interaction.user.id,
    from: previousClaimedBy,
    to: targetId,
    at: now,
    source
  });
  meta.actionHistory.push({
    action: previousClaimedBy ? "reassign" : "claim",
    by: interaction.user.id,
    target: targetId,
    from: previousClaimedBy,
    at: now,
    source
  });
  meta.status = "open";
  save("ticketMeta", all);
  await syncTicketPanel(interaction, ctx, meta, all);
  bumpStaffActivity(interaction.guild.id, interaction.user.id);

  if (previousClaimedBy && previousClaimedBy !== interaction.user.id) {
    await interaction.reply({
      embeds: [ctx.makeEmbed("Ticket Reassigned", `${interaction.user} reassigned this ticket from <@${previousClaimedBy}> to <@${targetId}>.`, "warn")]
    });
    await ctx.sendTypedLog(
      interaction.guild,
      "moderation",
      "Ticket Reassigned",
      `${interaction.user.tag} reassigned ${interaction.channel.name}.`,
      "warn",
      [
        { name: "From", value: `<@${previousClaimedBy}>`, inline: true },
        { name: "To", value: `<@${targetId}>`, inline: true }
      ]
    );
    return true;
  }

  const claimText = targetId === interaction.user.id
    ? `${interaction.user} claimed this ticket.`
    : `${interaction.user} assigned this ticket to <@${targetId}>.`;
  await interaction.reply({ embeds: [ctx.makeEmbed("Ticket Claimed", claimText, "success")] });
  await ctx.sendTypedLog(interaction.guild, "moderation", "Ticket Claimed", `${interaction.user.tag} claimed ${interaction.channel.name}.`, "info", [
    { name: "Assigned To", value: `<@${targetId}>`, inline: true }
  ]);
  return true;
}

async function unclaimTicket(interaction, ctx, source = "unknown") {
  if (!ctx.isTicketChannel(interaction.channel)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
    return true;
  }
  const all = load("ticketMeta", {});
  const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
  const previousClaimedBy = meta.claimedBy || null;
  if (!previousClaimedBy) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Already Unclaimed", "This ticket is currently unclaimed.", "info")], ephemeral: true });
    return true;
  }
  if (previousClaimedBy !== interaction.user.id && !canForceTicketReclaim(interaction.member)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only the claimer or Head Moderator+ can unclaim this ticket.", "error")], ephemeral: true });
    return true;
  }
  const now = Date.now();
  meta.claimedBy = null;
  meta.claimedAt = null;
  meta.claimHistory.push({ by: interaction.user.id, from: previousClaimedBy, to: null, at: now, source });
  meta.actionHistory.push({ action: "unclaim", by: interaction.user.id, from: previousClaimedBy, at: now, source });
  save("ticketMeta", all);
  await syncTicketPanel(interaction, ctx, meta, all);
  bumpStaffActivity(interaction.guild.id, interaction.user.id);
  await interaction.reply({ embeds: [ctx.makeEmbed("Ticket Unclaimed", `${interaction.user} unclaimed this ticket.`, "info")] });
  await ctx.sendTypedLog(interaction.guild, "moderation", "Ticket Unclaimed", `${interaction.user.tag} unclaimed ${interaction.channel.name}.`, "info", [
    { name: "Previous Claimer", value: `<@${previousClaimedBy}>`, inline: true }
  ]);
  return true;
}

async function setTicketPriority(interaction, ctx, nextPriority, source = "unknown") {
  if (!ctx.isTicketChannel(interaction.channel)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
    return true;
  }
  const all = load("ticketMeta", {});
  const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
  const normalized = normalizeTicketPriority(nextPriority);
  if (!normalized) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Invalid Priority", "Use `low`, `normal`, `high`, or `urgent`.", "error")], ephemeral: true });
    return true;
  }
  if (normalized === meta.priority) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Priority Unchanged", `Priority is already **${formatTicketPriority(normalized)}**.`, "info")], ephemeral: true });
    return true;
  }
  const previous = meta.priority;
  meta.priority = normalized;
  meta.actionHistory.push({ action: "priority", by: interaction.user.id, from: previous, to: normalized, at: Date.now(), source });
  save("ticketMeta", all);
  await syncTicketPanel(interaction, ctx, meta, all);
  await interaction.reply({ embeds: [ctx.makeEmbed("Priority Updated", `Priority changed from **${formatTicketPriority(previous)}** to **${formatTicketPriority(normalized)}**.`, "success")], ephemeral: true });
  await ctx.sendTypedLog(interaction.guild, "moderation", "Ticket Priority Updated", `${interaction.user.tag} changed ${interaction.channel.name} priority.`, "info", [
    { name: "From", value: formatTicketPriority(previous), inline: true },
    { name: "To", value: formatTicketPriority(normalized), inline: true }
  ]);
  return true;
}

async function closeTicket(interaction, ctx, options = {}) {
  if (!ctx.isTicketChannel(interaction.channel)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
    return true;
  }
  const reason = String(options.reason || "No reason provided").slice(0, 700);
  const source = options.source || "unknown";
  const hardDelete = options.hardDelete === true;
  const all = load("ticketMeta", {});
  const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
  if (meta.status === "closed" && !hardDelete) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Already Closed", "This ticket is already closed. Use reopen if needed.", "info")], ephemeral: true });
    return true;
  }

  const messages = await interaction.channel.messages.fetch({ limit: 250 }).catch(() => null);
  const orderedMessages = [...(messages?.values() || [])].reverse();
  const closedAt = Date.now();
  meta.status = "closed";
  meta.closedAt = closedAt;
  meta.closedBy = interaction.user.id;
  meta.closeReason = reason;
  meta.closeHistory.push({ by: interaction.user.id, reason, at: closedAt, source, hardDelete });
  meta.actionHistory.push({ action: "close", by: interaction.user.id, reason, at: closedAt, source, hardDelete });
  save("ticketMeta", all);

  const transcriptInfo = await ctx.sendTranscript(interaction.guild, interaction.channel, orderedMessages, {
    ticketOwnerId: meta.ownerId || null,
    ticketType: meta.ticketType || "support",
    ticketStatus: meta.status,
    priority: meta.priority || "normal",
    claimedBy: meta.claimedBy || null,
    closedBy: interaction.user.id,
    closeReason: reason,
    messageCount: orderedMessages.length
  });

  const index = load("transcriptIndex", []);
  index.push({
    guildId: interaction.guild.id,
    channelId: interaction.channel.id,
    channelName: interaction.channel.name,
    ticketOwnerId: meta.ownerId || null,
    ticketType: meta.ticketType || "support",
    status: meta.status,
    priority: meta.priority || "normal",
    claimedBy: meta.claimedBy || null,
    time: closedAt,
    closedBy: interaction.user.id,
    reason,
    source,
    transcriptFile: transcriptInfo?.fileName || null,
    preview: orderedMessages.map(m => m.content || "").join(" ").slice(0, 350)
  });
  save("transcriptIndex", index.slice(-5000));

  if (meta.ownerId) {
    await interaction.channel.permissionOverwrites.edit(meta.ownerId, {
      SendMessages: false,
      AddReactions: false
    }).catch(() => {});
  }

  if (!hardDelete) {
    if (!String(interaction.channel.name || "").startsWith("closed-")) {
      const trimmed = String(interaction.channel.name || "ticket").slice(0, 92);
      await interaction.channel.setName(`closed-${trimmed}`).catch(() => {});
    }
    await syncTicketPanel(interaction, ctx, meta, all);
    await interaction.reply({ embeds: [ctx.makeEmbed("Ticket Closed", `Reason: ${reason}\nThis ticket is now archived. Use \`/ticket reopen\` to reopen.`, "warn")] });
  } else {
    await interaction.reply({ embeds: [ctx.makeEmbed("Closing Ticket", `Reason: ${reason}\nDeleting in 5 seconds.`, "warn")] });
  }

  await ctx.sendTypedLog(interaction.guild, "moderation", "Ticket Closed", `${interaction.user.tag} closed ${interaction.channel.name}.`, "warn", [
    { name: "Reason", value: reason },
    { name: "Mode", value: hardDelete ? "hard-delete" : "archive", inline: true },
    { name: "Priority", value: formatTicketPriority(meta.priority), inline: true }
  ]);

  if (hardDelete) {
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }
  return true;
}

async function reopenTicket(interaction, ctx, source = "unknown") {
  if (!ctx.isTicketChannel(interaction.channel)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
    return true;
  }
  const all = load("ticketMeta", {});
  const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
  if (meta.status !== "closed") {
    await interaction.reply({ embeds: [ctx.makeEmbed("Not Closed", "This ticket is already open.", "info")], ephemeral: true });
    return true;
  }
  meta.status = "open";
  meta.reopenHistory.push({ by: interaction.user.id, at: Date.now(), source });
  meta.actionHistory.push({ action: "reopen", by: interaction.user.id, at: Date.now(), source });
  save("ticketMeta", all);

  if (meta.ownerId) {
    await interaction.channel.permissionOverwrites.edit(meta.ownerId, {
      SendMessages: true,
      AddReactions: true,
      AttachFiles: true
    }).catch(() => {});
  }
  if (String(interaction.channel.name || "").startsWith("closed-")) {
    await interaction.channel.setName(String(interaction.channel.name).replace(/^closed-/, "")).catch(() => {});
  }
  await syncTicketPanel(interaction, ctx, meta, all);
  await interaction.reply({ embeds: [ctx.makeEmbed("Ticket Reopened", `${interaction.user} reopened this ticket.`, "success")] });
  await ctx.sendTypedLog(interaction.guild, "moderation", "Ticket Reopened", `${interaction.user.tag} reopened ${interaction.channel.name}.`, "success");
  return true;
}

async function showTicketStatus(interaction, ctx) {
  if (!ctx.isTicketChannel(interaction.channel)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
    return true;
  }
  const all = load("ticketMeta", {});
  const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
  const closedAt = meta.closedAt ? `<t:${Math.floor(Number(meta.closedAt) / 1000)}:R>` : "n/a";
  const text = [
    `Status: **${String(meta.status || "open").toUpperCase()}**`,
    `Priority: **${formatTicketPriority(meta.priority)}**`,
    `Owner: ${meta.ownerId ? `<@${meta.ownerId}>` : "Unknown"}`,
    `Claimed By: ${meta.claimedBy ? `<@${meta.claimedBy}>` : "Unclaimed"}`,
    `Opened: <t:${Math.floor(Number(meta.openedAt || interaction.channel.createdTimestamp || Date.now()) / 1000)}:R>`,
    `Last Closed: ${closedAt}`,
    `Notes: **${meta.notes.length}**`,
    `Claim Actions: **${meta.claimHistory.length}**`
  ].join("\n");
  await interaction.reply({ embeds: [ctx.makeEmbed("Ticket Status", text, "info")] });
  return true;
}

async function showTicketHistory(interaction, ctx) {
  if (!ctx.isTicketChannel(interaction.channel)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
    return true;
  }
  const all = load("ticketMeta", {});
  const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
  const rows = (meta.actionHistory || [])
    .slice(-20)
    .reverse()
    .map(item => {
      const when = `<t:${Math.floor(Number(item.at || Date.now()) / 1000)}:R>`;
      const by = item.by ? `<@${item.by}>` : "Unknown";
      const detail = item.reason ? ` - ${String(item.reason).slice(0, 80)}` : "";
      return `${when} - **${String(item.action || "action")}** by ${by}${detail}`;
    });
  await interaction.reply({ embeds: [ctx.makeEmbed("Ticket History", rows.length ? rows.join("\n") : "No ticket history yet.", "info")], ephemeral: true });
  return true;
}

async function listTickets(interaction, ctx, keyword = "") {
  const all = load("ticketMeta", {});
  const guildMeta = all[interaction.guild.id] || {};
  const search = String(keyword || "").toLowerCase().trim();
  const rows = Object.entries(guildMeta)
    .map(([channelId, meta]) => ({ channelId, meta: meta || {}, channel: interaction.guild.channels.cache.get(channelId) }))
    .filter(item => item.channel)
    .filter(item => {
      if (!search) return true;
      const ownerHit = String(item.meta.ownerId || "").includes(search);
      const channelHit = String(item.channel.name || "").toLowerCase().includes(search);
      return ownerHit || channelHit;
    })
    .sort((a, b) => Number(b.meta.openedAt || 0) - Number(a.meta.openedAt || 0))
    .slice(0, 20);
  const text = rows.length
    ? rows.map(item => `${item.channel} - ${String(item.meta.status || "open").toUpperCase()} - ${formatTicketPriority(item.meta.priority)} - ${item.meta.claimedBy ? `claimed by <@${item.meta.claimedBy}>` : "unclaimed"}`).join("\n")
    : "No ticket channels found.";
  await interaction.reply({ embeds: [ctx.makeEmbed("Ticket List", text, "info")], ephemeral: true });
  return true;
}

async function handleMessageCreate(message, ctx) {
  if (!message.guild || message.author.bot) return { stop: false };
  const guildId = message.guild.id;
  const settings = getGuildSettings(guildId);

  const afkProfile = profile(guildId, message.author.id);
  if (afkProfile.afk) {
    updateProfile(guildId, message.author.id, p => {
      p.afk = null;
    });
    await message.reply({ embeds: [ctx.makeEmbed("Welcome Back", "AFK removed automatically.", "success")] }).catch(() => {});
  }

  for (const [, user] of message.mentions.users) {
    const mentioned = profile(guildId, user.id);
    if (mentioned.afk) {
      await message.reply({ embeds: [ctx.makeEmbed("AFK Notice", `${user.tag} is AFK: ${mentioned.afk.reason}\nSet <t:${Math.floor(mentioned.afk.setAt / 1000)}:R>`, "info")] }).catch(() => {});
      if (ctx.governance) ctx.governance.incrementAnalytics(guildId, "afkMentions", 1);
      break;
    }
  }

  if (settings.mediaOnlyChannels?.includes(message.channelId) && !ctx.canUseModCommand(message.member)) {
    const hasMedia = (message.attachments?.size || 0) > 0 || /https?:\/\/\S+\.(png|jpe?g|gif|webp|mp4|mov|webm)/i.test(message.content || "");
    if (!hasMedia) {
      await message.delete().catch(() => {});
      await ctx.sendTypedLog(message.guild, "moderation", "Media-Only Enforcement", `${message.author.tag} posted non-media in ${message.channel}.`, "warn");
      return { stop: true };
    }
  }

  const stickyCfg = settings.sticky?.[message.channelId];
  if (stickyCfg?.text) {
    const key = `${guildId}:${message.channelId}`;
    const now = Date.now();
    const last = stickyCooldown.get(key) || 0;
    const cooldownMs = Math.max(15000, stickyCfg.cooldownMs || 60000);
    if (now - last >= cooldownMs) {
      stickyCooldown.set(key, now);
      const sent = await message.channel.send({ embeds: [ctx.makeEmbed("Sticky", stickyCfg.text, "info")] }).catch(() => null);
      if (sent) {
        setGuildSettings(guildId, g => {
          g.sticky = g.sticky || {};
          g.sticky[message.channelId] = { ...stickyCfg, messageId: sent.id, lastSentAt: now };
        });
      }
    }
  }

  if (settings.leveling?.enabled !== false) {
    const cooldownKey = `${guildId}:${message.author.id}`;
    const now = Date.now();
    const last = xpCooldown.get(cooldownKey) || 0;
    if (now - last >= 25000) {
      xpCooldown.set(cooldownKey, now);
      const gain = randomXp(settings.leveling.xpMin || 10, settings.leveling.xpMax || 20);
      const p = updateProfile(guildId, message.author.id, item => {
        item.xp = (item.xp || 0) + gain;
        item.currency = (item.currency || 0) + Math.max(1, Math.floor(gain / 4));
        item.level = levelFromXp(item.xp);
      });
      const previousLevel = levelFromXp((p.xp || 0) - gain);
      if (p.level > previousLevel) {
        const rewardRoleId = settings.leveling?.rewards?.[String(p.level)] || null;
        if (rewardRoleId && message.member?.roles?.add) {
          await message.member.roles.add(rewardRoleId).catch(() => {});
        }
        await message.channel.send({ embeds: [ctx.makeEmbed("Level Up", `${message.author} reached level **${p.level}**.`, "success")] }).catch(() => {});
      }
    }
  }

  const scamHit = checkScamPattern(message, settings);
  if (scamHit) {
    await ctx.sendTypedLog(message.guild, "security", "Scam Pattern Flag", `${message.author.tag}: ${scamHit}`, "warn", [
      { name: "Channel", value: `${message.channel}`, inline: true },
      { name: "Message", value: (message.content || "[no text]").slice(0, 1000) }
    ]);
    if (ctx.governance) ctx.governance.adjustRisk(guildId, message.author.id, 4, "scam-pattern");
  }

  const sbWindowKey = `${guildId}:${message.author.id}`;
  const history = (selfbotWindow.get(sbWindowKey) || []).filter(x => Date.now() - x < 6000);
  history.push(Date.now());
  selfbotWindow.set(sbWindowKey, history);
  if (settings.selfbot?.enabled !== false && history.length >= 12 && !ctx.canUseModCommand(message.member)) {
    await ctx.sendTypedLog(message.guild, "security", "Selfbot-Like Activity", `${message.author.tag} sent ${history.length} messages in under 6s.`, "warn");
    if (ctx.governance) ctx.governance.adjustRisk(guildId, message.author.id, 3, "selfbot-rate");
  }

  return { stop: false };
}

async function handleMessageDelete(message, ctx) {
  if (!message.guild || !message.author || message.author.bot) return;
  const mentions = message.mentions?.users?.size || 0;
  if (!mentions) return;
  const ageMs = Date.now() - (message.createdTimestamp || Date.now());
  if (ageMs > 120000) return;

  const logs = load("ghostPings", []);
  logs.push({
    guildId: message.guild.id,
    channelId: message.channel.id,
    userId: message.author.id,
    content: (message.content || "").slice(0, 1000),
    mentions,
    time: Date.now()
  });
  while (logs.length > 5000) logs.shift();
  save("ghostPings", logs);

  await ctx.sendTypedLog(message.guild, "message", "Ghost Ping Detected", `${message.author.tag} deleted a message that mentioned ${mentions} user(s).`, "warn", [
    { name: "Channel", value: `${message.channel}`, inline: true },
    { name: "Content", value: (message.content || "[empty]").slice(0, 1000) }
  ]);
}

async function handleMemberAdd(member, ctx) {
  const guildId = member.guild.id;
  const settings = getGuildSettings(guildId);
  const p = updateProfile(guildId, member.id, item => {
    item.joins = (item.joins || 0) + 1;
    item.firstJoinAt = item.firstJoinAt || Date.now();
    item.lastJoinAt = Date.now();
  });

  const returning = (p.joins || 0) > 1;
  const accountAgeHours = Math.floor((Date.now() - member.user.createdTimestamp) / (60 * 60 * 1000));
  if (settings.watchlist?.enabled !== false && accountAgeHours < (settings.watchlist?.accountAgeHours || 72)) {
    const watch = load("watchlist", []);
    watch.push({ guildId, userId: member.id, reason: `Young account (${accountAgeHours}h old)`, time: Date.now() });
    save("watchlist", watch.slice(-4000));
    await ctx.sendTypedLog(member.guild, "security", "Alt Watchlist Flag", `${member.user.tag} flagged for watchlist (account age ${accountAgeHours}h).`, "warn");
  }

  const msgTemplate = settings.welcome?.customMessage || "Welcome {user} to **{server}**!";
  const brandName = settings.welcome?.brandName || "Rift Studios";
  const welcomeImage = settings.welcome?.welcomeImage || process.env.RIFT_WELCOME_IMAGE_URL || null;
  const welcomeText = msgTemplate
    .replace(/\{user\}/g, `${member}`)
    .replace(/\{userTag\}/g, member.user.tag)
    .replace(/\{server\}/g, member.guild.name)
    .replace(/\{joinCount\}/g, String(p.joins || 1));

  const landing = ctx.getChannelByName(member.guild, ctx.currentConfig().channels.landing);
  if (landing?.isTextBased?.()) {
    const embed = ctx.makeEmbed(
      returning ? `Welcome Back to ${brandName}` : `Welcome to ${brandName}`,
      welcomeText,
      "success",
      [
        { name: "Member", value: `${member.user.tag}`, inline: true },
        { name: "Join Count", value: String(p.joins || 1), inline: true }
      ]
    );
    if (welcomeImage) embed.image = { url: welcomeImage };
    if (member.guild.iconURL?.()) embed.thumbnail = { url: member.guild.iconURL({ extension: "png", size: 256 }) };
    embed.footer = { text: `${brandName} | Welcome` };

    await landing.send({ content: `${member}`, embeds: [embed] }).catch(() => {});
    if (settings.welcome?.onboardingPrompt) {
      await landing.send({ content: `${member} ${settings.welcome.onboardingPrompt}` }).catch(() => {});
    }
  }

  for (const roleId of settings.welcome?.autoRoles || []) {
    await member.roles.add(roleId).catch(() => {});
  }

  const dmMessage = (settings.welcome?.dmMessage || "Welcome to {server}!")
    .replace(/\{server\}/g, member.guild.name)
    .replace(/\{user\}/g, member.user.tag);
  await member.send({ embeds: [ctx.makeEmbed("Welcome", dmMessage, "info")] }).catch(() => {});

  await ctx.sendTypedLog(member.guild, "member", returning ? "Returning Member" : "New Member", `${member.user.tag} joined (${p.joins} total joins).`, "info", [
    { name: "Returning", value: returning ? "Yes" : "No", inline: true }
  ]);
}

async function handleMemberRemove(member, ctx) {
  const guildId = member.guild.id;
  updateProfile(guildId, member.id, item => {
    item.lastLeaveAt = Date.now();
  });

  const settings = getGuildSettings(guildId);
  const template = settings.leave?.message || "{userTag} left {server}.";
  const text = template
    .replace(/\{user\}/g, `${member.user}`)
    .replace(/\{userTag\}/g, member.user.tag)
    .replace(/\{server\}/g, member.guild.name);

  const takeoff = ctx.getChannelByName(member.guild, ctx.currentConfig().channels.takeoff);
  if (takeoff?.isTextBased?.()) {
    await takeoff.send({ embeds: [ctx.makeEmbed("Member Left", text, "warn")] }).catch(() => {});
  }
}

async function handleReactionAdd(reaction, user, ctx) {
  if (user.bot || !reaction.message.guild) return;
  const guildId = reaction.message.guild.id;
  const roleMaps = load("reactionRoles", {});
  const byGuild = roleMaps[guildId] || {};
  const mapped = byGuild[reaction.message.id];
  if (mapped) {
    const reactionEmoji = reaction.emoji?.name || reaction.emoji?.toString?.() || "";
    if (String(mapped.emoji) === String(reactionEmoji) || String(mapped.emoji) === String(reaction.emoji?.toString?.() || "")) {
      const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
      if (member && mapped.roleId) {
        await member.roles.add(mapped.roleId).catch(() => {});
      }
    }
  }

  const settings = getGuildSettings(guildId);
  if (!settings.starboard?.enabled) return;
  const expected = settings.starboard.emoji || "⭐";
  if ((reaction.emoji?.name || "") !== expected) return;
  if ((reaction.count || 0) < (settings.starboard.threshold || 3)) return;

  const starboardChannel = reaction.message.guild.channels.cache.get(settings.starboard.channelId);
  if (!starboardChannel?.isTextBased?.()) return;

  const entries = settings.starboard.entries || {};
  if (entries[reaction.message.id]) return;

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`${expected} Starboard`)
    .setDescription(reaction.message.content?.slice(0, 3900) || "[no text]")
    .addFields(
      { name: "Author", value: `${reaction.message.author?.tag || "Unknown"}`, inline: true },
      { name: "Jump", value: `[Go to message](${reaction.message.url})`, inline: true }
    )
    .setTimestamp(new Date(reaction.message.createdTimestamp || Date.now()));

  const posted = await starboardChannel.send({ embeds: [embed] }).catch(() => null);
  if (!posted) return;

  setGuildSettings(guildId, g => {
    g.starboard = g.starboard || { enabled: true, entries: {} };
    g.starboard.entries = g.starboard.entries || {};
    g.starboard.entries[reaction.message.id] = posted.id;
  });
}

async function handleGiveawayJoin(interaction, ctx) {
  const messageId = interaction.customId.replace("join_giveaway_", "");
  const giveaways = ctx.loadGiveaways();
  const giveaway = giveaways.find(g => g.messageId === messageId);

  if (!giveaway || giveaway.ended) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Giveaway Ended", "This giveaway is no longer active.", "error")], ephemeral: true });
    return true;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return true;

  if (Number(giveaway.endsAt || 0) > 0 && Number(giveaway.endsAt) <= Date.now()) {
    await ctx.endGiveaway(giveaway.messageId).catch(() => {});
    await interaction.reply({ embeds: [ctx.makeEmbed("Giveaway Ended", "This giveaway has already ended.", "warn")], ephemeral: true });
    return true;
  }

  for (const roleId of giveaway.requiredRoleIds || []) {
    if (!member.roles.cache.has(roleId)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Requirement Missing", `You need <@&${roleId}> to join this giveaway.`, "warn")], ephemeral: true });
      return true;
    }
  }
  for (const roleId of giveaway.blacklistRoleIds || []) {
    if (member.roles.cache.has(roleId)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Blacklisted", "You are not eligible for this giveaway.", "error")], ephemeral: true });
      return true;
    }
  }

  if (giveaway.entries.includes(interaction.user.id)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Already Entered", "You already joined this giveaway.", "warn")], ephemeral: true });
    return true;
  }

  giveaway.entries.push(interaction.user.id);
  giveaway.entryCounts = giveaway.entryCounts || {};
  giveaway.entrySnapshots = giveaway.entrySnapshots || {};
  let totalEntries = 1;
  for (const bonus of giveaway.bonusEntries || []) {
    if (member.roles.cache.has(bonus.roleId)) {
      totalEntries += Math.max(0, Number(bonus.entries) || 0);
    }
  }
  giveaway.entryCounts[interaction.user.id] = Math.max(1, totalEntries);
  giveaway.entrySnapshots[interaction.user.id] = {
    joinedAt: Date.now(),
    entries: giveaway.entryCounts[interaction.user.id]
  };
  ctx.saveGiveaways(giveaways);

  const msg = await interaction.channel.messages.fetch(messageId).catch(() => null);
  if (msg) {
    await msg.edit({
      embeds: [ctx.makeEmbed("🎉 Giveaway Started", formatGiveawaySummary(giveaway), "info")],
      components: msg.components
    }).catch(() => {});
  }

  await interaction.reply({ embeds: [ctx.makeEmbed("Entry Confirmed", `You joined the giveaway with **${Math.max(1, totalEntries)}** entr${totalEntries === 1 ? "y" : "ies"}.`, "success")], ephemeral: true });
  return true;
}

async function handleCommand(interaction, ctx) {
  if (!interaction.guild || !interaction.isChatInputCommand()) return false;

  const maintenance = isInMaintenance(interaction, ctx);
  if (maintenance && !["maintenance", "serverstatus", "auditdashboard"].includes(interaction.commandName)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Maintenance Mode", maintenance, "warn")], ephemeral: true });
    return true;
  }

  const blocked = runCommandControl(interaction);
  if (blocked && !["commandcontrol", "help"].includes(interaction.commandName)) {
    await interaction.reply({ embeds: [ctx.makeEmbed("Command Restricted", blocked, "warn")], ephemeral: true });
    return true;
  }

  const cmd = interaction.commandName;
  const guildId = interaction.guild.id;
  const settings = getGuildSettings(guildId);

  if (cmd === "help") {
    const search = String(interaction.options.getString("search") || "").toLowerCase();
    const list = ctx.commands
      .filter(c => !search || c.name.includes(search) || String(c.description || "").toLowerCase().includes(search))
      .map(c => `/${c.name} - ${c.description}`)
      .slice(0, 40)
      .join("\n") || "No commands found.";
    await interaction.reply({ embeds: [ctx.makeEmbed("Help", list, "info")], ephemeral: true });
    return true;
  }

  if (cmd === "close") {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can close tickets.", "error")], ephemeral: true });
      return true;
    }
    const reason = interaction.options.getString("reason") || "Closed via /close";
    return closeTicket(interaction, ctx, { reason, source: "slash-close", hardDelete: true });
  }
  if (cmd === "giveaway") {
    const duration = interaction.options.getString("duration");
    const prize = interaction.options.getString("prize");
    const durationMs = parseDurationExtended(duration);
    if (!durationMs) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Error", "Use a valid duration like 10m, 1h, 7d, or 1mo.", "error")], ephemeral: true });
      return true;
    }

    const winners = Math.max(1, Math.min(10, interaction.options.getInteger("winners") || 1));
    const requiredRole = interaction.options.getRole("required_role");
    const blacklistRole = interaction.options.getRole("blacklist_role");
    const bonusRole = interaction.options.getRole("bonus_role");
    const bonusEntries = Math.max(0, Math.min(20, interaction.options.getInteger("bonus_entries") || 0));
    const endsAt = Date.now() + durationMs;

    const sent = await interaction.channel.send({
      embeds: [ctx.makeEmbed("🎉 Giveaway Started", "Preparing giveaway...", "info")]
    });

    const giveaway = {
      messageId: sent.id,
      channelId: interaction.channelId,
      guildId,
      hostId: interaction.user.id,
      prize,
      endsAt,
      winners,
      requiredRoleIds: requiredRole ? [requiredRole.id] : [],
      blacklistRoleIds: blacklistRole ? [blacklistRole.id] : [],
      bonusEntries: bonusRole && bonusEntries > 0 ? [{ roleId: bonusRole.id, entries: bonusEntries }] : [],
      entries: [],
      entryCounts: {},
      entrySnapshots: {},
      ended: false,
      createdAt: Date.now(),
      winnerId: null,
      winnerIds: [],
      rerollHistory: []
    };

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join_giveaway_${sent.id}`).setLabel("Join Giveaway").setStyle(ButtonStyle.Success)
    );

    await sent.edit({
      embeds: [ctx.makeEmbed("🎉 Giveaway Started", formatGiveawaySummary(giveaway), "info")],
      components: [row]
    }).catch(() => {});

    const giveaways = ctx.loadGiveaways();
    giveaways.push(giveaway);
    ctx.saveGiveaways(giveaways);
    ctx.scheduleGiveaway(giveaway);

    await interaction.reply({ embeds: [ctx.makeEmbed("Giveaway Created", `Posted in ${interaction.channel}.`, "success")], ephemeral: true });
    await ctx.sendLog(interaction.guild, "Giveaway Created", `${interaction.user.tag} created giveaway ${sent.id}.`, "info", [
      { name: "Prize", value: prize, inline: true },
      { name: "Winners", value: String(winners), inline: true }
    ]);
    if (ctx.governance) ctx.governance.incrementAnalytics(guildId, "giveawaysCreated", 1);
    return true;
  }

  if (cmd === "reroll") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can reroll giveaways.", "error")], ephemeral: true });
      return true;
    }
    const messageId = interaction.options.getString("messageid");
    const giveaways = ctx.loadGiveaways();
    const giveaway = giveaways.find(g => g.messageId === messageId);
    if (!giveaway) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Error", "Giveaway not found.", "error")], ephemeral: true });
      return true;
    }
    if (!giveaway.entries?.length) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Error", "No entries to reroll.", "error")], ephemeral: true });
      return true;
    }

    if (!giveaway.ended) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Giveaway Active", "End the giveaway before rerolling so results stay fair.", "warn")], ephemeral: true });
      return true;
    }

    const previousWinners = new Set((giveaway.winnerIds || []).map(String));
    let winners = typeof ctx.pickGiveawayWinners === "function"
      ? ctx.pickGiveawayWinners(giveaway, interaction.guild, { excludeUserIds: [...previousWinners] })
      : pickWinners(giveaway, interaction.guild, { excludeUserIds: [...previousWinners] });
    if (!winners.length) {
      winners = typeof ctx.pickGiveawayWinners === "function"
        ? ctx.pickGiveawayWinners(giveaway, interaction.guild)
        : pickWinners(giveaway, interaction.guild);
    }

    giveaway.winnerIds = winners;
    giveaway.winnerId = winners[0] || null;
    giveaway.rerollHistory = giveaway.rerollHistory || [];
    giveaway.rerollHistory.push({ by: interaction.user.id, at: Date.now(), winners, previousWinners: [...previousWinners] });
    ctx.saveGiveaways(giveaways);

    await interaction.channel.send({
      embeds: [ctx.makeEmbed("Giveaway Rerolled", `Winners: ${winners.map(id => `<@${id}>`).join(", ") || "none"}`, "success")]
    });
    if (typeof ctx.notifyGiveawayWinners === "function") {
      await ctx.notifyGiveawayWinners(interaction.guild, giveaway, winners, {
        source: "reroll",
        actorId: interaction.user.id
      }).catch(() => {});
      ctx.saveGiveaways(giveaways);
    }
    await interaction.reply({ embeds: [ctx.makeEmbed("Rerolled", "New winners selected.", "success")], ephemeral: true });
    await ctx.sendTypedLog(interaction.guild, "moderation", "Giveaway Reroll", `${interaction.user.tag} rerolled giveaway ${messageId}.`, "info");
    return true;
  }
  if (cmd === "giveawaymanage") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can manage giveaways.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    const messageId = interaction.options.getString("messageid");
    const giveaways = ctx.loadGiveaways();
    const g = giveaways.find(x => x.messageId === messageId);
    if (!g) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Not Found", "Giveaway not found.", "error")], ephemeral: true });
      return true;
    }
    if (action === "info") {
      const rerolls = (g.rerollHistory || []).slice(-5).map(r => `<t:${Math.floor(r.at / 1000)}:R> by <@${r.by}>`).join("\n") || "None";
      await interaction.reply({ embeds: [ctx.makeEmbed("Giveaway Info", `${formatGiveawaySummary(g)}\n\n**Reroll History**\n${rerolls}`, "info")] });
      return true;
    }
    if (action === "end") {
      await ctx.endGiveaway(messageId);
      await interaction.reply({ embeds: [ctx.makeEmbed("Giveaway Ended", `Giveaway ${messageId} ended.`, "success")], ephemeral: true });
      return true;
    }
    return false;
  }

  if (cmd === "ticket") {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can manage tickets.", "error")], ephemeral: true });
      return true;
    }

    const action = String(interaction.options.getString("action") || "").toLowerCase();
    const reason = interaction.options.getString("reason") || "No reason provided";
    const targetUser = interaction.options.getUser("user");

    if (action === "list") {
      return listTickets(interaction, ctx, reason);
    }

    if (action === "transcriptsearch") {
      const index = load("transcriptIndex", []);
      const rows = index
        .filter(x => x.guildId === guildId && (!reason || String(x.preview || "").toLowerCase().includes(reason.toLowerCase())))
        .slice(-20)
        .reverse();
      const text = rows.length ? rows.map(x => `- ${x.channelName} - <t:${Math.floor(Number(x.time || Date.now()) / 1000)}:R>\n${x.preview || ""}`).join("\n\n") : "No transcript matches.";
      await interaction.reply({ embeds: [ctx.makeEmbed("Transcript Search", text.slice(0, 3900), "info")], ephemeral: true });
      return true;
    }

    if (!ctx.isTicketChannel(interaction.channel)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This command only works in tickets.", "error")], ephemeral: true });
      return true;
    }

    const all = load("ticketMeta", {});
    const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
    save("ticketMeta", all);

    if (action === "claim") return claimTicket(interaction, ctx, "command", targetUser?.id || interaction.user.id);
    if (action === "unclaim") return unclaimTicket(interaction, ctx, "command");
    if (action === "close") return closeTicket(interaction, ctx, { reason, source: "ticket-command", hardDelete: false });
    if (action === "reopen") return reopenTicket(interaction, ctx, "ticket-command");
    if (action === "status") return showTicketStatus(interaction, ctx);
    if (action === "history") return showTicketHistory(interaction, ctx);
    if (action === "priority") return setTicketPriority(interaction, ctx, reason, "command");

    if (action === "note") {
      const noteText = String(reason || "").trim();
      if (!noteText || noteText.toLowerCase() === "no reason provided") {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Note", "Provide note text in `reason`.", "error")], ephemeral: true });
        return true;
      }
      meta.notes.push({ by: interaction.user.id, text: noteText, at: Date.now() });
      meta.actionHistory.push({ action: "note", by: interaction.user.id, reason: noteText.slice(0, 140), at: Date.now(), source: "command" });
      save("ticketMeta", all);
      bumpStaffActivity(guildId, interaction.user.id);
      await interaction.reply({ embeds: [ctx.makeEmbed("Ticket Note Added", noteText, "info")], ephemeral: true });
      await ctx.sendTypedLog(interaction.guild, "moderation", "Ticket Note Added", `${interaction.user.tag} added a note in ${interaction.channel.name}.`, "info");
      return true;
    }

    await interaction.reply({ embeds: [ctx.makeEmbed("Unknown Ticket Action", "Use a valid ticket action.", "error")], ephemeral: true });
    return true;
  }

  if (cmd === "welcome") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    const text = interaction.options.getString("text");
    const imageFile = interaction.options.getAttachment ? interaction.options.getAttachment("image_file") : null;
    const role = interaction.options.getRole("role");

    if (action === "show") {
      const welcome = settings.welcome || {};
      const leave = settings.leave || {};
      const autoRoles = (welcome.autoRoles || []).map(id => `<@&${id}>`).join(", ") || "None";
      await interaction.reply({
        embeds: [ctx.makeEmbed("Welcome Settings", [
          `Welcome: ${welcome.customMessage || "not set"}`,
          `DM: ${welcome.dmMessage || "not set"}`,
          `Image: ${welcome.welcomeImage || "none"}`,
          `Auto Roles: ${autoRoles}`,
          `Leave: ${leave.message || "not set"}`
        ].join("\n"), "info")],
        ephemeral: true
      });
      return true;
    }

    setGuildSettings(guildId, g => {
      g.welcome = g.welcome || {};
      g.leave = g.leave || {};
      if (action === "set" && text) g.welcome.customMessage = text;
      if (action === "dm" && text) g.welcome.dmMessage = text;
      if (action === "image") {
        g.welcome.welcomeImage = imageFile?.url || text || null;
        g.welcome.brandName = g.welcome.brandName || "Rift Studios";
      }
      if (action === "leave" && text) g.leave.message = text;
      if (action === "autorole" && role) {
        g.welcome.autoRoles = g.welcome.autoRoles || [];
        if (!g.welcome.autoRoles.includes(role.id)) g.welcome.autoRoles.push(role.id);
      }
    });

    await interaction.reply({ embeds: [ctx.makeEmbed("Welcome Updated", `Action \`${action}\` applied.`, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "poll") {
    const question = interaction.options.getString("question");
    const answers = ["answer1", "answer2", "answer3", "answer4", "answer5", "answer6"].map(k => interaction.options.getString(k)).filter(Boolean);
    const durationRaw = interaction.options.getString("duration");
    const anonymous = interaction.options.getBoolean("anonymous") === true;
    const durationMs = durationRaw ? ms(durationRaw) : null;

    const emojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];
    const description = answers.map((a, i) => `${emojis[i]} ${a}`).join("\n");
    const footer = `${anonymous ? "Anonymous poll" : `By ${interaction.user.tag}`}${durationMs ? ` • Ends <t:${Math.floor((Date.now() + durationMs) / 1000)}:R>` : ""}`;

    const msg = await interaction.channel.send({
      embeds: [ctx.makeEmbed("📊 Poll", `**${question}**\n\n${description}`, "info", [{ name: "Details", value: footer }])]
    });

    for (let i = 0; i < answers.length; i += 1) {
      await msg.react(emojis[i]).catch(() => {});
    }

    if (durationMs) {
      const polls = load("polls", []);
      polls.push({ guildId, channelId: interaction.channelId, messageId: msg.id, endsAt: Date.now() + durationMs, question, options: answers });
      save("polls", polls);
      const timer = setTimeout(async () => {
        const ch = interaction.guild.channels.cache.get(interaction.channelId);
        if (!ch?.isTextBased?.()) return;
        const endedMsg = await ch.messages.fetch(msg.id).catch(() => null);
        if (!endedMsg) return;
        await ch.send({ embeds: [ctx.makeEmbed("Poll Ended", `Poll ended: **${question}**`, "info")] }).catch(() => {});
      }, durationMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    await interaction.reply({ embeds: [ctx.makeEmbed("Poll Created", "Your poll has been posted.", "success")], ephemeral: true });
    return true;
  }

  if (cmd === "suggest") {
    const idea = interaction.options.getString("idea");
    const anonymous = interaction.options.getBoolean("anonymous") === true;
    const entry = {
      id: `S-${Date.now().toString(36)}`,
      guildId,
      userId: interaction.user.id,
      idea,
      status: "pending",
      response: null,
      createdAt: Date.now(),
      messageId: null
    };

    const msg = await interaction.channel.send({
      embeds: [ctx.makeEmbed("💡 New Suggestion", idea, "info", [
        { name: "Suggested By", value: anonymous ? "Anonymous" : interaction.user.tag },
        { name: "Status", value: "Pending" }
      ])]
    });
    await msg.react("✅").catch(() => {});
    await msg.react("❌").catch(() => {});
    await msg.react("🤔").catch(() => {});
    entry.messageId = msg.id;

    const all = load("suggestions", []);
    all.push(entry);
    save("suggestions", all);
    await interaction.reply({ embeds: [ctx.makeEmbed("Suggestion Posted", "Your suggestion has been posted.", "success")], ephemeral: true });
    return true;
  }

  if (cmd === "suggestion") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can review suggestions.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    const messageId = interaction.options.getString("messageid");
    const text = interaction.options.getString("text") || "No note provided";

    const all = load("suggestions", []);
    const item = all.find(s => s.guildId === guildId && s.messageId === messageId);
    if (!item) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Not Found", "Suggestion not found.", "error")], ephemeral: true });
      return true;
    }

    if (action === "approve") item.status = "approved";
    if (action === "deny") item.status = "denied";
    if (action === "respond") item.status = item.status || "pending";
    item.response = text;
    item.reviewedBy = interaction.user.id;
    item.reviewedAt = Date.now();
    save("suggestions", all);

    const msg = await interaction.channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      await msg.edit({
        embeds: [ctx.makeEmbed("💡 Suggestion", item.idea, "info", [
          { name: "Status", value: item.status },
          { name: "Staff Response", value: text }
        ])]
      }).catch(() => {});
    }
    await ctx.sendTypedLog(interaction.guild, "moderation", "Suggestion Updated", `${interaction.user.tag} set suggestion ${messageId} to ${item.status}.`, "info");
    await interaction.reply({ embeds: [ctx.makeEmbed("Suggestion Updated", `Status: ${item.status}`, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "afk") {
    const reason = interaction.options.getString("reason") || "AFK";
    updateProfile(guildId, interaction.user.id, p => {
      p.afk = { reason, setAt: Date.now() };
    });
    await interaction.reply({ embeds: [ctx.makeEmbed("AFK Set", reason, "info")] });
    return true;
  }

  if (cmd === "level") {
    const action = interaction.options.getString("action");
    if (action === "rank") {
      const user = interaction.options.getUser("user") || interaction.user;
      const p = profile(guildId, user.id);
      await interaction.reply({ embeds: [ctx.makeEmbed(`Level: ${user.tag}`, `Level **${p.level || 0}**\nXP **${p.xp || 0}**`, "info")] });
      return true;
    }
    if (action === "leaderboard") {
      const all = getProfilesData();
      const rows = Object.entries(all[guildId] || {})
        .sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0))
        .slice(0, 10)
        .map(([id, p], i) => `**${i + 1}.** <@${id}> - Lvl ${p.level || 0} (${p.xp || 0} XP)`)
        .join("\n") || "No data.";
      await interaction.reply({ embeds: [ctx.makeEmbed("Level Leaderboard", rows, "info")] });
      return true;
    }
    if (action === "toggle") {
      if (!ctx.canUseModCommand(interaction.member)) {
        await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
        return true;
      }
      const enabled = interaction.options.getBoolean("enabled");
      setGuildSettings(guildId, g => {
        g.leveling = g.leveling || {};
        g.leveling.enabled = enabled !== false;
      });
      await interaction.reply({ embeds: [ctx.makeEmbed("Leveling Updated", `Enabled: **${enabled !== false}**`, "success")], ephemeral: true });
      return true;
    }
    if (action === "reward") {
      if (!ctx.canUseModCommand(interaction.member)) {
        await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
        return true;
      }
      const level = interaction.options.getInteger("level");
      const role = interaction.options.getRole("role");
      if (!level || !role) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Data", "Provide both level and role.", "error")], ephemeral: true });
        return true;
      }
      setGuildSettings(guildId, g => {
        g.leveling = g.leveling || {};
        g.leveling.rewards = g.leveling.rewards || {};
        g.leveling.rewards[String(level)] = role.id;
      });
      await interaction.reply({ embeds: [ctx.makeEmbed("Reward Saved", `Level ${level} -> ${role}`, "success")], ephemeral: true });
      return true;
    }
  }

  if (cmd === "economy") {
    const action = interaction.options.getString("action");
    const target = interaction.options.getUser("user") || interaction.user;
    const amount = Math.max(0, interaction.options.getInteger("amount") || 0);

    if (action === "balance") {
      const p = profile(guildId, target.id);
      await interaction.reply({ embeds: [ctx.makeEmbed("Balance", `${target.tag} has **${p.currency || 0} ${settings.economy?.currencyName || "Coins"}**.`, "info")] });
      return true;
    }

    if (["grant", "take"].includes(action) && !ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }

    if (action === "grant") {
      updateProfile(guildId, target.id, p => { p.currency = (p.currency || 0) + amount; });
      await interaction.reply({ embeds: [ctx.makeEmbed("Currency Granted", `Added ${amount} to ${target.tag}.`, "success")], ephemeral: true });
      return true;
    }
    if (action === "take") {
      updateProfile(guildId, target.id, p => { p.currency = Math.max(0, (p.currency || 0) - amount); });
      await interaction.reply({ embeds: [ctx.makeEmbed("Currency Removed", `Removed ${amount} from ${target.tag}.`, "warn")], ephemeral: true });
      return true;
    }
    if (action === "pay") {
      if (!target || target.id === interaction.user.id) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Invalid Target", "Choose another user.", "error")], ephemeral: true });
        return true;
      }
      const from = profile(guildId, interaction.user.id);
      if ((from.currency || 0) < amount) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Insufficient Funds", "Not enough balance.", "error")], ephemeral: true });
        return true;
      }
      updateProfile(guildId, interaction.user.id, p => { p.currency -= amount; });
      updateProfile(guildId, target.id, p => { p.currency = (p.currency || 0) + amount; });
      await interaction.reply({ embeds: [ctx.makeEmbed("Payment Sent", `Paid ${amount} to ${target.tag}.`, "success")] });
      return true;
    }
  }

  if (cmd === "prestige") {
    const confirm = interaction.options.getBoolean("confirm") === true;
    if (!confirm) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Confirmation Required", "Set `confirm=true` to prestige.", "warn")], ephemeral: true });
      return true;
    }
    const p = profile(guildId, interaction.user.id);
    const currentBalance = Math.max(0, Number(p.currency || 0));
    const bonus = Math.floor(currentBalance * 0.15);
    updateProfile(guildId, interaction.user.id, x => { x.currency = bonus; });
    const { all, item } = getGuildPrestige(guildId, interaction.user.id);
    item.tier = Math.max(0, Number(item.tier || 0)) + 1;
    item.totalPrestiges = Math.max(0, Number(item.totalPrestiges || 0)) + 1;
    item.lastAt = Date.now();
    item.lastResetAmount = currentBalance;
    item.lastBonus = bonus;
    save("prestige", all);
    await interaction.reply({
      embeds: [ctx.makeEmbed("Prestige Complete", `Tier: **${item.tier}**\nOld balance: **${currentBalance}**\n15% bonus restored: **${bonus}**`, "success")]
    });
    return true;
  }

  if (cmd === "achievements") {
    const target = interaction.options.getUser("user") || interaction.user;
    const p = profile(guildId, target.id);
    const rows = getAchievementRows(p);
    const unlocked = rows.filter(x => x.unlocked).length;
    const text = rows.map(x => `${x.unlocked ? "✅" : "⬜"} ${x.name}`).join("\n");
    await interaction.reply({
      embeds: [ctx.makeEmbed("Achievements", `${target} unlocked **${unlocked}/${rows.length}**\n\n${text}`, "info")]
    });
    return true;
  }

  if (cmd === "shop") {
    const action = interaction.options.getString("action");
    const itemsAll = load("shopItems", {});
    const items = ensureGuildMap(itemsAll, guildId);
    const itemName = String(interaction.options.getString("item") || "").trim().toLowerCase();
    const price = Math.max(1, interaction.options.getInteger("price") || 0);

    if (action === "list") {
      const rows = Object.entries(items).map(([key, val]) => `• **${key}** - ${val.price || 0} ${settings.economy?.currencyName || "Coins"}`);
      await interaction.reply({ embeds: [ctx.makeEmbed("Shop", rows.length ? rows.join("\n") : "Shop is empty.", "info")] });
      return true;
    }

    if (action === "add") {
      if (!ctx.canUseModCommand(interaction.member)) {
        await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
        return true;
      }
      if (!itemName || !price) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Data", "Provide item and price.", "error")], ephemeral: true });
        return true;
      }
      items[itemName] = { price, by: interaction.user.id, at: Date.now() };
      save("shopItems", itemsAll);
      await interaction.reply({ embeds: [ctx.makeEmbed("Shop Updated", `Added **${itemName}** for **${price}**.`, "success")], ephemeral: true });
      return true;
    }

    if (action === "buy") {
      if (!itemName || !items[itemName]) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Unknown Item", "Item not found in shop.", "error")], ephemeral: true });
        return true;
      }
      const cost = Math.max(1, Number(items[itemName].price) || 1);
      const p = profile(guildId, interaction.user.id);
      if ((p.currency || 0) < cost) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Insufficient Funds", `You need ${cost} ${settings.economy?.currencyName || "Coins"}.`, "error")], ephemeral: true });
        return true;
      }
      updateProfile(guildId, interaction.user.id, x => { x.currency -= cost; });
      const invAll = load("inventories", {});
      const inv = ensureInventory(invAll, guildId, interaction.user.id);
      inv.push({ item: itemName, cost, at: Date.now() });
      save("inventories", invAll);
      await interaction.reply({ embeds: [ctx.makeEmbed("Purchase Complete", `Bought **${itemName}** for **${cost}**.`, "success")] });
      return true;
    }

    if (action === "inventory") {
      const invAll = load("inventories", {});
      const inv = ensureInventory(invAll, guildId, interaction.user.id);
      const rows = inv.slice(-20).reverse().map(x => `• ${x.item} (${x.cost})`).join("\n") || "No items.";
      await interaction.reply({ embeds: [ctx.makeEmbed("Your Inventory", rows, "info")], ephemeral: true });
      return true;
    }
  }

  if (cmd === "games") {
    const action = interaction.options.getString("action");
    const bet = Math.max(1, interaction.options.getInteger("bet") || 0);
    const p = profile(guildId, interaction.user.id);
    if (!bet || (p.currency || 0) < bet) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Invalid Bet", "Bet must be positive and within your balance.", "error")], ephemeral: true });
      return true;
    }

    if (action === "coinflip") {
      const pick = String(interaction.options.getString("pick") || "").toLowerCase();
      if (!["heads", "tails"].includes(pick)) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Pick", "Choose heads or tails.", "error")], ephemeral: true });
        return true;
      }
      const roll = Math.random() < 0.5 ? "heads" : "tails";
      const win = pick === roll;
      updateProfile(guildId, interaction.user.id, x => { x.currency = Math.max(0, (x.currency || 0) + (win ? bet : -bet)); });
      await interaction.reply({ embeds: [ctx.makeEmbed("Coinflip", `Result: **${roll}**\n${win ? `You won ${bet}.` : `You lost ${bet}.`}`, win ? "success" : "warn")] });
      return true;
    }

    if (action === "blackjack") {
      const player = 12 + Math.floor(Math.random() * 10);
      const dealer = 12 + Math.floor(Math.random() * 10);
      const playerBust = player > 21;
      const dealerBust = dealer > 21;
      const win = (!playerBust && dealerBust) || (!playerBust && player > dealer);
      const push = !playerBust && !dealerBust && player === dealer;
      const delta = push ? 0 : (win ? bet : -bet);
      updateProfile(guildId, interaction.user.id, x => { x.currency = Math.max(0, (x.currency || 0) + delta); });
      await interaction.reply({
        embeds: [ctx.makeEmbed(
          "Blackjack",
          `You: **${player}**\nDealer: **${dealer}**\n${push ? "Push. No change." : win ? `You won ${bet}.` : `You lost ${bet}.`}`,
          push ? "info" : (win ? "success" : "warn")
        )]
      });
      return true;
    }
  }

  if (cmd === "fun") {
    const action = interaction.options.getString("action");
    if (action === "fortune") {
      const fortunes = [
        "A surprise opportunity is closer than you think.",
        "Today is ideal for starting a small project.",
        "Someone in this server is about to help you level up."
      ];
      const fortune = fortunes[Math.floor(Math.random() * fortunes.length)];
      await interaction.reply({ embeds: [ctx.makeEmbed("Fortune", fortune, "info")] });
      return true;
    }
    if (action === "pet") {
      const pets = ["cat", "dog", "fox", "rabbit", "hamster"];
      const pet = pets[Math.floor(Math.random() * pets.length)];
      await interaction.reply({ embeds: [ctx.makeEmbed("Your Pet", `You adopted a **${pet}** today.`, "success")] });
      return true;
    }
    if (action === "meme") {
      const res = await fetch("https://meme-api.com/gimme").catch(() => null);
      const data = res ? await res.json().catch(() => null) : null;
      if (!data?.url) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Meme Error", "Could not fetch a meme right now.", "error")], ephemeral: true });
        return true;
      }
      await interaction.reply({ embeds: [ctx.makeEmbed(data.title || "Random Meme", data.url, "info")] });
      return true;
    }
  }

  if (cmd === "utility") {
    const action = interaction.options.getString("action");
    if (action === "userinfo") {
      const user = interaction.options.getUser("user") || interaction.user;
      const memberObj = await interaction.guild.members.fetch(user.id).catch(() => null);
      await interaction.reply({
        embeds: [ctx.makeEmbed(`User Info: ${user.tag}`, `ID: ${user.id}`, "info", [
          { name: "Created", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>` },
          { name: "Joined", value: memberObj ? `<t:${Math.floor(memberObj.joinedTimestamp / 1000)}:F>` : "Unknown" }
        ])]
      });
      return true;
    }
    if (action === "weather") {
      const location = interaction.options.getString("location");
      if (!location) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Location", "Provide a location.", "error")], ephemeral: true });
        return true;
      }
      const wait = isUtilityRateLimited(guildId, interaction.user.id, "weather", 7);
      if (wait > 0) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Rate Limited", `Try again in ${wait}s.`, "warn")], ephemeral: true });
        return true;
      }
      const cacheKey = location.trim().toLowerCase();
      const cached = weatherCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        const nowWeather = cached.payload;
        await interaction.reply({
          embeds: [ctx.makeEmbed(`Weather: ${location}`, `Temp: **${nowWeather.temp_C} C**\nCondition: **${nowWeather.weatherDesc?.[0]?.value || "Unknown"}**\nHumidity: **${nowWeather.humidity}%**\n(source: cache)`, "info")]
        });
        return true;
      }
      const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
      const res = await fetchWithTimeout(url, {}, 500).catch(() => null);
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      const nowWeather = data?.current_condition?.[0];
      if (!nowWeather) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Weather Unavailable", "Weather service timed out or is unavailable. Please try again shortly.", "warn")], ephemeral: true });
        return true;
      }
      weatherCache.set(cacheKey, { payload: nowWeather, expiresAt: Date.now() + 60 * 1000 });
      await interaction.reply({
        embeds: [ctx.makeEmbed(`Weather: ${location}`, `Temp: **${nowWeather.temp_C} C**\nCondition: **${nowWeather.weatherDesc?.[0]?.value || "Unknown"}**\nHumidity: **${nowWeather.humidity}%**`, "info")]
      });
      return true;
    }
    if (action === "convert") {
      const amount = Number(interaction.options.getNumber("amount") || 1);
      const from = String(interaction.options.getString("from") || "USD").toUpperCase();
      const to = String(interaction.options.getString("to") || "EUR").toUpperCase();
      const wait = isUtilityRateLimited(guildId, interaction.user.id, "convert", 7);
      if (wait > 0) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Rate Limited", `Try again in ${wait}s.`, "warn")], ephemeral: true });
        return true;
      }
      const cached = rateCache.get(from);
      let data = null;
      if (cached && cached.expiresAt > Date.now()) {
        data = cached.payload;
      } else {
        const res = await fetchWithTimeout(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, {}, 500).catch(() => null);
        data = res && res.ok ? await res.json().catch(() => null) : null;
        if (data?.rates) {
          rateCache.set(from, { payload: data, expiresAt: Date.now() + 10 * 60 * 1000 });
        }
      }
      const rate = Number(data?.rates?.[to] || 0);
      if (!rate) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Conversion Unavailable", "Invalid currency or rates unavailable right now.", "warn")], ephemeral: true });
        return true;
      }
      const converted = amount * rate;
      await interaction.reply({ embeds: [ctx.makeEmbed("Currency Conversion", `${amount} ${from} = **${converted.toFixed(2)} ${to}**`, "info")] });
      return true;
    }
  }

  if (cmd === "media") {
    const action = interaction.options.getString("action");
    if (action === "embed") {
      const title = interaction.options.getString("title") || "Embedded Media";
      const url = interaction.options.getString("url");
      if (!url) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing URL", "Provide URL for embed action.", "error")], ephemeral: true });
        return true;
      }
      await interaction.reply({ embeds: [ctx.makeEmbed(title, url, "info")] });
      return true;
    }
    const query = interaction.options.getString("query");
    if (!query) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Missing Query", "Provide a search query.", "error")], ephemeral: true });
      return true;
    }
    if (action === "image") {
      const imageUrl = `https://source.unsplash.com/featured/?${encodeURIComponent(query)}`;
      await interaction.reply({ embeds: [ctx.makeEmbed(`Image: ${query}`, imageUrl, "info")] });
      return true;
    }
    if (action === "gif") {
      const gifUrl = `https://giphy.com/search/${encodeURIComponent(query)}`;
      await interaction.reply({ embeds: [ctx.makeEmbed(`GIF Search: ${query}`, gifUrl, "info")] });
      return true;
    }
  }

  if (cmd === "reactionroles") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const emoji = interaction.options.getString("emoji");
    const role = interaction.options.getRole("role");
    const title = interaction.options.getString("title") || "Reaction Roles";
    const msg = await interaction.channel.send({
      embeds: [ctx.makeEmbed(title, `React with ${emoji} to get ${role}.`, "info")]
    });
    await msg.react(emoji).catch(() => {});
    const all = load("reactionRoles", {});
    const guildMap = ensureGuildMap(all, guildId);
    guildMap[msg.id] = { emoji, roleId: role.id, by: interaction.user.id, at: Date.now() };
    save("reactionRoles", all);
    await interaction.reply({ embeds: [ctx.makeEmbed("Reaction Role Created", `Message ID: ${msg.id}`, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "music") {
    if (!distube) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Music Not Ready", "Player is initializing. Try again in a moment.", "warn")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    const memberVoice = interaction.member?.voice?.channel;
    const botVoice = interaction.guild.members.me?.voice?.channel;
    const query = interaction.options.getString("query") || "";

    if (["play", "stop"].includes(action) && !memberVoice) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Join Voice First", "You need to join a voice channel.", "warn")], ephemeral: true });
      return true;
    }
    if (["play", "stop"].includes(action) && botVoice && memberVoice && botVoice.id !== memberVoice.id) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Wrong Voice Channel", "Join the same voice channel as the bot.", "warn")], ephemeral: true });
      return true;
    }
    if (memberVoice) {
      const perms = memberVoice.permissionsFor(interaction.guild.members.me);
      if (!perms?.has("Connect") || !perms?.has("Speak")) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Permissions", "I need Connect + Speak permissions in that voice channel.", "error")], ephemeral: true });
        return true;
      }
    }

    if (action === "status") {
      const queue = distube.getQueue(interaction.guildId);
      await interaction.reply({
        embeds: [ctx.makeEmbed("Music Status", queue ? `Connected: <#${queue.voiceChannel?.id || "unknown"}>\nNow: **${queue.songs?.[0]?.name || "None"}**` : "No active queue.", "info")]
      });
      return true;
    }
    if (action === "play") {
      if (!query) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Query", "Provide a track name or URL.", "error")], ephemeral: true });
        return true;
      }
      await interaction.deferReply();
      try {
        await distube.play(memberVoice, query, {
          textChannel: interaction.channel,
          member: interaction.member
        });
        await interaction.editReply({ embeds: [ctx.makeEmbed("Music", `Queued **${query}**`, "success")] });
      } catch (err) {
        await interaction.editReply({ embeds: [ctx.makeEmbed("Music Error", String(err?.message || err || "Failed to play"), "error")] });
      }
      return true;
    }
    if (action === "queue") {
      const queue = distube.getQueue(interaction.guildId);
      if (!queue || !queue.songs?.length) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Music Queue", "Queue is empty.", "info")] });
        return true;
      }
      const now = queue.songs[0];
      const upcoming = queue.songs.slice(1, 11).map((s, i) => `${i + 1}. ${s.name}`).join("\n") || "None";
      await interaction.reply({
        embeds: [ctx.makeEmbed("Music Queue", `Now: **${now.name}**\n\nUp Next:\n${upcoming}`, "info")]
      });
      return true;
    }
    if (action === "stop") {
      const queue = distube.getQueue(interaction.guildId);
      if (!queue) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Music", "No active queue.", "warn")], ephemeral: true });
        return true;
      }
      queue.stop();
      saveMusicQueueSnapshot(interaction.guildId, {
        voiceChannelId: null,
        textChannelId: interaction.channelId,
        nowPlaying: null,
        queued: [],
        updatedAt: Date.now()
      });
      await interaction.reply({ embeds: [ctx.makeEmbed("Music", "Playback stopped and queue cleared.", "success")] });
      return true;
    }
  }

  if (cmd === "application") {
    const action = interaction.options.getString("action");
    const all = load("applications", []);

    if (action === "submit") {
      const type = (interaction.options.getString("type") || "staff").toLowerCase();
      const answers = interaction.options.getString("answers") || "No details provided.";
      const item = {
        id: `APP-${Date.now().toString(36)}`,
        guildId,
        userId: interaction.user.id,
        type,
        answers,
        status: "pending",
        reviewedBy: null,
        note: null,
        createdAt: Date.now(),
        reviewedAt: null
      };
      all.push(item);
      save("applications", all);
      await interaction.reply({ embeds: [ctx.makeEmbed("Application Submitted", `ID: \`${item.id}\``, "success")], ephemeral: true });
      await ctx.sendTypedLog(interaction.guild, "member", "Application Submitted", `${interaction.user.tag} submitted a ${type} application.`, "info", [
        { name: "Application ID", value: item.id, inline: true }
      ]);
      return true;
    }

    if (action === "list") {
      if (!ctx.canUseModCommand(interaction.member)) {
        await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
        return true;
      }
      const rows = all.filter(a => a.guildId === guildId).slice(-20).reverse();
      const text = rows.length ? rows.map(a => `• \`${a.id}\` • ${a.type} • ${a.status} • <@${a.userId}>`).join("\n") : "No applications.";
      await interaction.reply({ embeds: [ctx.makeEmbed("Applications", text, "info")], ephemeral: true });
      return true;
    }

    if (action === "review") {
      if (!ctx.canUseModCommand(interaction.member)) {
        await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
        return true;
      }
      const id = interaction.options.getString("id");
      const status = (interaction.options.getString("status") || "pending").toLowerCase();
      const note = interaction.options.getString("note") || "No note";
      const item = all.find(a => a.guildId === guildId && a.id === id);
      if (!item) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Not Found", "Application not found.", "error")], ephemeral: true });
        return true;
      }
      item.status = status;
      item.note = note;
      item.reviewedBy = interaction.user.id;
      item.reviewedAt = Date.now();
      save("applications", all);
      bumpStaffActivity(guildId, interaction.user.id);
      await interaction.reply({ embeds: [ctx.makeEmbed("Application Reviewed", `${id} -> ${status}`, "success")], ephemeral: true });
      return true;
    }
  }

  if (cmd === "partnership") {
    const action = interaction.options.getString("action");
    const all = load("partnerships", []);
    const cooldownMs = settings.partnerships?.cooldownMs || 12 * 60 * 60 * 1000;

    if (action === "template") {
      const template = [
        "**Partnered With [Server Name]**",
        "Community: [Short description]",
        "Invite: [link]",
        "Why join: [benefit 1], [benefit 2]"
      ].join("\n");
      await interaction.reply({ embeds: [ctx.makeEmbed("Partnership Template", template, "info")], ephemeral: true });
      return true;
    }

    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }

    if (action === "post") {
      const server = interaction.options.getString("server") || "Unknown Server";
      const invite = interaction.options.getString("invite") || "No invite provided";
      const text = `**Partner:** ${server}\n**Invite:** ${invite}`;
      await interaction.channel.send({ embeds: [ctx.makeEmbed("New Partnership", text, "success")] });
      all.push({ guildId, server, invite, by: interaction.user.id, time: Date.now(), type: "post" });
      save("partnerships", all.slice(-3000));
      await interaction.reply({ embeds: [ctx.makeEmbed("Partnership Posted", "Announcement sent.", "success")], ephemeral: true });
      return true;
    }

    if (action === "bump") {
      const track = load("bumpTracking", {});
      if (!track[guildId]) track[guildId] = {};
      const last = track[guildId].lastBumpAt || 0;
      const remaining = cooldownMs - (Date.now() - last);
      if (remaining > 0) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Cooldown Active", `Try again <t:${Math.floor((Date.now() + remaining) / 1000)}:R>.`, "warn")], ephemeral: true });
        return true;
      }
      track[guildId].lastBumpAt = Date.now();
      track[guildId].lastBumpBy = interaction.user.id;
      save("bumpTracking", track);
      all.push({ guildId, by: interaction.user.id, time: Date.now(), type: "bump" });
      save("partnerships", all.slice(-3000));
      await interaction.reply({ embeds: [ctx.makeEmbed("Bump Logged", "Partnership bump activity tracked.", "success")], ephemeral: true });
      return true;
    }
  }

  if (cmd === "mediaonly") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    const channel = interaction.options.getChannel("channel") || interaction.channel;
    setGuildSettings(guildId, g => {
      g.mediaOnlyChannels = g.mediaOnlyChannels || [];
      if (action === "add" && !g.mediaOnlyChannels.includes(channel.id)) g.mediaOnlyChannels.push(channel.id);
      if (action === "remove") g.mediaOnlyChannels = g.mediaOnlyChannels.filter(id => id !== channel.id);
    });
    const list = getGuildSettings(guildId).mediaOnlyChannels || [];
    if (action === "list") {
      await interaction.reply({ embeds: [ctx.makeEmbed("Media-Only Channels", list.map(id => `<#${id}>`).join("\n") || "None", "info")], ephemeral: true });
      return true;
    }
    await interaction.reply({ embeds: [ctx.makeEmbed("Media-Only Updated", `${action} ${channel}`, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "sticky") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    if (action === "set") {
      const text = interaction.options.getString("text");
      const cooldown = Math.max(15, interaction.options.getInteger("cooldown_seconds") || 60);
      if (!text) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Text", "Provide sticky text.", "error")], ephemeral: true });
        return true;
      }
      setGuildSettings(guildId, g => {
        g.sticky = g.sticky || {};
        g.sticky[interaction.channelId] = { text, cooldownMs: cooldown * 1000, lastSentAt: 0, messageId: null };
      });
      await interaction.reply({ embeds: [ctx.makeEmbed("Sticky Set", "Sticky message configured.", "success")], ephemeral: true });
      return true;
    }
    if (action === "clear") {
      setGuildSettings(guildId, g => {
        g.sticky = g.sticky || {};
        delete g.sticky[interaction.channelId];
      });
      await interaction.reply({ embeds: [ctx.makeEmbed("Sticky Cleared", "Sticky removed for this channel.", "success")], ephemeral: true });
      return true;
    }
  }

  if (cmd === "starboard") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    if (action === "set") {
      const channel = interaction.options.getChannel("channel") || interaction.channel;
      const emoji = interaction.options.getString("emoji") || "⭐";
      const threshold = Math.max(1, interaction.options.getInteger("threshold") || 3);
      setGuildSettings(guildId, g => {
        g.starboard = g.starboard || {};
        g.starboard.enabled = true;
        g.starboard.channelId = channel.id;
        g.starboard.emoji = emoji;
        g.starboard.threshold = threshold;
        g.starboard.entries = g.starboard.entries || {};
      });
      await interaction.reply({ embeds: [ctx.makeEmbed("Starboard Updated", `Channel ${channel}\nEmoji ${emoji}\nThreshold ${threshold}`, "success")], ephemeral: true });
      return true;
    }
    if (action === "off") {
      setGuildSettings(guildId, g => {
        g.starboard = g.starboard || {};
        g.starboard.enabled = false;
      });
      await interaction.reply({ embeds: [ctx.makeEmbed("Starboard Disabled", "Starboard is now off.", "warn")], ephemeral: true });
      return true;
    }
  }

  if (cmd === "remind") {
    const timeRaw = interaction.options.getString("time");
    const text = interaction.options.getString("text");
    const timeMs = ms(timeRaw);
    if (!timeMs || timeMs < 5000) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Invalid Time", "Use a valid time like 10m, 2h, 1d.", "error")], ephemeral: true });
      return true;
    }
    const reminders = load("reminders", []);
    reminders.push({ id: `R-${Date.now().toString(36)}`, guildId, userId: interaction.user.id, time: Date.now() + timeMs, text });
    save("reminders", reminders.slice(-5000));
    await interaction.reply({ embeds: [ctx.makeEmbed("Reminder Saved", `I will remind you <t:${Math.floor((Date.now() + timeMs) / 1000)}:R>.`, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "countdown") {
    const action = interaction.options.getString("action");
    if (action === "list") {
      const rows = load("schedules", []).filter(s => s.guildId === guildId && s.kind === "countdown");
      const text = rows.length ? rows.map(s => `• \`${s.id}\` ${s.name} ends <t:${Math.floor(s.nextRunAt / 1000)}:R>`).join("\n") : "No countdowns.";
      await interaction.reply({ embeds: [ctx.makeEmbed("Countdowns", text, "info")], ephemeral: true });
      return true;
    }
    const name = interaction.options.getString("name") || "Event";
    const timeRaw = interaction.options.getString("time") || "1h";
    const timeMs = ms(timeRaw);
    if (!timeMs) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Invalid Time", "Use a valid duration.", "error")], ephemeral: true });
      return true;
    }
    const all = load("schedules", []);
    all.push({ id: `CD-${Date.now().toString(36)}`, kind: "countdown", guildId, channelId: interaction.channelId, name, text: `Countdown complete: **${name}**`, nextRunAt: Date.now() + timeMs, intervalMs: null, createdBy: interaction.user.id });
    save("schedules", all);
    await interaction.reply({ embeds: [ctx.makeEmbed("Countdown Created", `${name} ends <t:${Math.floor((Date.now() + timeMs) / 1000)}:R>.`, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "rolemenu") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const title = interaction.options.getString("title");
    const roles = [interaction.options.getRole("role1"), interaction.options.getRole("role2"), interaction.options.getRole("role3")].filter(Boolean);
    const buttons = roles.map((role, idx) => new ButtonBuilder().setCustomId(`rolemenu_${role.id}`).setLabel(role.name).setStyle(idx % 2 ? ButtonStyle.Secondary : ButtonStyle.Primary));
    const row = new ActionRowBuilder().addComponents(...buttons.slice(0, 5));
    const msg = await interaction.channel.send({ embeds: [ctx.makeEmbed(title, "Click a button to toggle roles.", "info")], components: [row] });
    await interaction.reply({ embeds: [ctx.makeEmbed("Role Menu Created", `Message ID: ${msg.id}`, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "embedbuilder") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const title = interaction.options.getString("title");
    const description = interaction.options.getString("description");
    const footer = interaction.options.getString("footer");
    const colorRaw = interaction.options.getString("color") || "#3498db";
    const fieldRaw = interaction.options.getString("field1");

    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(colorRaw).setTimestamp(new Date());
    if (footer) embed.setFooter({ text: footer });
    if (fieldRaw && fieldRaw.includes("|")) {
      const [name, value] = fieldRaw.split("|");
      embed.addFields({ name: name.trim().slice(0, 256), value: value.trim().slice(0, 1024) });
    }

    await interaction.channel.send({ embeds: [embed] });
    await interaction.reply({ embeds: [ctx.makeEmbed("Embed Sent", "Custom embed posted.", "success")], ephemeral: true });
    return true;
  }

  if (cmd === "nick") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    if (action === "rule") {
      const value = interaction.options.getString("value");
      setGuildSettings(guildId, g => {
        g.nickname = g.nickname || {};
        g.nickname.rule = value || null;
      });
      await interaction.reply({ embeds: [ctx.makeEmbed("Nickname Rule Updated", value ? `Rule set to: ${value}` : "Rule cleared.", "success")], ephemeral: true });
      return true;
    }

    const user = interaction.options.getUser("user");
    if (!user) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Missing User", "Provide a user.", "error")], ephemeral: true });
      return true;
    }
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Not Found", "User not found.", "error")], ephemeral: true });
      return true;
    }

    if (action === "reset") {
      await member.setNickname(null).catch(() => {});
      await interaction.reply({ embeds: [ctx.makeEmbed("Nickname Reset", `${user.tag}'s nickname was reset.`, "success")] });
      return true;
    }

    if (action === "set") {
      const value = interaction.options.getString("value") || "";
      const rule = settings.nickname?.rule;
      if (rule) {
        try {
          const re = new RegExp(rule, "i");
          if (!re.test(value)) {
            await interaction.reply({ embeds: [ctx.makeEmbed("Rule Violation", "Nickname does not match configured rule.", "error")], ephemeral: true });
            return true;
          }
        } catch {}
      }
      await member.setNickname(value.slice(0, 32)).catch(() => {});
      await interaction.reply({ embeds: [ctx.makeEmbed("Nickname Updated", `${user.tag} -> ${value}`, "success")] });
      return true;
    }
  }

  if (cmd === "quote") {
    const action = interaction.options.getString("action");
    const all = load("quotes", []);

    if (action === "save") {
      const messageId = interaction.options.getString("messageid");
      if (!messageId) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Message ID", "Provide message ID to save.", "error")], ephemeral: true });
        return true;
      }
      const msg = await interaction.channel.messages.fetch(messageId).catch(() => null);
      if (!msg) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Not Found", "Message not found in this channel.", "error")], ephemeral: true });
        return true;
      }
      all.push({ id: `Q-${Date.now().toString(36)}`, guildId, channelId: interaction.channelId, messageId: msg.id, authorTag: msg.author.tag, content: (msg.content || "[embed]").slice(0, 1500), savedBy: interaction.user.id, savedAt: Date.now() });
      save("quotes", all.slice(-8000));
      await interaction.reply({ embeds: [ctx.makeEmbed("Quote Saved", `Saved quote from ${msg.author.tag}.`, "success")], ephemeral: true });
      return true;
    }

    const rows = all.filter(q => q.guildId === guildId);
    if (!rows.length) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Quotes", "No saved quotes yet.", "warn")], ephemeral: true });
      return true;
    }
    if (action === "random") {
      const q = rows[Math.floor(Math.random() * rows.length)];
      await interaction.reply({ embeds: [ctx.makeEmbed(`Quote by ${q.authorTag}`, q.content, "info")] });
      return true;
    }
    if (action === "list") {
      const text = rows.slice(-10).reverse().map(q => `• \`${q.id}\` ${q.authorTag}: ${q.content.slice(0, 80)}`).join("\n");
      await interaction.reply({ embeds: [ctx.makeEmbed("Recent Quotes", text, "info")], ephemeral: true });
      return true;
    }
  }

  if (cmd === "tag") {
    const action = interaction.options.getString("action");
    const name = String(interaction.options.getString("name") || "").toLowerCase().trim();
    const content = interaction.options.getString("content") || "";
    const all = load("tags", {});
    if (!all[guildId]) all[guildId] = {};

    if (action === "list") {
      const names = Object.keys(all[guildId]);
      await interaction.reply({ embeds: [ctx.makeEmbed("Tags", names.length ? names.map(n => `• ${n}`).join("\n") : "No tags.", "info")], ephemeral: true });
      return true;
    }

    if (action === "use") {
      const tag = all[guildId][name];
      if (!tag) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Tag Missing", "That tag does not exist.", "error")], ephemeral: true });
        return true;
      }
      await interaction.reply({ embeds: [ctx.makeEmbed(`Tag: ${name}`, tag.content, "info")] });
      return true;
    }

    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can manage tags.", "error")], ephemeral: true });
      return true;
    }

    if (!["create", "edit", "delete"].includes(action) || !name) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Invalid Input", "Provide a valid tag name and action.", "error")], ephemeral: true });
      return true;
    }

    if (action === "delete") {
      delete all[guildId][name];
      save("tags", all);
      await interaction.reply({ embeds: [ctx.makeEmbed("Tag Deleted", `${name} removed.`, "warn")], ephemeral: true });
      return true;
    }

    all[guildId][name] = { content: content.slice(0, 1800), by: interaction.user.id, at: Date.now() };
    save("tags", all);
    await interaction.reply({ embeds: [ctx.makeEmbed("Tag Saved", `${name} updated.`, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "birthday") {
    const action = interaction.options.getString("action");
    const all = load("birthdays", {});
    if (!all[guildId]) all[guildId] = {};

    if (action === "set") {
      const date = interaction.options.getString("date") || "";
      if (!/^\d{2}-\d{2}$/.test(date)) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Invalid Format", "Use MM-DD format.", "error")], ephemeral: true });
        return true;
      }
      all[guildId][interaction.user.id] = { date, updatedAt: Date.now() };
      save("birthdays", all);
      await interaction.reply({ embeds: [ctx.makeEmbed("Birthday Saved", `Your birthday is set to ${date}.`, "success")], ephemeral: true });
      return true;
    }

    if (action === "list") {
      const rows = Object.entries(all[guildId]).slice(0, 25).map(([id, value]) => `• <@${id}> - ${value.date}`).join("\n") || "No birthdays saved.";
      await interaction.reply({ embeds: [ctx.makeEmbed("Birthdays", rows, "info")], ephemeral: true });
      return true;
    }
  }

  if (cmd === "serverstatus") {
    const a = ctx.governance?.getAnalytics(guildId) || {};
    const backups = ctx.loadBackups?.() || [];
    const lastBackup = backups.find(b => b.guildId === guildId);
    const maintenance = load("maintenance", {})[guildId];
    const mediaCount = settings.mediaOnlyChannels?.length || 0;
    const stickyCount = Object.keys(settings.sticky || {}).length;

    await interaction.reply({
      embeds: [ctx.makeEmbed("Server Status", [
        `AutoMod: **${ctx.currentConfig().automod?.enabled !== false ? "ON" : "OFF"}**`,
        `Anti-Nuke: **ON**`,
        `Founder Immunity: **ON**`,
        `Backup Last Snapshot: **${lastBackup ? `<t:${Math.floor((lastBackup.createdAt || Date.now()) / 1000)}:R>` : "none"}**`,
        `Maintenance: **${maintenance?.enabled ? "ON" : "OFF"}**`,
        `Media-Only Channels: **${mediaCount}**`,
        `Sticky Channels: **${stickyCount}**`,
        `Events Processed: **${a.messagesSeen || 0} messages**`
      ].join("\n"), "info")]
    });
    return true;
  }

  if (cmd === "auditdashboard") {
    const timeline = ctx.governance?.getTimeline(guildId, { limit: 20 }) || [];
    const text = timeline.length
      ? timeline.map(t => `• ${t.type} • <t:${Math.floor(t.timestamp / 1000)}:R> • ${t.reason || "n/a"}`).join("\n")
      : "No recent audit entries.";
    await interaction.reply({ embeds: [ctx.makeEmbed("Audit Dashboard", text.slice(0, 3900), "info")] });
    return true;
  }

  if (cmd === "commandcontrol") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    const command = String(interaction.options.getString("command") || "").toLowerCase();
    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");

    const all = load("commandControls", {});
    if (!all[guildId]) all[guildId] = {};

    if (action === "status") {
      const rows = Object.entries(all[guildId]).map(([name, cfg]) => `• ${name}: disabled=${cfg.disabled ? "yes" : "no"} channels=${(cfg.channels || []).length} roles=${(cfg.roles || []).length}`);
      await interaction.reply({ embeds: [ctx.makeEmbed("Command Controls", rows.length ? rows.join("\n") : "No restrictions set.", "info")], ephemeral: true });
      return true;
    }

    if (!command) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Missing Command", "Provide command name.", "error")], ephemeral: true });
      return true;
    }

    all[guildId][command] = all[guildId][command] || { disabled: false, channels: [], roles: [] };
    const cfg = all[guildId][command];

    if (action === "disable") {
      if (channel) {
        if (!cfg.channels.includes(channel.id)) cfg.channels.push(channel.id);
      } else if (role) {
        if (!cfg.roles.includes(role.id)) cfg.roles.push(role.id);
      } else {
        cfg.disabled = true;
      }
    }

    if (action === "enable") {
      if (channel) cfg.channels = cfg.channels.filter(id => id !== channel.id);
      else if (role) cfg.roles = cfg.roles.filter(id => id !== role.id);
      else cfg.disabled = false;
    }

    save("commandControls", all);
    await interaction.reply({ embeds: [ctx.makeEmbed("Command Control Updated", `${action} applied to ${command}.`, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "maintenance") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    const reason = interaction.options.getString("reason") || "Temporary maintenance in progress.";
    const all = load("maintenance", {});
    if (action === "on") all[guildId] = { enabled: true, reason, by: interaction.user.id, at: Date.now() };
    if (action === "off") all[guildId] = { enabled: false, reason: null, by: interaction.user.id, at: Date.now() };
    save("maintenance", all);
    await interaction.reply({ embeds: [ctx.makeEmbed("Maintenance Updated", `Mode: ${action.toUpperCase()}`, action === "on" ? "warn" : "success")] });
    return true;
  }

  if (cmd === "onboarding") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    if (action === "show") {
      await interaction.reply({ embeds: [ctx.makeEmbed("Onboarding Prompt", settings.onboarding?.prompt || "Not set", "info")], ephemeral: true });
      return true;
    }
    const text = interaction.options.getString("text") || "Welcome! Read the rules and introduce yourself.";
    setGuildSettings(guildId, g => {
      g.onboarding = g.onboarding || {};
      g.onboarding.prompt = text;
      g.welcome = g.welcome || {};
      g.welcome.onboardingPrompt = text;
    });
    await interaction.reply({ embeds: [ctx.makeEmbed("Onboarding Updated", text, "success")], ephemeral: true });
    return true;
  }

  if (cmd === "form") {
    const action = interaction.options.getString("action");
    const name = String(interaction.options.getString("name") || "").trim();
    const schema = interaction.options.getString("schema") || "";
    const forms = load("forms", {});
    if (!forms[guildId]) forms[guildId] = {};

    if (action === "create") {
      if (!ctx.canUseModCommand(interaction.member)) {
        await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
        return true;
      }
      if (!name || !schema) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Fields", "Provide form name and schema/questions.", "error")], ephemeral: true });
        return true;
      }
      forms[guildId][name.toLowerCase()] = { schema: schema.slice(0, 1500), by: interaction.user.id, at: Date.now() };
      save("forms", forms);
      await interaction.reply({ embeds: [ctx.makeEmbed("Form Created", `Form \`${name}\` saved.`, "success")], ephemeral: true });
      return true;
    }

    if (action === "list") {
      const rows = Object.keys(forms[guildId]);
      await interaction.reply({ embeds: [ctx.makeEmbed("Forms", rows.length ? rows.map(x => `• ${x}`).join("\n") : "No forms.", "info")], ephemeral: true });
      return true;
    }

    if (action === "submit") {
      if (!name || !schema) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Missing Fields", "Use name and schema field for submission text.", "error")], ephemeral: true });
        return true;
      }
      const subs = load("formSubmissions", []);
      const id = `FS-${Date.now().toString(36)}`;
      subs.push({ id, guildId, form: name.toLowerCase(), text: schema.slice(0, 1800), by: interaction.user.id, at: Date.now() });
      save("formSubmissions", subs.slice(-10000));
      await interaction.reply({ embeds: [ctx.makeEmbed("Form Submitted", `Submission ID: ${id}`, "success")], ephemeral: true });
      return true;
    }
  }

  if (cmd === "reportanon") {
    const text = interaction.options.getString("text");
    const reports = load("reports", []);
    const id = `AR-${Date.now().toString(36)}`;
    reports.push({ id, guildId, text: text.slice(0, 1800), by: null, at: Date.now() });
    save("reports", reports.slice(-10000));
    await interaction.reply({ embeds: [ctx.makeEmbed("Report Submitted", `Anonymous report ID: ${id}`, "success")], ephemeral: true });
    await ctx.sendTypedLog(interaction.guild, "security", "Anonymous Report", `Report ID: ${id}\n${text.slice(0, 900)}`, "warn");
    return true;
  }

  if (cmd === "schedule") {
    if (!ctx.canUseModCommand(interaction.member)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Staff only.", "error")], ephemeral: true });
      return true;
    }
    const action = interaction.options.getString("action");
    const schedules = load("schedules", []);

    if (action === "list") {
      const rows = schedules.filter(s => s.guildId === guildId && s.kind !== "countdown").slice(-20).reverse();
      const text = rows.length ? rows.map(s => `• \`${s.id}\` next <t:${Math.floor(s.nextRunAt / 1000)}:R> interval=${s.intervalMs ? `${Math.floor(s.intervalMs / 1000)}s` : "one-time"}`).join("\n") : "No schedules.";
      await interaction.reply({ embeds: [ctx.makeEmbed("Schedules", text, "info")], ephemeral: true });
      return true;
    }

    if (action === "delete") {
      const id = interaction.options.getString("id");
      const next = schedules.filter(s => !(s.guildId === guildId && s.id === id));
      save("schedules", next);
      await interaction.reply({ embeds: [ctx.makeEmbed("Schedule Removed", `Deleted ${id || "(none)"}.`, "success")], ephemeral: true });
      return true;
    }

    if (action === "create") {
      const interval = interaction.options.getString("interval") || "1h";
      const text = interaction.options.getString("text") || "Scheduled announcement";
      const intervalMs = ms(interval);
      if (!intervalMs) {
        await interaction.reply({ embeds: [ctx.makeEmbed("Invalid Interval", "Use values like 10m, 1h, 1d.", "error")], ephemeral: true });
        return true;
      }
      const id = `SC-${Date.now().toString(36)}`;
      schedules.push({ id, kind: "announcement", guildId, channelId: interaction.channelId, text, intervalMs, nextRunAt: Date.now() + intervalMs, createdBy: interaction.user.id });
      save("schedules", schedules);
      await interaction.reply({ embeds: [ctx.makeEmbed("Schedule Created", `ID: ${id}\nNext run <t:${Math.floor((Date.now() + intervalMs) / 1000)}:R>`, "success")], ephemeral: true });
      return true;
    }
  }

  return false;
}

async function handleButton(interaction, ctx) {
  if (!interaction.isButton()) return false;

  if (interaction.customId.startsWith("join_giveaway_")) {
    return handleGiveawayJoin(interaction, ctx);
  }

  if (interaction.customId.startsWith("rolemenu_")) {
    const roleId = interaction.customId.replace("rolemenu_", "");
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) return true;
    const has = member.roles.cache.has(roleId);
    if (has) await member.roles.remove(roleId).catch(() => {});
    else await member.roles.add(roleId).catch(() => {});
    await interaction.reply({ embeds: [ctx.makeEmbed("Role Menu", `${has ? "Removed" : "Added"} <@&${roleId}>`, "success")], ephemeral: true });
    return true;
  }

  if (interaction.customId === "open_support_ticket") {
    if (typeof ctx.createTicket !== "function") return false;
    if (shouldBlockTicketOpenBurst(interaction.guild.id, interaction.user.id, "support")) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Please Wait", "Your ticket request is already being processed.", "info")], ephemeral: true });
      return true;
    }
    const result = await ctx.createTicket(interaction.guild, interaction.user, "support");
    await interaction.reply({
      embeds: [ctx.makeEmbed(result.exists ? "Ticket Already Open" : "Support Ticket Opened", `${result.channel}`, result.exists ? "warn" : "success")],
      ephemeral: true
    });
    return true;
  }

  if (interaction.customId === "open_application_ticket") {
    if (shouldBlockTicketOpenBurst(interaction.guild.id, interaction.user.id, "application-modal")) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Please Wait", "Your application form is already opening.", "info")], ephemeral: true });
      return true;
    }
    await interaction.showModal(buildApplicationModal());
    return true;
  }

  if (interaction.customId === "claim_ticket") {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can claim tickets.", "error")], ephemeral: true });
      return true;
    }
    return claimTicket(interaction, ctx, "button");
  }

  if (interaction.customId === "unclaim_ticket") {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can unclaim tickets.", "error")], ephemeral: true });
      return true;
    }
    return unclaimTicket(interaction, ctx, "button");
  }

  if (interaction.customId === "reopen_ticket") {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can reopen tickets.", "error")], ephemeral: true });
      return true;
    }
    return reopenTicket(interaction, ctx, "button");
  }

  if (interaction.customId === "ticket_priority_cycle") {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can change ticket priority.", "error")], ephemeral: true });
      return true;
    }
    const all = load("ticketMeta", {});
    const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
    const current = normalizeTicketPriority(meta.priority) || "normal";
    const order = ["low", "normal", "high", "urgent"];
    const next = order[(order.indexOf(current) + 1) % order.length];
    return setTicketPriority(interaction, ctx, next, "priority-button");
  }

  if (interaction.customId === "close_ticket_button") {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can close tickets.", "error")], ephemeral: true });
      return true;
    }
    if (!ctx.isTicketChannel(interaction.channel)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId("ticket_close_reason_modal")
      .setTitle("Close Ticket");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("close_reason")
          .setLabel("Close reason")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("Resolved issue / duplicate / no response / etc.")
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.customId === "delete_ticket_button") {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can delete tickets.", "error")], ephemeral: true });
      return true;
    }
    if (!ctx.isTicketChannel(interaction.channel)) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Not a Ticket", "This only works in a ticket channel.", "error")], ephemeral: true });
      return true;
    }
    const all = load("ticketMeta", {});
    const meta = ensureTicketMeta(all, interaction.guild.id, interaction.channel);
    if (meta.status !== "closed") {
      await interaction.reply({ embeds: [ctx.makeEmbed("Close First", "Close the ticket before deleting it.", "warn")], ephemeral: true });
      return true;
    }
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`confirm_delete_ticket:${interaction.channel.id}`).setLabel("Confirm Delete").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cancel_delete_ticket:${interaction.channel.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({
      embeds: [ctx.makeEmbed("Confirm Ticket Deletion", "This will permanently delete the closed ticket channel.\nA transcript will be saved first if missing.", "warn")],
      components: [confirmRow],
      ephemeral: true
    });
    return true;
  }

  if (interaction.customId.startsWith("cancel_delete_ticket:")) {
    await interaction.update({
      embeds: [ctx.makeEmbed("Deletion Cancelled", "Ticket deletion was cancelled.", "info")],
      components: []
    });
    return true;
  }

  if (interaction.customId.startsWith("confirm_delete_ticket:")) {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can delete tickets.", "error")], ephemeral: true });
      return true;
    }
    const channelId = interaction.customId.split(":")[1];
    if (channelId && interaction.channel?.id !== channelId) {
      await interaction.reply({ embeds: [ctx.makeEmbed("Stale Confirmation", "Please use the delete button in the current ticket.", "warn")], ephemeral: true });
      return true;
    }
    return deleteClosedTicket(interaction, ctx, "delete-button-confirm");
  }

  return false;
}

async function handleModal(interaction, ctx) {
  if (!interaction.isModalSubmit()) return false;
  if (interaction.customId === "staff_application_modal") {
    if (typeof ctx.createTicket !== "function") return false;
    const age = String(interaction.fields.getTextInputValue("age") || "").trim();
    const timezone = String(interaction.fields.getTextInputValue("timezone") || "").trim();
    const experience = String(interaction.fields.getTextInputValue("experience") || "").trim();
    const availability = String(interaction.fields.getTextInputValue("availability") || "").trim() || "Not provided";
    const why = String(interaction.fields.getTextInputValue("why") || "").trim();

    const appId = `APP-${Date.now().toString(36)}`;
    const answersText = [
      `Age: ${age}`,
      `Timezone: ${timezone}`,
      `Experience: ${experience}`,
      `Availability: ${availability}`,
      `Why: ${why}`
    ].join("\n");

    const all = load("applications", []);
    all.push({
      id: appId,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      type: "staff-ticket",
      answers: answersText,
      answersMap: { age, timezone, experience, availability, why },
      status: "pending",
      reviewedBy: null,
      note: null,
      createdAt: Date.now(),
      reviewedAt: null,
      source: "ticket-modal"
    });
    save("applications", all);

    const result = await ctx.createTicket(interaction.guild, interaction.user, "application", {
      age,
      timezone,
      experience,
      availability,
      why,
      applicationId: appId
    });

    await interaction.reply({
      embeds: [ctx.makeEmbed(result.exists ? "Application Already Open" : "Application Submitted", `${result.channel}\nApplication ID: \`${appId}\``, result.exists ? "warn" : "success")],
      ephemeral: true
    });

    await ctx.sendTypedLog(interaction.guild, "member", "Application Submitted", `${interaction.user.tag} submitted a staff application via ticket modal.`, "info", [
      { name: "Application ID", value: appId, inline: true },
      { name: "Channel", value: `${result.channel}`, inline: true }
    ]);
    return true;
  }

  if (interaction.customId === "ticket_close_reason_modal") {
    const canManageTickets = typeof ctx.canManageTicketsCommand === "function"
      ? ctx.canManageTicketsCommand(interaction.member)
      : ctx.canUseModCommand(interaction.member);
    if (!canManageTickets) {
      await interaction.reply({ embeds: [ctx.makeEmbed("No Permission", "Only staff can close tickets.", "error")], ephemeral: true });
      return true;
    }
    const reason = String(interaction.fields.getTextInputValue("close_reason") || "").trim() || "Closed via ticket button";
    return closeTicket(interaction, ctx, { reason, source: "close-button-modal", hardDelete: false });
  }
  return false;
}

module.exports = {
  onReady,
  flushPersistence,
  handleCommand,
  handleButton,
  handleModal,
  handleMessageCreate,
  handleMessageDelete,
  handleMemberAdd,
  handleMemberRemove,
  handleReactionAdd
};

