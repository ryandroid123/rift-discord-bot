const fetch = require("node-fetch");
const { readJson, writeJson, ensureDataFile, resolveDataPath } = require("./storage");

const streamsPath = resolveDataPath("streams.json");
ensureDataFile("streams.json", []);
const sentCache = new Set();
const ytChannelIdCache = new Map();

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

function normalizeYouTubeHandle(raw) {
  const text = String(raw || "").trim();
  if (!text) return { channelId: null, handle: null };

  if (/^UC[0-9A-Za-z_-]{20,}$/.test(text)) {
    return { channelId: text, handle: null };
  }

  let stripped = text
    .replace(/^https?:\/\/(www\.)?youtube\.com\//i, "")
    .replace(/^@/i, "")
    .replace(/^channel\//i, "")
    .replace(/^c\//i, "")
    .replace(/^user\//i, "")
    .replace(/\/+$/, "");

  if (/^UC[0-9A-Za-z_-]{20,}$/.test(stripped)) {
    return { channelId: stripped, handle: null };
  }

  if (stripped.includes("/")) {
    stripped = stripped.split("/")[0];
  }
  return { channelId: null, handle: stripped || null };
}

async function resolveYouTubeChannelId(handle) {
  const normalized = normalizeYouTubeHandle(handle);
  if (normalized.channelId) return normalized.channelId;
  if (!process.env.YOUTUBE_API_KEY || !normalized.handle) return null;

  const key = normalized.handle.toLowerCase();
  if (ytChannelIdCache.has(key)) return ytChannelIdCache.get(key);

  try {
    const byHandleRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(key)}&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`
    );
    const byHandleJson = await byHandleRes.json();
    const id = byHandleJson?.items?.[0]?.id || null;
    if (id) {
      ytChannelIdCache.set(key, id);
      return id;
    }
  } catch {}

  try {
    const bySearchRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(key)}&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`
    );
    const bySearchJson = await bySearchRes.json();
    const id = bySearchJson?.items?.[0]?.snippet?.channelId || null;
    if (id) {
      ytChannelIdCache.set(key, id);
      return id;
    }
  } catch {}

  return null;
}

async function checkYouTubeDetailed(handle) {
  const normalized = normalizeYouTubeHandle(handle);
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  if (process.env.YOUTUBE_API_KEY) {
    try {
      const channelId = await resolveYouTubeChannelId(handle);
      if (channelId) {
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&eventType=live&type=video&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`
        );
        const json = await res.json();
        const live = !!(json.items && json.items.length);
        if (live) {
          return { live: true, source: "youtube-api-search-live", signal: `channelId:${channelId}` };
        }
      }
    } catch {}
  }

  const livePages = [];
  if (normalized.channelId) livePages.push(`channel/${encodeURIComponent(normalized.channelId)}/live`);
  if (normalized.handle) livePages.push(`@${encodeURIComponent(normalized.handle)}/live`);
  if (normalized.handle) livePages.push(`c/${encodeURIComponent(normalized.handle)}/live`);
  if (normalized.handle) livePages.push(`user/${encodeURIComponent(normalized.handle)}/live`);

  for (const page of livePages) {
    try {
      const res = await fetch(`https://www.youtube.com/${page}`, {
        redirect: "follow",
        headers: {
          "User-Agent": userAgent,
          "Accept-Language": "en-US,en;q=0.9"
        }
      });
      const finalUrl = String(res.url || "");
      const text = await res.text();

      const redirectWatch = /youtube\.com\/watch\?v=/i.test(finalUrl);
      const isLiveNow = /"isLiveNow"\s*:\s*true/i.test(text);
      const isLive = /"isLive"\s*:\s*true/i.test(text);
      const liveContent = /"isLiveContent"\s*:\s*true/i.test(text);
      const hlsManifest = /"hlsManifestUrl"\s*:/i.test(text);
      const offlineSlate = /LIVE_STREAM_OFFLINE_SLATE/i.test(text);

      const signals = [redirectWatch, isLiveNow, isLive, liveContent, hlsManifest].filter(Boolean).length;
      if (!offlineSlate && signals >= 2) {
        return { live: true, source: "youtube-live-page", signal: page };
      }
    } catch {}
  }

  return { live: false, source: "youtube-no-live-signals", signal: "none" };
}

async function checkYouTube(handle) {
  const detailed = await checkYouTubeDetailed(handle);
  return detailed.live;
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
      const normalized = normalizeYouTubeHandle(handle);
      const ytPath = normalized.channelId
        ? `channel/${encodeURIComponent(normalized.channelId)}`
        : `@${encodeURIComponent(normalized.handle || handle)}`;
      const res = await fetch(`https://www.youtube.com/${ytPath}/videos`);
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
    let checkSource = "unknown";

    if (platform === "twitch") {
      live = await checkTwitch(s.handle);
      checkSource = "twitch";
    } else if (platform === "youtube") {
      const yt = await checkYouTubeDetailed(s.handle);
      live = yt.live;
      checkSource = `${yt.source}:${yt.signal}`;
    } else if (platform === "kick") {
      live = await checkKick(s.handle);
      checkSource = "kick-page";
    } else if (platform === "tiktok") {
      live = await checkTikTok(s.handle);
      checkSource = "tiktok-live-page";
    }

    if (live) {
      s.live = true;
      s.offlineChecks = 0;
      if (!wasLive) s.lastLiveAt = Date.now();
    } else {
      const nextOfflineChecks = (Number(s.offlineChecks) || 0) + 1;
      s.offlineChecks = nextOfflineChecks;
      if (nextOfflineChecks >= 2) s.live = false;
    }

    const wentLive = !wasLive && live;
    const previousPostId = s.lastPostId;
    const latestPostId = await bestEffortPostSeen(platform, s.handle);
    const hasNewPost = !!latestPostId && latestPostId !== previousPostId;
    if (hasNewPost) s.lastPostId = latestPostId;

    for (const guild of client.guilds.cache.values()) {
      const streamChannel = guild.channels.cache.find(c => c.name === config.channels.streams);
      const postChannel = guild.channels.cache.find(c => c.name === config.channels.posts);
      const role = guild.roles.cache.find(r => r.name === config.roles.streamPing);
      const liveKey = `${guild.id}:${s.name}:${platform}:live`;

      if (wentLive && !sentCache.has(liveKey)) {
        sentCache.add(liveKey);
        await streamChannel?.send({
          content: role ? `<@&${role.id}>` : "",
          embeds: [makeEmbed("LIVE NOW", `${s.name} is now live on ${platform}!`, "success")]
        }).catch(() => {});
        console.log(`[stream-check] announced live guild=${guild.id} streamer=${s.name} platform=${platform} source=${checkSource}`);
      }

      if (!s.live) {
        sentCache.delete(liveKey);
      }

      const postKey = `${guild.id}:${s.name}:${platform}:post:${latestPostId}`;
      if (hasNewPost && !sentCache.has(postKey)) {
        sentCache.add(postKey);
        await postChannel?.send({
          embeds: [makeEmbed("New Post", `${s.name} posted on ${platform}!`, "info")]
        }).catch(() => {});
      }
    }

    console.log(`[stream-check] streamer=${s.name} platform=${platform} live=${live} wasLive=${wasLive} wentLive=${wentLive} source=${checkSource} hasNewPost=${hasNewPost}`);
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
