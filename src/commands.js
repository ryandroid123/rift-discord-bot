module.exports = [
  { name: "ping", description: "Check if the bot is online." },
  { name: "allcommands", description: "Show all bot commands." },

  { name: "setup-support-panel", description: "Post the support ticket panel." },
  { name: "setup-application-panel", description: "Post the application ticket panel." },
  { name: "close", description: "Close the current ticket." },

  {
    name: "timeout",
    description: "Timeout a member.",
    options: [
      { name: "user", type: 6, required: true, description: "User" },
      { name: "duration", type: 3, required: true, description: "10m, 1h, 1d" },
      { name: "reason", type: 3, required: false, description: "Reason" }
    ]
  },
  {
    name: "untimeout",
    description: "Remove a timeout from a member.",
    options: [
      { name: "user", type: 6, required: true, description: "User" },
      { name: "reason", type: 3, required: false, description: "Reason" }
    ]
  },
  {
    name: "ban",
    description: "Ban a member.",
    options: [
      { name: "user", type: 6, required: true, description: "User" },
      { name: "reason", type: 3, required: false, description: "Reason" }
    ]
  },
  {
    name: "kick",
    description: "Kick a member.",
    options: [
      { name: "user", type: 6, required: true, description: "User" },
      { name: "reason", type: 3, required: false, description: "Reason" }
    ]
  },
  {
    name: "purge",
    description: "Delete messages.",
    options: [{ name: "amount", type: 4, required: true, description: "1-100" }]
  },
  { name: "lock", description: "Lock the current channel." },
  { name: "unlock", description: "Unlock the current channel." },
  {
    name: "slowmode",
    description: "Set channel slowmode.",
    options: [{ name: "seconds", type: 4, required: true, description: "0-21600" }]
  },
  {
    name: "warn",
    description: "Warn a member.",
    options: [
      { name: "user", type: 6, required: true, description: "User" },
      { name: "reason", type: 3, required: true, description: "Reason" }
    ]
  },
  {
    name: "warnings",
    description: "See a member's warnings.",
    options: [{ name: "user", type: 6, required: true, description: "User" }]
  },
  {
    name: "invites",
    description: "Check tracked invites for yourself or another user.",
    options: [{ name: "user", type: 6, required: false, description: "User" }]
  },
  {
    name: "case",
    description: "View a moderation case by case ID.",
    options: [{ name: "caseid", type: 3, required: true, description: "Case ID" }]
  },
  {
    name: "cases",
    description: "List recent moderation cases for a user.",
    options: [
      { name: "user", type: 6, required: true, description: "User" },
      { name: "limit", type: 4, required: false, description: "1-20" }
    ]
  },
  {
    name: "history",
    description: "View moderation/security history for a user.",
    options: [{ name: "user", type: 6, required: true, description: "User" }]
  },
  {
    name: "noteadd",
    description: "Add an internal staff note for a user.",
    options: [
      { name: "user", type: 6, required: true, description: "User" },
      { name: "text", type: 3, required: true, description: "Note content" }
    ]
  },
  {
    name: "notes",
    description: "View staff notes for a user.",
    options: [{ name: "user", type: 6, required: true, description: "User" }]
  },
  {
    name: "noteremove",
    description: "Remove a staff note by ID.",
    options: [
      { name: "user", type: 6, required: true, description: "User" },
      { name: "noteid", type: 3, required: true, description: "Note ID" }
    ]
  },
  {
    name: "backup",
    description: "Create, list, or restore a server backup.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "create/list/restore/restorelatest",
        choices: [
          { name: "create", value: "create" },
          { name: "list", value: "list" },
          { name: "restore", value: "restore" },
          { name: "restorelatest", value: "restorelatest" }
        ]
      },
      { name: "backup_id", type: 3, required: false, description: "Backup ID for restore" },
      { name: "confirm", type: 5, required: false, description: "Set true to apply restore" }
    ]
  },
  {
    name: "lockdown",
    description: "Set lockdown mode on/off/panic for this server.",
    options: [
      {
        name: "mode",
        type: 3,
        required: true,
        description: "on/off/panic",
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
          { name: "panic", value: "panic" }
        ]
      },
      { name: "confirm", type: 5, required: false, description: "Set true to confirm" }
    ]
  },
  {
    name: "configview",
    description: "View runtime config overrides for a group.",
    options: [{
      name: "group",
      type: 3,
      required: true,
      description: "automod/antinuke/channels/backup",
      choices: [
        { name: "automod", value: "automod" },
        { name: "antinuke", value: "antinuke" },
        { name: "channels", value: "channels" },
        { name: "backup", value: "backup" }
      ]
    }]
  },
  {
    name: "configset",
    description: "Set a runtime config value (no redeploy).",
    options: [
      {
        name: "group",
        type: 3,
        required: true,
        description: "automod/antinuke/channels/backup",
        choices: [
          { name: "automod", value: "automod" },
          { name: "antinuke", value: "antinuke" },
          { name: "channels", value: "channels" },
          { name: "backup", value: "backup" }
        ]
      },
      { name: "key", type: 3, required: true, description: "Key path (dot notation supported)" },
      { name: "value", type: 3, required: true, description: "JSON/number/boolean/string value" }
    ]
  },
  {
    name: "stats",
    description: "View moderation/security analytics.",
    options: [{ name: "scope", type: 3, required: false, description: "overview/automod/security/traffic" }]
  },
  {
    name: "risk",
    description: "View a user's risk score.",
    options: [{ name: "user", type: 6, required: true, description: "User" }]
  },
  {
    name: "timeline",
    description: "View audit trail timeline.",
    options: [
      { name: "user", type: 6, required: false, description: "User" },
      { name: "limit", type: 4, required: false, description: "1-30" }
    ]
  },
  {
    name: "purgeplus",
    description: "Advanced purge by filter.",
    options: [
      {
        name: "mode",
        type: 3,
        required: true,
        description: "all/user/keyword/links/attachments",
        choices: [
          { name: "all", value: "all" },
          { name: "user", value: "user" },
          { name: "keyword", value: "keyword" },
          { name: "links", value: "links" },
          { name: "attachments", value: "attachments" }
        ]
      },
      { name: "limit", type: 4, required: true, description: "1-500 messages to scan" },
      { name: "user", type: 6, required: false, description: "User (for mode=user)" },
      { name: "keyword", type: 3, required: false, description: "Keyword (for mode=keyword)" },
      { name: "minutes", type: 4, required: false, description: "Only include last X minutes" }
    ]
  },
  {
    name: "giveaway",
    description: "Create a giveaway in the current channel.",
    options: [
      { name: "duration", type: 3, required: true, description: "10m, 1h, 1d" },
      { name: "prize", type: 3, required: true, description: "Prize" }
    ]
  },
  {
    name: "reroll",
    description: "Reroll a giveaway.",
    options: [{ name: "messageid", type: 3, required: true, description: "Giveaway message ID" }]
  },
  {
    name: "userinfo",
    description: "Show info about a user.",
    options: [{ name: "user", type: 6, required: false, description: "User" }]
  },
  { name: "serverstats", description: "Show server stats." },
 {
  name: "poll",
  description: "Create a custom poll.",
  options: [
    { name: "question", type: 3, required: true, description: "Question" },
    { name: "answer1", type: 3, required: true, description: "First answer" },
    { name: "answer2", type: 3, required: true, description: "Second answer" },
    { name: "answer3", type: 3, required: false, description: "Third answer" },
    { name: "answer4", type: 3, required: false, description: "Fourth answer" }
  ]
},
  {
    name: "sayembed",
    description: "Send a custom embed.",
    options: [
      { name: "title", type: 3, required: true, description: "Title" },
      { name: "description", type: 3, required: true, description: "Description" }
    ]
  },
  {
    name: "avatar",
    description: "Show a user's avatar.",
    options: [{ name: "user", type: 6, required: false, description: "User" }]
  },
  {
    name: "roleinfo",
    description: "Show info about a role.",
    options: [{ name: "role", type: 8, required: true, description: "Role" }]
  },
  {
    name: "suggest",
    description: "Post a suggestion.",
    options: [{ name: "idea", type: 3, required: true, description: "Your suggestion" }]
  },
  { name: "riddle", description: "Post a random riddle." },
  {
    name: "addstream",
    description: "Add a streamer/platform watcher.",
    options: [
      { name: "name", type: 3, required: true, description: "Display name" },
      { name: "platform", type: 3, required: true, description: "twitch/youtube/kick/tiktok/x" },
      { name: "handle", type: 3, required: true, description: "username or channel id" }
    ]
  },
  { name: "streams", description: "List all stream trackers." },
  {
    name: "removestream",
    description: "Remove a stream tracker.",
    options: [{ name: "name", type: 3, required: true, description: "Display name" }]
  },
  {
    name: "afk",
    description: "Set your AFK status.",
    options: [{ name: "reason", type: 3, required: false, description: "Reason" }]
  },
  { name: "snipe", description: "Show the last deleted message in this channel." }
];
