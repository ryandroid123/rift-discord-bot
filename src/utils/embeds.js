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
  return {
    title,
    description,
    color: color(type),
    fields,
    timestamp: new Date().toISOString()
  };
}

module.exports = { makeEmbed };
