require("dotenv").config();

const fs = require("fs");
const path = require("path");
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
const { readJson, writeJson } = require("./utils/storage");
const {
  getChannelByName,
  getCategoryByName,
  getRoleByName,
  hasStaffRole,
  getStaffRoles,
  createTicketsCategoryIfMissing,
  panicLockdown
} = require("./utils/setup");

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

const dataDir = path.join(__dirname, "data");
const giveawaysPath = path.join(dataDir, "giveaways.json");
const antinukePath = path.join(dataDir, "antinuke.json");
const warningsPath = path.join(dataDir, "warnings.json");
const statePath = path.join(dataDir, "state.json");

const spamCache = new Map();
const giveawayTimers = new Map();
const inviteCache = new Map();

function logChannel(guild) {
  return getChannelByName(guild, config.channels.logs);
}

function transcriptChannel(guild) {
  return getChannelByName(guild, config.channels.transcripts);
}

function state() {
  return readJson(statePath, { lastRiddleDate: null });
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

async function sendLog(guild, title, description, type = "info", fields = []) {
  const ch = logChannel(guild);
  if (!ch) return;
  await ch.send({ embeds: [makeEmbed(title, description, type, fields)] }).catch(() => {});
}

async function sendTranscript(guild, ticketChannel, lines) {
  const ch = transcriptChannel(guild);
  if (!ch) return;

  const filePath = path.join(dataDir, `${ticketChannel.name}-${Date.now()}.txt`);
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

function recordAntiNuke(guildId, userId, action) {
  const data = readJson(antinukePath, {});
  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) data[guildId][userId] = [];

  const now = Date.now();
  data[guildId][userId] = data[guildId][userId].filter(x => now - x.time <= config.antinuke.windowMs);
  data[guildId][userId].push({ action, time: now });

  writeJson(antinukePath, data);
  return data[guildId][userId].length;
}

async function antiNukeCheck(guild, executorId, action) {
  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return;
  if (!hasStaffRole(member)) return;

  const count = recordAntiNuke(guild.id, executorId, action);

  await sendLog(guild, "Anti-Nuke Alert", `Suspicious action detected: ${action}`, "warn", [
    { name: "User", value: member.user.tag, inline: true },
    { name: "Count", value: String(count), inline: true }
  ]);

  if (count >= config.antinuke.threshold) {
    if (member.moderatable) {
      await member.timeout(config.antinuke.punishmentTimeoutMs, "Anti-nuke triggered").catch(() => {});
    }
    await panicLockdown(guild, "Anti-nuke lockdown triggered").catch(() => {});
    await sendLog(guild, "Anti-Nuke Action", `${member.user.tag} hit the threshold. Timeout + lockdown triggered.`, "error");
  }
}

async function cacheInvitesForGuild(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;
  inviteCache.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses || 0])));
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
          `**Riddle:** ${r.q}\n\n||**Answer:** ${r.a}||`,
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
  console.log("Registering to guild:", process.env.GUILD_ID);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: [] }
    );
    console.log("Old commands cleared.");

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("Commands registered.");
  } catch (err) {
    console.error("REGISTER ERROR:", err);
  }

  for (const guild of client.guilds.cache.values()) {
    await cacheInvitesForGuild(guild);
  }

  for (const giveaway of loadGiveaways().filter(g => !g.ended)) {
    scheduleGiveaway(giveaway);
  }

  startRiddleLoop();
});

client.on(Events.InviteCreate, async invite => {
  await cacheInvitesForGuild(invite.guild).catch(() => {});
});
client.on(Events.InviteDelete, async invite => {
  await cacheInvitesForGuild(invite.guild).catch(() => {});
});

client.on(Events.GuildMemberAdd, async member => {
  const role = getRoleByName(member.guild, config.autoRole);
  if (role) {
    await member.roles.add(role).catch(() => {});
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

  let inviterText = "Unknown";
  const oldMap = inviteCache.get(member.guild.id) || new Map();
  const newInvites = await member.guild.invites.fetch().catch(() => null);

  if (newInvites) {
    const used = newInvites.find(inv => (inv.uses || 0) > (oldMap.get(inv.code) || 0));
    if (used?.inviter) inviterText = `${used.inviter.tag} (${used.code})`;
    inviteCache.set(member.guild.id, new Map(newInvites.map(inv => [inv.code, inv.uses || 0])));
  }

  await sendLog(member.guild, "Member Joined", `${member.user.tag} joined and received the ${config.autoRole} role.`, "success", [
    { name: "Invited By", value: inviterText }
  ]);

  const chat = getChannelByName(member.guild, config.channels.chat);
  if (chat) {
    await chat.send({
      embeds: [makeEmbed("Welcome!", `Welcome ${member} to **${member.guild.name}**. Enjoy your stay.`, "success")]
    }).catch(() => {});
  }
});

client.on(Events.GuildMemberRemove, async member => {
  await sendLog(member.guild, "Member Left", `${member.user.tag} left the server.`, "warn");
});

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;

  const lower = message.content.toLowerCase();

  for (const blocked of config.automod.blockedWords) {
    if (lower.includes(blocked)) {
      await message.delete().catch(() => {});
      await sendLog(message.guild, "AutoMod", `Blocked word/invite removed from ${message.author.tag}.`, "warn");
      return;
    }
  }

  for (const pattern of config.automod.suspiciousLinkPatterns) {
    if (lower.includes(pattern)) {
      await message.delete().catch(() => {});
      await sendLog(message.guild, "AutoMod", `Suspicious link removed from ${message.author.tag}.`, "warn");
      return;
    }
  }

  if (message.mentions.users.size >= config.automod.maxMentions) {
    await message.delete().catch(() => {});
    await sendLog(message.guild, "AutoMod", `Mention spam removed from ${message.author.tag}.`, "warn");
    return;
  }

  const letters = message.content.replace(/[^a-z]/gi, "");
  const caps = letters.replace(/[^A-Z]/g, "").length;
  if (letters.length >= config.automod.capsMinLetters && caps / letters.length >= config.automod.capsThreshold) {
    await message.delete().catch(() => {});
    await sendLog(message.guild, "AutoMod", `Caps spam removed from ${message.author.tag}.`, "warn");
    return;
  }

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const arr = (spamCache.get(key) || []).filter(x => now - x.time <= config.automod.repeatWindowMs);
  arr.push({ time: now, text: message.content });
  spamCache.set(key, arr);

  const repeats = arr.filter(x => x.text === message.content).length;
  if (repeats >= config.automod.repeatLimit) {
    await message.delete().catch(() => {});
    await sendLog(message.guild, "AutoMod", `Repeated spam removed from ${message.author.tag}.`, "warn");
  }
});

async function fetchExecutor(guild, type) {
  const logs = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
  return logs?.entries?.first()?.executorId || null;
}

client.on(Events.ChannelDelete, async channel => {
  if (channel.guild) {
    const executorId = await fetchExecutor(channel.guild, AuditLogEvent.ChannelDelete);
    if (executorId) await antiNukeCheck(channel.guild, executorId, "channel delete");
  }
});

client.on(Events.ChannelCreate, async channel => {
  if (channel.guild) {
    const executorId = await fetchExecutor(channel.guild, AuditLogEvent.ChannelCreate);
    if (executorId) await antiNukeCheck(channel.guild, executorId, "channel create");
  }
});

client.on(Events.RoleDelete, async role => {
  if (role.guild) {
    const executorId = await fetchExecutor(role.guild, AuditLogEvent.RoleDelete);
    if (executorId) await antiNukeCheck(role.guild, executorId, "role delete");
  }
});

client.on(Events.RoleCreate, async role => {
  if (role.guild) {
    const executorId = await fetchExecutor(role.guild, AuditLogEvent.RoleCreate);
    if (executorId) await antiNukeCheck(role.guild, executorId, "role create");
  }
});

client.on(Events.WebhooksUpdate, async channel => {
  if (!channel.guild) return;
  const executorId = await fetchExecutor(channel.guild, AuditLogEvent.WebhookCreate);
  if (executorId) await antiNukeCheck(channel.guild, executorId, "webhook update");
});

client.on(Events.RoleUpdate, async (oldRole, newRole) => {
  const before = new PermissionsBitField(oldRole.permissions.bitfield);
  const after = new PermissionsBitField(newRole.permissions.bitfield);
  const dangerous = [
    PermissionsBitField.Flags.Administrator,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.BanMembers,
    PermissionsBitField.Flags.KickMembers,
    PermissionsBitField.Flags.ManageWebhooks
  ];
  const escalated = dangerous.some(flag => !before.has(flag) && after.has(flag));
  if (!escalated) return;

  const executorId = await fetchExecutor(newRole.guild, AuditLogEvent.RoleUpdate);
  if (executorId) await antiNukeCheck(newRole.guild, executorId, "dangerous role permission escalation");
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === "ping") {
        await interaction.reply({ embeds: [makeEmbed("Pong!", "The bot is online.", "success")] });
        return;
      }

      if (cmd === "allcommands") {
        if (!hasStaffRole(interaction.member)) {
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
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("open_support_ticket").setLabel("Open Support Ticket").setStyle(ButtonStyle.Primary)
          )]
        });
        await interaction.editReply({ embeds: [makeEmbed("Done", "Support panel posted.", "success")] });
        return;
      }

      if (cmd === "setup-application-panel") {
        await interaction.deferReply({ ephemeral: true });
        await interaction.channel.send({
          embeds: [makeEmbed("Staff Applications", "Click below to open a private application ticket.", "info")],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("open_application_ticket").setLabel("Apply For Staff").setStyle(ButtonStyle.Secondary)
          )]
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
        await sendLog(interaction.guild, "Member Timed Out", `${interaction.user.tag} timed out ${user.tag}.`, "warn", [
          { name: "Duration", value: duration, inline: true },
          { name: "Reason", value: reason, inline: true }
        ]);
        return;
      }

      if (cmd === "untimeout") {
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) {
          await interaction.reply({ embeds: [makeEmbed("Error", "User not found.", "error")], ephemeral: true });
          return;
        }
        await target.timeout(null, reason);
        await interaction.reply({ embeds: [makeEmbed("Timeout Removed", `${user.tag}'s timeout was removed.`, "success")] });
        await sendLog(interaction.guild, "Timeout Removed", `${interaction.user.tag} removed ${user.tag}'s timeout.`, "success", [{ name: "Reason", value: reason }]);
        return;
      }

      if (cmd === "ban") {
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason") || "No reason provided";
        await interaction.guild.members.ban(user.id, { reason });
        await interaction.reply({ embeds: [makeEmbed("Member Banned", `${user.tag} has been banned.`, "error")] });
        await sendLog(interaction.guild, "Member Banned", `${interaction.user.tag} banned ${user.tag}.`, "error", [{ name: "Reason", value: reason }]);
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
        await sendLog(interaction.guild, "Member Kicked", `${interaction.user.tag} kicked ${user.tag}.`, "warn", [{ name: "Reason", value: reason }]);
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
        await sendLog(interaction.guild, "Messages Purged", `${interaction.user.tag} purged messages in ${interaction.channel}.`, "warn", [{ name: "Deleted", value: String(deleted.size) }]);
        return;
      }

      if (cmd === "lock") {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });
        await interaction.reply({ embeds: [makeEmbed("Channel Locked", `${interaction.channel} has been locked.`, "warn")] });
        await sendLog(interaction.guild, "Channel Locked", `${interaction.user.tag} locked ${interaction.channel}.`, "warn");
        return;
      }

      if (cmd === "unlock") {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: true });
        await interaction.reply({ embeds: [makeEmbed("Channel Unlocked", `${interaction.channel} has been unlocked.`, "success")] });
        await sendLog(interaction.guild, "Channel Unlocked", `${interaction.user.tag} unlocked ${interaction.channel}.`, "success");
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
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        const count = addWarning(interaction.guild.id, user.id, interaction.user.tag, reason);
        await interaction.reply({ embeds: [makeEmbed("Member Warned", `${user.tag} has been warned.`, "warn", [
          { name: "Reason", value: reason },
          { name: "Total Warnings", value: String(count) }
        ])] });
        await sendLog(interaction.guild, "Member Warned", `${interaction.user.tag} warned ${user.tag}.`, "warn", [
          { name: "Reason", value: reason },
          { name: "Total Warnings", value: String(count) }
        ]);
        return;
      }

      if (cmd === "warnings") {
        const user = interaction.options.getUser("user");
        const warnings = getWarnings(interaction.guild.id, user.id);
        const description = warnings.length
          ? warnings.map((w, i) => `**${i + 1}.** ${w.reason} — ${w.moderatorTag}`).join("\n").slice(0, 4000)
          : "No warnings.";
        await interaction.reply({ embeds: [makeEmbed(`Warnings for ${user.tag}`, description, "info")], ephemeral: true });
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
          embeds: [makeEmbed("🎉 Giveaway Started", `**Prize:** ${prize}\n**Ends:** <t:${Math.floor(endsAt / 1000)}:R>`, "info")],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`join_giveaway_pending`).setLabel("Join Giveaway").setStyle(ButtonStyle.Success)
          )]
        });

        await sent.edit({
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`join_giveaway_${sent.id}`).setLabel("Join Giveaway").setStyle(ButtonStyle.Success)
          )]
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
        await sendLog(interaction.guild, "Giveaway Created", `${interaction.user.tag} created a giveaway.`, "info", [{ name: "Prize", value: prize }]);
        return;
      }

      if (cmd === "reroll") {
        const messageId = interaction.options.getString("messageid");
        const giveaways = loadGiveaways();
        const giveaway = giveaways.find(g => g.messageId === messageId);
        if (!giveaway || !giveaway.entries.length) {
          await interaction.reply({ embeds: [makeEmbed("Error", "That giveaway was not found or has no entries.", "error")], ephemeral: true });
          return;
        }
        const winnerId = giveaway.entries[Math.floor(Math.random() * giveaway.entries.length)];
        giveaway.winnerId = winnerId;
        saveGiveaways(giveaways);
        await interaction.reply({ embeds: [makeEmbed("Giveaway Rerolled", `New winner: <@${winnerId}>`, "success")] });
        return;
      }

      if (cmd === "userinfo") {
        const user = interaction.options.getUser("user") || interaction.user;
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        await interaction.reply({
          embeds: [makeEmbed(`User Info: ${user.tag}`, `ID: ${user.id}`, "info", [
            { name: "Created", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>` },
            { name: "Joined", value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : "Unknown" }
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
        const msg = await interaction.channel.send({
          embeds: [makeEmbed("📊 Poll", question, "info")]
        });
        await msg.react("✅").catch(() => {});
        await msg.react("❌").catch(() => {});
        await interaction.reply({ embeds: [makeEmbed("Poll Created", "Your poll has been posted.", "success")], ephemeral: true });
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

client.login(process.env.DISCORD_TOKEN).catch(console.error);
