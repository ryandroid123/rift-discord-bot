# GOAT Discord Bot

## What this includes
- Moderation: timeout, untimeout, ban, kick, purge, lock, unlock, slowmode, warn, warnings
- Tickets: support + staff applications, claim, close, transcripts
- Giveaways: persistent, reroll, post in current channel
- AutoMod: invite links, blocked words, caps spam, repeat spam, mention spam, suspicious links
- Anti-nuke: audit-log based watchers for channel/role/webhook deletes & creates, role permission escalations, threshold punishment + lockdown mode
- Invite tracker
- Welcome system with auto role `Player`
- Daily riddle post to `💬┃chat`
- Utility commands: ping, allcommands, userinfo, serverstats, poll

## Install
```bash
npm install
```

## Run
```bash
npm start
```

## Required server setup
Create these roles if they do not already exist:
- Founder
- Admin
- Moderator
- Player

Create these channels if they do not already exist:
- support
- staff-applications
- bot-logs
- ticket-transcripts
- 💬┃chat

The bot will create the `Tickets` category if missing.

## Important
Top-tier anti-nuke on Discord is never perfect. Audit logs are not instant, and nothing protects a server if the bot token is compromised or the attacker outranks the bot.
