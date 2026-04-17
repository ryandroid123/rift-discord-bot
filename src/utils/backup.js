const { ChannelType } = require("discord.js");

function toLowerSafe(value) {
  return String(value || "").trim().toLowerCase();
}

function buildBackupId() {
  return `bkp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function snapshotRole(role) {
  return {
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    position: role.position
  };
}

function snapshotOverwrites(channel, guild) {
  const out = [];
  const overwrites = channel?.permissionOverwrites?.cache;
  if (!overwrites || typeof overwrites.values !== "function") return out;

  for (const overwrite of overwrites.values()) {
    try {
      const allow = overwrite?.allow?.bitfield?.toString?.() || "0";
      const deny = overwrite?.deny?.bitfield?.toString?.() || "0";
      const overwriteType = overwrite?.type;

      if (overwriteType === 0) {
        const role = guild?.roles?.cache?.get?.(overwrite.id);
        if (!role) continue;
        out.push({
          kind: "role",
          name: role.name,
          allow,
          deny
        });
        continue;
      }

      if (overwrite?.id) {
        out.push({
          kind: "member",
          id: overwrite.id,
          allow,
          deny
        });
      }
    } catch {
      continue;
    }
  }

  return out;
}

function snapshotChannel(channel, guild) {
  if (!channel || typeof channel !== "object") return null;

  let parentName = null;
  try {
    parentName = channel.parent?.name || null;
  } catch {}

  let position = 0;
  try {
    position = channel.rawPosition ?? channel.position ?? 0;
  } catch {}

  let topic = null;
  try {
    topic = channel.topic || null;
  } catch {}

  let nsfw = false;
  try {
    nsfw = !!channel.nsfw;
  } catch {}

  let rateLimitPerUser = 0;
  try {
    rateLimitPerUser = channel.rateLimitPerUser || 0;
  } catch {}

  return {
    name: channel.name || "unknown-channel",
    type: channel.type,
    parentName,
    topic,
    nsfw,
    rateLimitPerUser,
    position,
    permissionOverwrites: snapshotOverwrites(channel, guild)
  };
}

function createGuildBackupSnapshot(guild, createdBy) {
  const roles = [...(guild?.roles?.cache?.values?.() || [])]
    .filter(role => role.id !== guild.id)
    .sort((a, b) => a.position - b.position)
    .map(snapshotRole);

  const channels = [...(guild?.channels?.cache?.values?.() || [])]
    .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0))
    .map(channel => {
      try {
        return snapshotChannel(channel, guild);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return {
    id: buildBackupId(),
    guildId: guild.id,
    guildName: guild.name,
    createdBy,
    createdAt: Date.now(),
    stats: {
      roleCount: roles.length,
      channelCount: channels.length
    },
    roles,
    channels
  };
}

function resolveSupportedType(type) {
  const supported = new Set([
    ChannelType.GuildCategory,
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice
  ]);
  return supported.has(type) ? type : null;
}

function buildOverwritesForRestore(overwrites, guild) {
  const out = [];
  for (const overwrite of overwrites || []) {
    if (overwrite.kind !== "role") continue;
    const role = guild.roles.cache.find(r => toLowerSafe(r.name) === toLowerSafe(overwrite.name));
    if (!role) continue;
    out.push({
      id: role.id,
      allow: overwrite.allow || "0",
      deny: overwrite.deny || "0"
    });
  }
  return out;
}

function findChannelByNameAndType(guild, name, type) {
  return guild.channels.cache.find(
    channel => toLowerSafe(channel.name) === toLowerSafe(name) && channel.type === type
  ) || null;
}

async function restoreGuildBackupSnapshot(guild, snapshot, options = {}) {
  const dryRun = options.dryRun !== false;
  const result = {
    dryRun,
    rolesCreated: 0,
    rolesSkippedExisting: 0,
    channelsCreated: 0,
    channelsSkippedExisting: 0,
    unsupportedChannelsSkipped: 0
  };

  const roleData = [...(snapshot.roles || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
  for (const role of roleData) {
    const existing = guild.roles.cache.find(r => toLowerSafe(r.name) === toLowerSafe(role.name));
    if (existing) {
      result.rolesSkippedExisting += 1;
      continue;
    }
    if (!dryRun) {
      await guild.roles.create({
        name: role.name,
        color: role.color || 0,
        hoist: !!role.hoist,
        mentionable: !!role.mentionable,
        permissions: role.permissions || "0",
        reason: "Backup restore"
      }).catch(() => null);
    }
    result.rolesCreated += 1;
  }

  const categories = (snapshot.channels || []).filter(c => c.type === ChannelType.GuildCategory);
  const nonCategories = (snapshot.channels || []).filter(c => c.type !== ChannelType.GuildCategory);

  for (const ch of categories) {
    const type = resolveSupportedType(ch.type);
    if (!type) {
      result.unsupportedChannelsSkipped += 1;
      continue;
    }
    const existing = findChannelByNameAndType(guild, ch.name, type);
    if (existing) {
      result.channelsSkippedExisting += 1;
      continue;
    }
    if (!dryRun) {
      await guild.channels.create({
        name: ch.name,
        type,
        position: ch.position ?? undefined,
        permissionOverwrites: buildOverwritesForRestore(ch.permissionOverwrites, guild),
        reason: "Backup restore"
      }).catch(() => null);
    }
    result.channelsCreated += 1;
  }

  for (const ch of nonCategories) {
    const type = resolveSupportedType(ch.type);
    if (!type) {
      result.unsupportedChannelsSkipped += 1;
      continue;
    }
    const existing = findChannelByNameAndType(guild, ch.name, type);
    if (existing) {
      result.channelsSkippedExisting += 1;
      continue;
    }

    let parentId = null;
    if (ch.parentName) {
      const parent = guild.channels.cache.find(c =>
        c.type === ChannelType.GuildCategory && toLowerSafe(c.name) === toLowerSafe(ch.parentName)
      );
      parentId = parent?.id || null;
    }

    if (!dryRun) {
      await guild.channels.create({
        name: ch.name,
        type,
        parent: parentId || undefined,
        topic: ch.topic || undefined,
        nsfw: !!ch.nsfw,
        rateLimitPerUser: ch.rateLimitPerUser || 0,
        position: ch.position ?? undefined,
        permissionOverwrites: buildOverwritesForRestore(ch.permissionOverwrites, guild),
        reason: "Backup restore"
      }).catch(() => null);
    }
    result.channelsCreated += 1;
  }

  return result;
}

module.exports = {
  createGuildBackupSnapshot,
  restoreGuildBackupSnapshot
};
