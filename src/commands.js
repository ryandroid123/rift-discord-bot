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
    name: "backup",
    description: "Create, list, or restore a server backup.",
    options: [
      { name: "action", type: 3, required: true, description: "create/list/restore" },
      { name: "backup_id", type: 3, required: false, description: "Backup ID for restore" },
      { name: "confirm", type: 5, required: false, description: "Set true to apply restore" }
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
