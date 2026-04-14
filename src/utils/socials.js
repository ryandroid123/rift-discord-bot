const fetch = require("node-fetch");
const path = require("path");
const { readJson, writeJson } = require("./storage");

const streamsPath = path.join(__dirname, "../data/streams.json");
const sentCache = new Set();

function loadStreams() {
  return readJson(streamsPath, []);
}

function saveStreams(data) {
  writeJson(streamsPath, data);
}

async function checkTwitch(handle) {
  if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
    try {
      const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: process.env.TWITCH_CLIENT_ID,
          client_secret: process.env.TWITCH_CLIENT_SECRET,
          grant_type: "client_credentials"
        })
      });
      const tokenJson = await tokenRes.json();

      if (tokenJson.access_token) {
        const res = await fetch(
          `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(handle)}`,
          {
            headers: {
              "Client-ID": process.env.TWITCH_CLIENT_ID,
              "Authorization": `Bearer ${tokenJson.access_token}`
            }
          }
        );
        const json = await res.json();
        return !!(json.data && json.data.length);
      }
    } catch {}
  }

  try {
    const res = await fetch(`https://decapi.me/twitch/uptime/${encodeURIComponent(handle)}`);
    const text = await res.text();
    return !text.toLowerCase().includes("offline");
  } catch {
    return false;
  }
}

async function checkYouTube(handle) {
  if (process.env.YOUTUBE_API_KEY) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(handle)}&eventType=live&type=video&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`
      );
      const json = await res.json();
      return !!(json.items && json.items.length);
    } catch {}
  }

  try {
    const res = await fetch(`https://www.youtube.com/channel/${encodeURIComponent(handle)}/live`, {
      redirect: "follow"
    });
    return res.url && res.url.includes("watch");
  } catch {
    return false;
  }
}

async function checkKick(handle) {
  try {
    const res = await fetch(`https://kick.com/${encodeURIComponent(handle)}`);
    const text = await res.text();
    return /isLive["']?\s*:\s*true/i.test(text) || /"livestream":\s*{[^}]*"id":/i.test(text);
  } catch {
    return false;
  }
}

async function checkTikTok(handle) {
  try {
    const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(handle)}/live`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow"
    });

    const finalUrl = res.url || "";
    const text = await res.text();

    if (!finalUrl.includes("/live")) return false;

    return /isLiveBroadcast/i.test(text) ||
           /LIVE now/i.test(text) ||
           /liveRoom/i.test(text) ||
           /"status":2/.test(text);
  } catch {
    return false;
  }
}

async function bestEffortPostSeen(platform, handle) {
  try {
    if (platform === "youtube") {
      const res = await fetch(`https://www.youtube.com/channel/${encodeURIComponent(handle)}/videos`);
      const text = await res.text();
      const m = text.match(/"videoId":"([^"]+)"/);
      return m ? m[1] : null;
    }

    if (platform === "tiktok") {
      const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const text = await res.text();
      const m = text.match(/"id":"(\d{8,})"/);
      return m ? m[1] : null;
    }

    if (platform === "x") {
      const res = await fetch(`https://x.com/${encodeURIComponent(handle)}`, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const text = await res.text();
      const m = text.match(/status\/(\d+)/);
      return m ? m[1] : null;
    }
  } catch {}

  return null;
}

async function checkStreams(client, config, makeEmbed) {
  const streamers = loadStreams();

  for (const guild of client.guilds.cache.values()) {
    const streamChannel = guild.channels.cache.find(c => c.name === config.channels.streams);
    const postChannel = guild.channels.cache.find(c => c.name === config.channels.posts);
    const role = guild.roles.cache.find(r => r.name === config.roles.streamPing);

    for (const s of streamers) {
      let live = false;

      if (s.platform === "twitch") live = await checkTwitch(s.handle);
      if (s.platform === "youtube") live = await checkYouTube(s.handle);
      if (s.platform === "kick") live = await checkKick(s.handle);
      if (s.platform === "tiktok") live = await checkTikTok(s.handle);

      const liveKey = `${guild.id}:${s.name}:${s.platform}:live`;

      if (live && !sentCache.has(liveKey)) {
        sentCache.add(liveKey);
        s.live = true;
        s.lastLiveAt = Date.now();

        await streamChannel?.send({
          content: role ? `<@&${role.id}>` : "",
          embeds: [makeEmbed("🔴 LIVE NOW", `${s.name} is now live on ${s.platform}!`, "success")]
        }).catch(() => {});
      }

      if (!live) {
        s.live = false;
        sentCache.delete(liveKey);
      }

      const latestPostId = await bestEffortPostSeen(s.platform, s.handle);
      const postKey = `${guild.id}:${s.name}:${s.platform}:post:${latestPostId}`;

      if (latestPostId && latestPostId !== s.lastPostId && !sentCache.has(postKey)) {
        s.lastPostId = latestPostId;
        sentCache.add(postKey);

        await postChannel?.send({
          embeds: [makeEmbed("🎥 New Post", `${s.name} posted on ${s.platform}!`, "info")]
        }).catch(() => {});
      }
    }
  }

  saveStreams(streamers);
}

module.exports = {
  loadStreams,
  saveStreams,
  checkStreams,
  checkTwitch,
  checkYouTube,
  checkKick,
  checkTikTok
};