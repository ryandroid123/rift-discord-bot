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
    name: "clearautomod",
    description: "Clear automod carryover state and apply recovery grace.",
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
    name: "inviteleaderboard",
    description: "Show the top inviters in this server."
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
      { name: "prize", type: 3, required: true, description: "Prize" },
      { name: "winners", type: 4, required: false, description: "Number of winners" },
      { name: "required_role", type: 8, required: false, description: "Role required to join" },
      { name: "blacklist_role", type: 8, required: false, description: "Role blocked from joining" },
      { name: "bonus_role", type: 8, required: false, description: "Role with bonus entries" },
      { name: "bonus_entries", type: 4, required: false, description: "Bonus entries for bonus role" }
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
    { name: "answer4", type: 3, required: false, description: "Fourth answer" },
    { name: "answer5", type: 3, required: false, description: "Fifth answer" },
    { name: "answer6", type: 3, required: false, description: "Sixth answer" },
    { name: "duration", type: 3, required: false, description: "Auto-end duration (10m, 1h)" },
    { name: "anonymous", type: 5, required: false, description: "Hide creator in poll embed" }
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
    options: [
      { name: "idea", type: 3, required: true, description: "Your suggestion" },
      { name: "anonymous", type: 5, required: false, description: "Post anonymously" }
    ]
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
  { name: "snipe", description: "Show the last deleted message in this channel." },
  {
    name: "giveawaymanage",
    description: "Manage giveaway state.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "end/info",
        choices: [
          { name: "end", value: "end" },
          { name: "info", value: "info" }
        ]
      },
      { name: "messageid", type: 3, required: true, description: "Giveaway message ID" }
    ]
  },
  {
    name: "ticket",
    description: "Ticket management actions.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "claim/close/note/transcriptsearch",
        choices: [
          { name: "claim", value: "claim" },
          { name: "close", value: "close" },
          { name: "note", value: "note" },
          { name: "transcriptsearch", value: "transcriptsearch" }
        ]
      },
      { name: "reason", type: 3, required: false, description: "Close reason, note, or search text" }
    ]
  },
  {
    name: "welcome",
    description: "Welcome and leave message settings.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "set/dm/autorole/image/leave/show",
        choices: [
          { name: "set", value: "set" },
          { name: "dm", value: "dm" },
          { name: "autorole", value: "autorole" },
          { name: "image", value: "image" },
          { name: "leave", value: "leave" },
          { name: "show", value: "show" }
        ]
      },
      { name: "text", type: 3, required: false, description: "Template text or image URL" },
      { name: "image_file", type: 11, required: false, description: "Upload an image for welcome branding" },
      { name: "role", type: 8, required: false, description: "Auto-role for joins" }
    ]
  },
  {
    name: "level",
    description: "Leveling controls and stats.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "rank/leaderboard/toggle/reward",
        choices: [
          { name: "rank", value: "rank" },
          { name: "leaderboard", value: "leaderboard" },
          { name: "toggle", value: "toggle" },
          { name: "reward", value: "reward" }
        ]
      },
      { name: "enabled", type: 5, required: false, description: "Enable leveling (toggle)" },
      { name: "level", type: 4, required: false, description: "Level threshold (reward)" },
      { name: "role", type: 8, required: false, description: "Reward role (reward)" },
      { name: "user", type: 6, required: false, description: "Target user for rank" }
    ]
  },
  {
    name: "economy",
    description: "Server currency commands.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "balance/grant/take/pay",
        choices: [
          { name: "balance", value: "balance" },
          { name: "grant", value: "grant" },
          { name: "take", value: "take" },
          { name: "pay", value: "pay" }
        ]
      },
      { name: "user", type: 6, required: false, description: "Target user" },
      { name: "amount", type: 4, required: false, description: "Amount" }
    ]
  },
  {
    name: "suggestion",
    description: "Suggestion review and response.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "approve/deny/respond",
        choices: [
          { name: "approve", value: "approve" },
          { name: "deny", value: "deny" },
          { name: "respond", value: "respond" }
        ]
      },
      { name: "messageid", type: 3, required: true, description: "Suggestion message ID" },
      { name: "text", type: 3, required: false, description: "Reason or response text" }
    ]
  },
  {
    name: "application",
    description: "Application system actions.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "submit/review/list",
        choices: [
          { name: "submit", value: "submit" },
          { name: "review", value: "review" },
          { name: "list", value: "list" }
        ]
      },
      { name: "type", type: 3, required: false, description: "staff/creator/partnership" },
      { name: "answers", type: 3, required: false, description: "Structured answers text" },
      { name: "id", type: 3, required: false, description: "Application ID for review" },
      { name: "status", type: 3, required: false, description: "approved/denied/pending" },
      { name: "note", type: 3, required: false, description: "Review note" }
    ]
  },
  {
    name: "partnership",
    description: "Partnership manager.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "template/post/bump",
        choices: [
          { name: "template", value: "template" },
          { name: "post", value: "post" },
          { name: "bump", value: "bump" }
        ]
      },
      { name: "server", type: 3, required: false, description: "Partner server name" },
      { name: "invite", type: 3, required: false, description: "Invite URL" }
    ]
  },
  {
    name: "mediaonly",
    description: "Manage media-only channels.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "add/remove/list",
        choices: [
          { name: "add", value: "add" },
          { name: "remove", value: "remove" },
          { name: "list", value: "list" }
        ]
      },
      { name: "channel", type: 7, required: false, description: "Target channel" }
    ]
  },
  {
    name: "sticky",
    description: "Manage sticky messages.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "set/clear",
        choices: [
          { name: "set", value: "set" },
          { name: "clear", value: "clear" }
        ]
      },
      { name: "text", type: 3, required: false, description: "Sticky text" },
      { name: "cooldown_seconds", type: 4, required: false, description: "Repost cooldown" }
    ]
  },
  {
    name: "starboard",
    description: "Configure starboard.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "set/off",
        choices: [
          { name: "set", value: "set" },
          { name: "off", value: "off" }
        ]
      },
      { name: "channel", type: 7, required: false, description: "Starboard channel" },
      { name: "emoji", type: 3, required: false, description: "Emoji (default ⭐)" },
      { name: "threshold", type: 4, required: false, description: "Minimum reactions" }
    ]
  },
  {
    name: "remind",
    description: "Create a reminder.",
    options: [
      { name: "time", type: 3, required: true, description: "10m, 2h, 1d" },
      { name: "text", type: 3, required: true, description: "Reminder text" }
    ]
  },
  {
    name: "countdown",
    description: "Countdown and event reminders.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "create/list",
        choices: [
          { name: "create", value: "create" },
          { name: "list", value: "list" }
        ]
      },
      { name: "name", type: 3, required: false, description: "Event name" },
      { name: "time", type: 3, required: false, description: "When it ends (10m, 2h, 1d)" }
    ]
  },
  {
    name: "rolemenu",
    description: "Create button role menus.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "create",
        choices: [
          { name: "create", value: "create" }
        ]
      },
      { name: "title", type: 3, required: true, description: "Menu title" },
      { name: "role1", type: 8, required: true, description: "Role 1" },
      { name: "role2", type: 8, required: false, description: "Role 2" },
      { name: "role3", type: 8, required: false, description: "Role 3" }
    ]
  },
  {
    name: "embedbuilder",
    description: "Build and post a custom embed.",
    options: [
      { name: "title", type: 3, required: true, description: "Embed title" },
      { name: "description", type: 3, required: true, description: "Embed description" },
      { name: "footer", type: 3, required: false, description: "Footer text" },
      { name: "color", type: 3, required: false, description: "Hex color (#00AAFF)" },
      { name: "field1", type: 3, required: false, description: "Field format: Name|Value" }
    ]
  },
  {
    name: "nick",
    description: "Nickname moderation controls.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "set/reset/rule",
        choices: [
          { name: "set", value: "set" },
          { name: "reset", value: "reset" },
          { name: "rule", value: "rule" }
        ]
      },
      { name: "user", type: 6, required: false, description: "Target user" },
      { name: "value", type: 3, required: false, description: "Nickname or rule regex" }
    ]
  },
  {
    name: "quote",
    description: "Save and fetch quotes.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "save/random/list",
        choices: [
          { name: "save", value: "save" },
          { name: "random", value: "random" },
          { name: "list", value: "list" }
        ]
      },
      { name: "messageid", type: 3, required: false, description: "Message ID to save" }
    ]
  },
  {
    name: "tag",
    description: "Custom tag manager.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "create/edit/delete/use/list",
        choices: [
          { name: "create", value: "create" },
          { name: "edit", value: "edit" },
          { name: "delete", value: "delete" },
          { name: "use", value: "use" },
          { name: "list", value: "list" }
        ]
      },
      { name: "name", type: 3, required: false, description: "Tag name" },
      { name: "content", type: 3, required: false, description: "Tag content" }
    ]
  },
  {
    name: "birthday",
    description: "Birthday tracker.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "set/list",
        choices: [
          { name: "set", value: "set" },
          { name: "list", value: "list" }
        ]
      },
      { name: "date", type: 3, required: false, description: "MM-DD" }
    ]
  },
  {
    name: "serverstatus",
    description: "Show protection, backup, and health status."
  },
  {
    name: "auditdashboard",
    description: "Show recent punishments and bot actions."
  },
  {
    name: "commandcontrol",
    description: "Enable or disable commands by channel or role.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "disable/enable/status",
        choices: [
          { name: "disable", value: "disable" },
          { name: "enable", value: "enable" },
          { name: "status", value: "status" }
        ]
      },
      { name: "command", type: 3, required: false, description: "Command name" },
      { name: "channel", type: 7, required: false, description: "Restrict channel" },
      { name: "role", type: 8, required: false, description: "Restrict role" }
    ]
  },
  {
    name: "maintenance",
    description: "Toggle maintenance mode.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "on/off",
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" }
        ]
      },
      { name: "reason", type: 3, required: false, description: "Maintenance reason" }
    ]
  },
  {
    name: "help",
    description: "Improved help command with search.",
    options: [{ name: "search", type: 3, required: false, description: "Search command name" }]
  },
  {
    name: "onboarding",
    description: "Set onboarding prompts.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "set/show",
        choices: [
          { name: "set", value: "set" },
          { name: "show", value: "show" }
        ]
      },
      { name: "text", type: 3, required: false, description: "Prompt text" }
    ]
  },
  {
    name: "form",
    description: "Custom forms for staff workflows.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "create/submit/list",
        choices: [
          { name: "create", value: "create" },
          { name: "submit", value: "submit" },
          { name: "list", value: "list" }
        ]
      },
      { name: "name", type: 3, required: false, description: "Form name" },
      { name: "schema", type: 3, required: false, description: "Question list or submission text" }
    ]
  },
  {
    name: "reportanon",
    description: "Submit an anonymous report.",
    options: [{ name: "text", type: 3, required: true, description: "Report details" }]
  },
  {
    name: "schedule",
    description: "Scheduled announcements and recurring posts.",
    options: [
      {
        name: "action",
        type: 3,
        required: true,
        description: "create/list/delete",
        choices: [
          { name: "create", value: "create" },
          { name: "list", value: "list" },
          { name: "delete", value: "delete" }
        ]
      },
      { name: "id", type: 3, required: false, description: "Schedule ID (delete)" },
      { name: "interval", type: 3, required: false, description: "10m, 1h, 1d (create)" },
      { name: "text", type: 3, required: false, description: "Announcement text (create)" }
    ]
  }
];
