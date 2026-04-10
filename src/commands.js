const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

module.exports = [
  new SlashCommandBuilder().setName("ping").setDescription("Check if the bot is online.").toJSON(),
  new SlashCommandBuilder().setName("allcommands").setDescription("Show all bot commands.").toJSON(),

  new SlashCommandBuilder().setName("setup-support-panel").setDescription("Post the support ticket panel.").toJSON(),
  new SlashCommandBuilder().setName("setup-application-panel").setDescription("Post the application ticket panel.").toJSON(),
  new SlashCommandBuilder().setName("close").setDescription("Close the current ticket.").setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels).toJSON(),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member.")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("10m, 1h, 1d").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove a timeout from a member.")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member.")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member.")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete messages.")
    .addIntegerOption(o => o.setName("amount").setDescription("1-100").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock the current channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock the current channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set channel slowmode.")
    .addIntegerOption(o => o.setName("seconds").setDescription("0-21600").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member.")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("See a member's warnings.")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("invites")
    .setDescription("Check tracked invites for yourself or another user.")
    .addUserOption(o => o.setName("user").setDescription("User"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Create a giveaway in the current channel.")
    .addStringOption(o => o.setName("duration").setDescription("10m, 1h, 1d").setRequired(true))
    .addStringOption(o => o.setName("prize").setDescription("Prize").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("reroll")
    .setDescription("Reroll a giveaway.")
    .addStringOption(o => o.setName("messageid").setDescription("Giveaway message ID").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Show info about a user.")
    .addUserOption(o => o.setName("user").setDescription("User"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("serverstats")
    .setDescription("Show server stats.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Create a yes/no poll.")
    .addStringOption(o => o.setName("question").setDescription("Question").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("sayembed")
    .setDescription("Send a custom embed.")
    .addStringOption(o => o.setName("title").setDescription("Title").setRequired(true))
    .addStringOption(o => o.setName("description").setDescription("Description").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a user's avatar.")
    .addUserOption(o => o.setName("user").setDescription("User"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("roleinfo")
    .setDescription("Show info about a role.")
    .addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("suggest")
    .setDescription("Post a suggestion.")
    .addStringOption(o => o.setName("idea").setDescription("Your suggestion").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("riddle")
    .setDescription("Post a random riddle.")
    .toJSON()
];