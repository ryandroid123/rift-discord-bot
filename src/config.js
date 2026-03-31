module.exports = {
  timezone: "Europe/London",
  autoRole: "Player",
  staffRoles: ["Founder", "Admin", "Moderator"],

  channels: {
    support: "support",
    applications: "staff-applications",
    logs: "bot-logs",
    transcripts: "ticket-transcripts",
    chat: "💬┃chat"
  },

  categories: {
    tickets: "Tickets"
  },

  automod: {
    blockedWords: ["discord.gg/", "discord.com/invite/", "gg/", "nigg", "faggot", "kys"],
    maxMentions: 5,
    capsThreshold: 0.72,
    capsMinLetters: 12,
    repeatWindowMs: 8000,
    repeatLimit: 4,
    suspiciousLinkPatterns: ["grabify", "iplogger", "bit.ly", "tinyurl", "t.ly", "goo.gl"]
  },

  antinuke: {
    threshold: 3,
    windowMs: 30000,
    punishmentTimeoutMs: 7 * 24 * 60 * 60 * 1000,
    lockdownRoleNames: ["Founder", "Admin", "Moderator"]
  },

  riddle: {
    hour: 9,
    minute: 0,
    riddles: [
      { q: "What has keys but can't open locks?", a: "A piano." },
      { q: "What gets wetter the more it dries?", a: "A towel." },
      { q: "What has hands but cannot clap?", a: "A clock." },
      { q: "The more you take, the more you leave behind. What am I?", a: "Footsteps." },
      { q: "What can travel around the world while staying in one corner?", a: "A stamp." },
      { q: "What has one eye but cannot see?", a: "A needle." },
      { q: "What is full of holes but still holds water?", a: "A sponge." },
      { q: "What comes once in a minute, twice in a moment, but never in a thousand years?", a: "The letter M." }
    ]
  }
};
