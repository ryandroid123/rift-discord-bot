const { PermissionFlagsBits } = require("discord.js");
const config = require("../config");

function hasStaffRole(member) {
  if (!member?.roles?.cache) return false;
  return config.staffRoleNames.some(name =>
    member.roles.cache.some(role => role.name === name)
  );
}

function getStaffRoles(guild) {
  return config.staffRoleNames
    .map(name => guild.roles.cache.find(role => role.name === name))
    .filter(Boolean);
}

function ticketOverwrites(guild, openerId, staffRoles) {
  const overwrites = [
    {
      id: guild.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: openerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles
      ]
    }
  ];

  for (const role of staffRoles) {
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

module.exports = { hasStaffRole, getStaffRoles, ticketOverwrites };