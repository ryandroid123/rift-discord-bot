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
    logs: "🤖┃bot-logs",
    securityLogs: "🤖┃bot-logs",
    moderationLogs: "🤖┃bot-logs",
    messageLogs: "🤖┃bot-logs",
    memberLogs: "🤖┃bot-logs",
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
    enabled: true,
    whitelistRoles: ["Founder"],
    whitelistChannels: [],
    whitelistUserIds: [],
    blockedWords: [
      "discord.gg/",
      "discord.com/invite/",
      "gg/",
      "nigg",
      "faggot",
      "kys"
    ],
    blockedTerms: [],
    suspiciousLinkPatterns: [
      "grabify",
      "iplogger",
      "bit.ly",
      "tinyurl",
      "t.ly",
      "goo.gl"
    ],
    antiInvite: true,
    antiPhishing: true,
    maxMentions: 5,
    capsThreshold: 0.72,
    capsMinLetters: 12,
    maxEmoji: 10,
    maxLineBreaks: 10,
    maxChars: 1200,
    charFloodRepeat: 20,
    maxZalgoMarks: 10,
    spamWindowMs: 6000,
    spamLimit: 6,
    repeatWindowMs: 8000,
    repeatLimit: 3,
    duplicateWindowMs: 20000,
    duplicateLimit: 4,
    repeatedLinkLimit: 3,
    repeatedAttachmentLimit: 3,
    timeoutThreshold: 2,
    timeoutMs: 10 * 60 * 1000,
    severeTimeoutThreshold: 4,
    severeTimeoutMs: 60 * 60 * 1000,
    kickThreshold: 6,
    banThreshold: 8,
    allowKick: false,
    allowBan: false,
    capsBypassRoles: ["Founder"],
    antiRaid: {
      enabled: true,
      windowMs: 15000,
      joinLimit: 8,
      action: "log",
      slowmodeSeconds: 10
    },
    minMessageLengthForAggressiveChecks: 6
  },

  antinuke: {
    threshold: 3,
    windowMs: 30000,
    punishmentTimeoutMs: 7 * 24 * 60 * 60 * 1000,
    trustedUserIds: [],
    actionThresholds: {
      channelDelete: { threshold: 2, windowMs: 20000 },
      channelCreate: { threshold: 6, windowMs: 20000 },
      roleDelete: { threshold: 2, windowMs: 20000 },
      roleCreate: { threshold: 6, windowMs: 20000 },
      rolePermissionEscalation: { threshold: 2, windowMs: 30000 },
      webhookChange: { threshold: 3, windowMs: 20000 },
      memberBan: { threshold: 4, windowMs: 20000 },
      memberKick: { threshold: 5, windowMs: 20000 },
      memberTimeout: { threshold: 8, windowMs: 20000 },
      memberPrune: { threshold: 1, windowMs: 30000 },
      guildUpdate: { threshold: 3, windowMs: 30000 },
      botAdd: { threshold: 2, windowMs: 30000 }
    },
    emergency: {
      stripDangerousPermissions: true,
      panicLockdown: true,
      timeoutOffender: true,
      kickOffender: false,
      banOffender: false
    }
  },

  social: {
    checkIntervalMs: 120000
  },

  backup: {
    maxStored: 20
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
