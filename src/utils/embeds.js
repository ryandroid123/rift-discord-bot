const { EmbedBuilder } = require("discord.js");

function color(type = "info") {
  return {
    success: 0x57f287,
    error: 0xed4245,
    warn: 0xfee75c,
    info: 0x5865f2,
    neutral: 0x2b2d31
  }[type] || 0x5865f2;
}

function makeEmbed(title, description, type = "info", fields = []) {
  const e = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color(type))
    .setTimestamp();

  if (fields.length) e.addFields(fields);
  return e;
}

module.exports = { makeEmbed };