const fetch = require("node-fetch");
const { readJson, writeJson, ensureDataFile, resolveDataPath } = require("./storage");

const streamsPath = resolveDataPath("streams.json");
ensureDataFile("streams.json", []);
const sentCache = new Set();

function normalizePlatform(platform) {
  return String(platform || "").trim().toLowerCase();
}

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

    const hasLiveBroadcastFlag = /"isLiveBroadcast"\s*:\s*true/i.test(text);
    const hasLiveRoomWithStatus2 = /"liveRoom"\s*:\s*\{[\s\S]{0,500}?"status"\s*:\s*2\b/i.test(text);
    const hasExplicitLiveStatus = /"liveStatus"\s*:\s*"LIVE_STATUS_LIVE"/i.test(text) ||
      /"live_status"\s*:\s*2\b/i.test(text);

    return hasLiveBroadcastFlag || hasLiveRoomWithStatus2 || hasExplicitLiveStatus;
  } catch {
    return false;
  }
}

async function bestEffortPostSeen(platform, handle) {
  const normalizedPlatform = normalizePlatform(platform);

  try {
    if (normalizedPlatform === "youtube") {
      const res = await fetch(`https://www.youtube.com/channel/${encodeURIComponent(handle)}/videos`);
      const text = await res.text();
      const m = text.match(/"videoId":"([^"]+)"/);
      return m ? m[1] : null;
    }

    if (normalizedPlatform === "tiktok") {
      const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const text = await res.text();
      const m = text.match(/"id":"(\d{8,})"/);
      return m ? m[1] : null;
    }

    if (normalizedPlatform === "x") {
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
  const uniqueStreamers = [];
  const seenStreamKeys = new Set();

  for (const s of streamers) {
    const platform = normalizePlatform(s.platform);
    const handle = String(s.handle || "").trim();
    const name = String(s.name || "").trim();

    if (!platform || !handle || !name) continue;

    const dedupeKey = `${platform}:${handle.toLowerCase()}:${name.toLowerCase()}`;
    if (seenStreamKeys.has(dedupeKey)) continue;

    seenStreamKeys.add(dedupeKey);
    uniqueStreamers.push(s);
  }

  for (const s of uniqueStreamers) {
    const platform = normalizePlatform(s.platform);
    const wasLive = s.live === true;
    let live = false;

    if (platform === "twitch") live = await checkTwitch(s.handle);
    if (platform === "youtube") live = await checkYouTube(s.handle);
    if (platform === "kick") live = await checkKick(s.handle);
    if (platform === "tiktok") live = await checkTikTok(s.handle);

    if (live) {
      s.live = true;
      s.offlineChecks = 0;
      if (!wasLive) s.lastLiveAt = Date.now();
    } else {
      const nextOfflineChecks = (Number(s.offlineChecks) || 0) + 1;
      s.offlineChecks = nextOfflineChecks;
      if (nextOfflineChecks >= 2) {
        s.live = false;
      }
    }

    const wentLive = !wasLive && live;
    const previousPostId = s.lastPostId;
    const latestPostId = await bestEffortPostSeen(platform, s.handle);
    const hasNewPost = !!latestPostId && latestPostId !== previousPostId;
    if (hasNewPost) {
      s.lastPostId = latestPostId;
    }

    for (const guild of client.guilds.cache.values()) {
      const streamChannel = guild.channels.cache.find(c => c.name === config.channels.streams);
      const postChannel = guild.channels.cache.find(c => c.name === config.channels.posts);
      const role = guild.roles.cache.find(r => r.name === config.roles.streamPing);
      const liveKey = `${guild.id}:${s.name}:${platform}:live`;

      if (wentLive && !sentCache.has(liveKey)) {
        sentCache.add(liveKey);
        await streamChannel?.send({
          content: role ? `<@&${role.id}>` : "",
          embeds: [makeEmbed("🔴 LIVE NOW", `${s.name} is now live on ${platform}!`, "success")]
        }).catch(() => {});
      }

      if (!s.live) {
        sentCache.delete(liveKey);
      }

      const postKey = `${guild.id}:${s.name}:${platform}:post:${latestPostId}`;
      if (hasNewPost && !sentCache.has(postKey)) {
        sentCache.add(postKey);
        await postChannel?.send({
          embeds: [makeEmbed("🎥 New Post", `${s.name} posted on ${platform}!`, "info")]
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
