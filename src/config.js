module.exports = {
  timezone: "Europe/London",
  autoRole: "Player",

  staffRoles: ["Founder", "Admin", "Moderator"],

  roles: {
    streamPing: "Stream"
  },

  channels: {
    support: "support",
    applications: "staff-application",
    logs: "bot-logs",
    transcripts: "ticket-transcripts",
    giveaways: "🎂┃giveaways",
    streams: "📡┃stream-alerts",
    posts: "🎥┃posts",
    landing: "🛬┃landing",
    takeoff: "🛫┃takeoff",
    rules: "🏫┃rules",
    chat: "💬┃chat"
  },

  categories: {
    tickets: "tickets"
  },

  rules: [
    "Be respectful to everyone.",
    "No racism, harassment, hate speech, or threats.",
    "No NSFW content.",
    "No scam links, phishing, or malicious files.",
    "No advertising other servers without permission.",
    "Do not spam messages, emojis, mentions, or reactions.",
    "Use channels for their proper purpose.",
    "Do not impersonate staff or other members.",
    "Do not evade punishments.",
    "Staff decisions are final."
  ],

  automod: {
    blockedWords: [
      "discord.gg/",
      "discord.com/invite/",
      "gg/",
      "nigg",
      "faggot",
      "kys"
    ],
    suspiciousLinkPatterns: [
      "grabify",
      "iplogger",
      "bit.ly",
      "tinyurl",
      "t.ly",
      "goo.gl"
    ],
    maxMentions: 5,
    capsThreshold: 0.72,
    capsMinLetters: 12,
    repeatWindowMs: 8000,
    repeatLimit: 4,
    capsBypassRoles: ["Founder"]
  },

  antinuke: {
    threshold: 3,
    windowMs: 30000,
    punishmentTimeoutMs: 7 * 24 * 60 * 60 * 1000
  },

  social: {
    checkIntervalMs: 120000
  },

  riddle: {
    hour: 9,
    minute: 0,
    riddles: [
      "What has keys but can't open locks?",
      "What gets wetter the more it dries?",
      "What has hands but cannot clap?",
      "The more you take, the more you leave behind. What am I?",
      "What can travel around the world while staying in one corner?",
      "What has one eye but cannot see?",
      "What is full of holes but still holds water?",
      "What comes once in a minute, twice in a moment, but never in a thousand years?",
      "What has a neck but no head?",
      "What has many teeth but cannot bite?",
      "What goes up but never comes down?",
      "What has one head, one foot, and four legs?",
      "What has words but never speaks?",
      "What kind of band never plays music?",
      "What has cities, but no houses; forests, but no trees; and water, but no fish?",
      "What can you catch, but not throw?",
      "What begins with T, ends with T, and has T in it?",
      "What belongs to you, but other people use it more than you do?",
      "What has an eye, but cannot see?",
      "What gets bigger the more you take away from it?",
      "What has 13 hearts, but no other organs?",
      "What has legs, but doesn’t walk?",
      "What can fill a room but takes up no space?",
      "What runs, but never walks?",
      "What breaks yet never falls, and what falls yet never breaks?"
    ]
  }
};
