const { ChannelType, PermissionsBitField } = require("discord.js");
const config = require("../config");

function getChannelByName(guild, name, type = null) {
  return guild.channels.cache.find(c => c.name === name && (type ? c.type === type : true)) || null;
}

function getCategoryByName(guild, name) {
  return guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildCategory) || null;
}

function getRoleByName(guild, name) {
  return guild.roles.cache.find(r => r.name === name) || null;
}

function hasStaffRole(member) {
  return !!member && config.staffRoles.some(roleName =>
    member.roles.cache.some(role => role.name === roleName)
  );
}

function hasAnyRole(member, roleNames = []) {
  return !!member && roleNames.some(roleName =>
    member.roles.cache.some(role => role.name === roleName)
  );
}

function getStaffRoles(guild) {
  return config.staffRoles.map(name => getRoleByName(guild, name)).filter(Boolean);
}

async function createTicketsCategoryIfMissing(guild) {
  let category = getCategoryByName(guild, config.categories.tickets);
  if (!category) {
    category = await guild.channels.create({
      name: config.categories.tickets,
      type: ChannelType.GuildCategory
    });
  }
  return category;
}

async function panicLockdown(guild, reason = "Anti-nuke lockdown") {
  const roles = getStaffRoles(guild);
  for (const role of roles) {
    const perms = new PermissionsBitField(role.permissions.bitfield);
    perms.remove(
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.Administrator,
      PermissionsBitField.Flags.BanMembers,
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.ManageWebhooks
    );
    await role.setPermissions(perms, reason).catch(() => {});
  }
}

module.exports = {
  getChannelByName,
  getCategoryByName,
  getRoleByName,
  hasStaffRole,
  hasAnyRole,
  getStaffRoles,
  createTicketsCategoryIfMissing,
  panicLockdown
};
