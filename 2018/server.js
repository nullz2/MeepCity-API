/**
 * MeepCity API Replica Server
 * Replicates: https://alexnewtron.herokuapp.com/games/meepcity/
 *
 * Run with: node server.js
 * Default port: 3000
 *
 * In your Roblox game script, change:
 *   Server.APIServer = "http://YOUR_HOST:3000/games/meepcity/"
 */

const express = require("express");
const zlib = require("zlib");
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.method === "POST" && req.headers["content-encoding"] === "gzip") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      zlib.gunzip(Buffer.concat(chunks), (err, decoded) => {
        if (err) return next(err);
        try {
          req.body = JSON.parse(decoded.toString());
        } catch {
          req.body = decoded.toString();
        }
        next();
      });
    });
  } else {
    express.json()(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true }));

// ─── In-Memory State ──────────────────────────────────────────────────────────

let instanceCounter = 1000;
const serverInstances = new Map();
const playerPresence = new Map();
const PRESENCE_TTL_SECONDS = 90;

const parties = new Map();
let partyCounter = 1;

const assetSales = new Map();
const bannedPlayers = [];
const badSounds = [];
const reportedSounds = new Map();
const friends = new Map();
const friendRequests = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unixtime() {
  return Math.floor(Date.now() / 1000);
}

function log(endpoint, query = {}) {
  const qs = Object.entries(query)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  console.log(`[${new Date().toISOString()}] ${endpoint}${qs ? " | " + qs : ""}`);
}

function parseIntSafe(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePartyLanguage(value) {
  return value && String(value).trim() ? String(value).trim() : "English";
}

function normalizePartyCategory(value) {
  return parseIntSafe(value, 4);
}

function normalizeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isLiveParty(party) {
  return !!party && !party.dead;
}

function cleanupPresence(now = unixtime()) {
  const cutoff = now - PRESENCE_TTL_SECONDS;

  for (const [serverId, instance] of serverInstances) {
    if ((instance.lastSeen || 0) < cutoff) {
      serverInstances.delete(serverId);
    }
  }

  for (const [userId, presence] of playerPresence) {
    if ((presence.LastSeen || 0) < cutoff) {
      playerPresence.delete(userId);
    }
  }
}

function serializePresence(presence) {
  return {
    UserId: presence.UserId,
    Username: presence.Username,
    ServerId: presence.ServerId,
    JobId: presence.JobId,
    PlaceId: presence.PlaceId,
    ServerType: presence.ServerType,
    IsParty: presence.IsParty,
    PartyId: presence.PartyId,
    PartyOwnerId: presence.PartyOwnerId,
    PartyEstateVW: presence.PartyEstateVW,
    PartyReserveId: presence.PartyReserveId,
    LastSeen: presence.LastSeen,
  };
}

function upsertPresenceFromHeartbeat(serverId, instanceData, player) {
  const userId = parseIntSafe(player.UserId, 0);
  if (!userId) {
    return;
  }

  const isParty =
    normalizeBoolean(player.IsParty) ||
    normalizeBoolean(player.ServerType === 2) ||
    normalizeBoolean(instanceData.isParty);

  const presence = {
    UserId: userId,
    Username: normalizeString(player.Username, "Unknown"),
    ServerId: serverId,
    JobId: normalizeString(player.JobId || instanceData.jobId, ""),
    PlaceId: normalizeString(player.PlaceId || instanceData.placeId, ""),
    ServerType: parseIntSafe(
      player.ServerType,
      parseIntSafe(instanceData.serverType, isParty ? 2 : 1)
    ),
    IsParty: isParty,
    PartyId: parseIntSafe(player.PartyId, parseIntSafe(instanceData.partyId, 0)),
    PartyOwnerId: parseIntSafe(
      player.PartyOwnerId,
      parseIntSafe(instanceData.partyOwnerId, 0)
    ),
    PartyEstateVW: parseIntSafe(
      player.PartyEstateVW,
      parseIntSafe(instanceData.partyEstateVW, 0)
    ),
    PartyReserveId: normalizeString(
      player.PartyReserveId || instanceData.partyReserveId,
      ""
    ),
    LastSeen: instanceData.lastSeen,
  };

  playerPresence.set(userId, presence);
}

function serializeParty(party) {
  return {
    PartyId: party.partyId,
    PartyOwnerId: party.ownerId,
    PartyOwnerUsername: party.ownerUsername,
    PartyTitle: party.title,
    PartyPlayersOnline: party.playersOnline,
    PartyMaxPlayers: party.maxPlayers,
    PartyTier: party.estateTier,
    PartyReserveId: party.reserveId,
    PartyThumbsUp: party.thumbsUp,
    PartyCategory: party.category,
    PartyLanguage: party.language,
    PartyEstateVW: party.estateVW,
    PlaceId: party.placeId,
  };
}

function getPresenceForUser(userId) {
  cleanupPresence();
  return playerPresence.get(userId) || null;
}

function getOnlinePartyPlayerCount(partyId) {
  if (!partyId) {
    return 0;
  }

  let total = 0;
  for (const presence of playerPresence.values()) {
    if (presence.PartyId === partyId) {
      total += 1;
    }
  }
  return total;
}

function serializeFriendStatus(presence) {
  if (!presence) {
    return { IsPlaying: false };
  }

  return {
    IsPlaying: true,
    ...serializePresence(presence),
  };
}

function findPartyByReserveId(reserveId) {
  const normalizedReserveId = normalizeString(reserveId, "").trim();
  if (!normalizedReserveId) {
    return null;
  }

  for (const party of parties.values()) {
    if (
      isLiveParty(party) &&
      normalizeString(party.reserveId, "").trim() === normalizedReserveId
    ) {
      return party;
    }
  }

  return null;
}

function findPartyById(partyId) {
  const normalizedPartyId = parseIntSafe(partyId, 0);
  if (!normalizedPartyId) {
    return null;
  }

  const party = parties.get(normalizedPartyId);
  return isLiveParty(party) ? party : null;
}

function findPartyByOwnerIds(ownerIds, placeId = "") {
  const normalizedPlaceId = normalizeString(placeId, "").trim();
  const matches = [];

  for (const party of parties.values()) {
    if (!isLiveParty(party) || !ownerIds.has(party.ownerId)) {
      continue;
    }

    if (
      normalizedPlaceId &&
      normalizeString(party.placeId, "").trim() !== normalizedPlaceId
    ) {
      continue;
    }

    matches.push(party);
  }

  return matches.length === 1 ? matches[0] : null;
}

function hydrateInstancePartyData(instanceData, playerList) {
  if (!instanceData.isParty) {
    return instanceData;
  }

  const ownerIds = new Set(
    playerList
      .map((player) => parseIntSafe(player && player.UserId, 0))
      .filter(Boolean)
  );

  const resolvedParty =
    findPartyById(instanceData.partyId) ||
    findPartyByReserveId(instanceData.partyReserveId) ||
    findPartyByOwnerIds(ownerIds, instanceData.placeId);

  if (!resolvedParty) {
    return {
      ...instanceData,
      serverType: instanceData.serverType || 2,
    };
  }

  return {
    ...instanceData,
    serverType: 2,
    partyId: resolvedParty.partyId,
    partyOwnerId: resolvedParty.ownerId,
    partyEstateVW: resolvedParty.estateVW,
    partyReserveId: normalizeString(resolvedParty.reserveId, ""),
  };
}

function getFriendList(userId) {
  if (!friends.has(userId)) {
    friends.set(userId, new Set());
  }
  return friends.get(userId);
}

function getFriendRequestList(userId) {
  if (!friendRequests.has(userId)) {
    friendRequests.set(userId, new Set());
  }
  return friendRequests.get(userId);
}

function makeFriendResponse(success = true, code = "SUCCESS") {
  return {
    Response: success ? "SUCCESS" : "ERROR",
    Success: success,
    Code: code,
  };
}

// ─── Base path ────────────────────────────────────────────────────────────────

const BASE = "/games/meepcity";

app.get(`${BASE}/raw_unixtime.php`, (req, res) => {
  log("raw_unixtime");
  res.type("text/plain").send(String(unixtime()));
});

app.post(`${BASE}/instance.php`, (req, res) => {
  const q = req.query;
  log("instance", q);
  cleanupPresence();

  let unique = parseIntSafe(q.unique, 0);

  if (unique === 0) {
    unique = instanceCounter++;
    serverInstances.set(unique, { created: unixtime() });
  }

  const previousInstance = serverInstances.get(unique) || {};
  const playerList = Array.isArray(req.body) ? req.body : [];
  const heartbeatTime = unixtime();
  let instanceData = {
    ...(previousInstance || {}),
    lastSeen: heartbeatTime,
    players: playerList,
    memory: parseIntSafe(q.memory, 0),
    jobId: q.jobid || "",
    placeId: normalizeString(q.placeid, previousInstance.placeId || ""),
    serverType: parseIntSafe(
      q.servertype ?? q.server_type,
      previousInstance.serverType || 1
    ),
    isParty:
      normalizeBoolean(q.is_party ?? q.isparty) ||
      normalizeBoolean(q.partyid ?? q.party_id),
    partyId: parseIntSafe(
      q.partyid ?? q.party_id,
      previousInstance.partyId || 0
    ),
    partyOwnerId: parseIntSafe(
      q.partyownerid ?? q.party_owner_id,
      previousInstance.partyOwnerId || 0
    ),
    partyEstateVW: parseIntSafe(
      q.partyestatevw ?? q.party_estate_vw,
      previousInstance.partyEstateVW || 0
    ),
    partyReserveId: normalizeString(
      q.partyreserveid ??
        q.party_reserve_id ??
        q.reserveid ??
        q.reserve_id ??
        q.reserve,
      previousInstance.partyReserveId || ""
    ),
    platform: {
      pc: parseIntSafe(q.players_pc, 0),
      tablet: parseIntSafe(q.players_tablet, 0),
      phone: parseIntSafe(q.players_phone, 0),
      gamepad: parseIntSafe(q.players_gamepad, 0),
    },
  };

  instanceData = hydrateInstancePartyData(instanceData, playerList);

  const activePlayers = new Set();
  for (const player of playerList) {
    const userId = parseIntSafe(player && player.UserId, 0);
    if (!userId) {
      continue;
    }
    activePlayers.add(userId);
    upsertPresenceFromHeartbeat(unique, instanceData, player);
  }

  const previousPlayers = Array.isArray(previousInstance.players)
    ? previousInstance.players
    : [];
  for (const previousPlayer of previousPlayers) {
    const userId = parseIntSafe(previousPlayer && previousPlayer.UserId, 0);
    const livePresence = playerPresence.get(userId);
    if (
      userId &&
      !activePlayers.has(userId) &&
      livePresence &&
      livePresence.ServerId === unique
    ) {
      playerPresence.delete(userId);
    }
  }

  serverInstances.set(unique, instanceData);

  res.json({
    Unique: unique,
    ServerTime: heartbeatTime,
    BadSounds: badSounds,
    BannedPlayers: bannedPlayers,
  });
});

app.get(`${BASE}/report_error.php`, (req, res) => {
  const q = req.query;
  const typeMap = { 1: "SERVER", 2: "CLIENT", 3: "WARNING" };
  const label = typeMap[q.errortype] || "UNKNOWN";
  console.warn(
    `[ERROR/${label}] ver=${q.version} uid=${q.userid || "?"} ` +
      `msg=${decodeURIComponent(q.message || "")}`
  );
  res.type("text/plain").send("ok");
});

app.get(`${BASE}/get_parties.php`, (req, res) => {
  const { placeid, platform } = req.query;
  log("get_parties", { placeid, platform });
  cleanupPresence();

  const list = [];
  for (const [, p] of parties) {
    if (
      String(p.placeId) === String(placeid) &&
      String(p.platform) === String(platform) &&
      !p.moderated &&
      !p.dead
    ) {
      p.playersOnline = getOnlinePartyPlayerCount(p.partyId);
      list.push(serializeParty(p));
    }
  }

  res.json(list);
});

app.get(`${BASE}/get_population.php`, (req, res) => {
  const { placeid } = req.query;
  log("get_population", { placeid });
  cleanupPresence();

  let total = 0;
  for (const presence of playerPresence.values()) {
    if (!placeid || String(presence.PlaceId) === String(placeid)) {
      total += 1;
    }
  }

  res.json(total);
});

app.get(`${BASE}/create_party.php`, (req, res) => {
  const q = req.query;
  log("create_party", q);

  const ownerId = parseIntSafe(q.uid, 0);
  if (bannedPlayers.includes(ownerId)) {
    return res.json({ Response: "BANNED", BanHoursLeft: 24 });
  }

  const partyId = partyCounter++;

  parties.set(partyId, {
    partyId,
    ownerId,
    ownerUsername: q.username || "Unknown",
    title: decodeURIComponent(q.title || "Untitled Party"),
    reserveId: q.reserve || "",
    placeId: q.placeid || "",
    maxPlayers: parseIntSafe(q.maxplayers, 30),
    estateTier: parseIntSafe(q.estatetier, 1),
    platform: parseIntSafe(q.platform, 1),
    playersOnline: 1,
    thumbsUp: 0,
    category: normalizePartyCategory(q.category),
    language: normalizePartyLanguage(q.language),
    estateVW: parseIntSafe(q.estatevw, 0),
    created: unixtime(),
    moderated: false,
    dead: false,
  });

  console.log(`[PARTY] Created party #${partyId} by ${q.username} (${q.uid})`);
  res.json({ Response: "SUCCESS", PartyId: partyId });
});

app.get(`${BASE}/update_party.php`, (req, res) => {
  const { pid, players } = req.query;
  const party = parties.get(parseIntSafe(pid, -1));

  if (party) {
    party.playersOnline = parseIntSafe(players, 0);
  }

  res.json({
    PartyIsModerated: party && party.moderated ? 1 : 0,
  });
});

app.get(`${BASE}/update_party_thumbs.php`, (req, res) => {
  const { pid, thumbs } = req.query;
  const party = parties.get(parseIntSafe(pid, -1));
  log("update_party_thumbs", { pid, thumbs });

  if (!party) {
    return res.type("text/plain").send("notfound");
  }

  party.thumbsUp = Math.max(0, parseIntSafe(thumbs, party.thumbsUp));
  res.type("text/plain").send("ok");
});

app.get(`${BASE}/kill_party.php`, (req, res) => {
  const { pid } = req.query;
  const party = parties.get(parseIntSafe(pid, -1));
  if (party) {
    party.dead = true;
    console.log(`[PARTY] Party #${pid} ended`);
  }
  res.type("text/plain").send("ok");
});

app.get(`${BASE}/get_party_data.php`, (req, res) => {
  const { pid } = req.query;
  const party = parties.get(parseIntSafe(pid, -1));
  cleanupPresence();

  if (!party) {
    return res.json({ Response: "NOTFOUND" });
  }

  party.playersOnline = getOnlinePartyPlayerCount(party.partyId);

  res.json({
    Response: "SUCCESS",
    PartyId: party.partyId,
    PartyOwner: party.ownerId,
    PartyOwnerId: party.ownerId,
    PartyOwnerUsername: party.ownerUsername,
    PartyTitle: party.title,
    PartyReserveId: party.reserveId,
    PartyPlayersOnline: party.playersOnline,
    PartyMaxPlayers: party.maxPlayers,
    PartyEstateTier: party.estateTier,
    PartyEstateVW: party.estateVW,
    PartyCategory: party.category,
    PartyLanguage: party.language,
    PartyThumbsUp: party.thumbsUp,
    PartyIsModerated: party.moderated ? 1 : 0,
  });
});

app.get(`${BASE}/get_asset_sales.php`, (req, res) => {
  log("get_asset_sales");
  const result = [];
  for (const [assetId, sales] of assetSales) {
    result.push({ AssetId: assetId, Sales: String(sales) });
  }
  res.json(result);
});

app.post(`${BASE}/set_asset_sales.php`, (req, res) => {
  const data = Array.isArray(req.body) ? req.body : [];
  log("set_asset_sales", { count: data.length });

  for (const entry of data) {
    const [assetId, delta] = entry;
    const key = String(assetId);
    assetSales.set(key, (assetSales.get(key) || 0) + (delta || 0));
  }

  res.type("text/plain").send("ok");
});

app.get(`${BASE}/assetPurchased.php`, (req, res) => {
  const q = req.query;
  log("assetPurchased", q);
  console.log(
    `[SALE] uid=${q.pUId} product=${q.DProduct} type=${q.type} robux=${q.robux} receipt=${q.receipt}`
  );
  res.type("text/plain").send("ok");
});

app.get(`${BASE}/record_apt.php`, (req, res) => {
  const q = req.query;
  log("record_apt", q);
  console.log(`[APT] uid=${q.uid} playtime=${q.pt}s platform=${q.d}`);
  res.type("text/plain").send("ok");
});

app.get(`${BASE}/search_music.php`, (req, res) => {
  const search = decodeURIComponent(req.query.search || "");
  log("search_music", { search });
  res.json([]);
});

app.get(`${BASE}/twitter_code_use.php`, (req, res) => {
  const q = req.query;
  log("twitter_code_use", q);
  console.log(`[PROMO] uid=${q.uid} used code="${q.title}"`);
  res.type("text/plain").send("ok");
});

app.get(`${BASE}/report_bad_sound.php`, (req, res) => {
  const sid = parseIntSafe(req.query.sid, 0);
  log("report_bad_sound", { sid });

  const count = (reportedSounds.get(sid) || 0) + 1;
  reportedSounds.set(sid, count);

  if (count >= 2 && !badSounds.includes(sid)) {
    badSounds.push(sid);
    console.warn(`[BAD_SOUND] SoundId ${sid} auto-banned after ${count} reports`);
  }

  res.type("text/plain").send("ok");
});

app.get(`${BASE}/manage_friend.php`, (req, res) => {
  const uid = parseIntSafe(req.query.uid, 0);
  const tid = parseIntSafe(req.query.tid, 0);
  const type = String(req.query.type || "").trim();

  log("manage_friend", { uid, tid, type });

  if (!uid || !tid || uid === tid || !type) {
    return res.type("text/plain").send("ok");
  }

  if (type === "send_fr") {
    const targetRequests = getFriendRequestList(tid);
    targetRequests.add(uid);
    return res.type("text/plain").send("ok");
  }

  if (type === "add") {
    const userFriends = getFriendList(uid);
    const targetFriends = getFriendList(tid);
    userFriends.add(tid);
    targetFriends.add(uid);

    getFriendRequestList(uid).delete(tid);
    getFriendRequestList(tid).delete(uid);

    return res.type("text/plain").send("ok");
  }

  if (type === "remove") {
    getFriendList(uid).delete(tid);
    getFriendList(tid).delete(uid);

    getFriendRequestList(uid).delete(tid);
    getFriendRequestList(tid).delete(uid);

    return res.type("text/plain").send("ok");
  }

  res.type("text/plain").send("ok");
});

app.get(`${BASE}/get_online_friends.php`, (req, res) => {
  const uid = parseIntSafe(req.query.uid, 0);
  log("get_online_friends", { uid });

  if (!uid) {
    return res.json([]);
  }

  cleanupPresence();
  const userFriends = getFriendList(uid);
  const result = [];

  for (const friendId of userFriends) {
    const presence = playerPresence.get(friendId);
    if (!presence) {
      continue;
    }
    result.push(serializePresence(presence));
  }

  res.json(result);
});

app.get(`${BASE}/get_online_friend.php`, (req, res) => {
  const uid = parseIntSafe(req.query.uid, 0);
  const fid = parseIntSafe(req.query.fid, 0);
  log("get_online_friend", { uid, fid });

  if (!uid || !fid) {
    return res.json({ IsPlaying: false });
  }

  const userFriends = getFriendList(uid);
  if (!userFriends.has(fid)) {
    return res.json({ IsPlaying: false });
  }

  const presence = getPresenceForUser(fid);
  res.json(serializeFriendStatus(presence));
});

app.get(`${BASE}/get_meepcity_friends.php`, (req, res) => {
  const uid = parseIntSafe(req.query.uid, 0);

  log("get_meepcity_friends", { uid });

  if (!uid) {
    return res.json([]);
  }

  const userFriends = getFriendList(uid);

  const result = [];

  for (const friendId of userFriends) {

    let username = `Player${friendId}`;

    
    for (const [, instance] of serverInstances) {

      const players = Array.isArray(instance.players)
        ? instance.players
        : [];

      const foundPlayer = players.find(
        p => parseIntSafe(p.UserId, 0) === friendId
      );

      if (foundPlayer) {
        username =
          foundPlayer.Username ||
          foundPlayer.Name ||
          username;

        break;
      }
    }

    result.push({
      UserId: friendId,
      Username: username
    });
  }

  res.json(result);
});

app.get("/admin/status", (req, res) => {
  res.json({
    serverTime: unixtime(),
    activeInstances: serverInstances.size,
    activeParties: [...parties.values()].filter((p) => !p.dead).length,
    bannedPlayers,
    badSounds,
    assetSalesCount: assetSales.size,
  });
});

app.get(`${BASE}/send_meepcity_friend_request.php`, (req, res) => {
  const uid = parseIntSafe(req.query.uid, 0);
  const target = parseIntSafe(req.query.target, 0);

  log("send_meepcity_friend_request", { uid, target });

  if (!uid || !target || uid === target) {
    return res.json(makeFriendResponse(false, "ERROR"));
  }

  const targetRequests = getFriendRequestList(target);

  // already friends
  if (getFriendList(uid).has(target)) {
    return res.json(makeFriendResponse(false, "ALREADY_FRIENDS"));
  }

  targetRequests.add(uid);

  res.json(makeFriendResponse(true));
});

app.get(`${BASE}/accept_meepcity_friend_request.php`, (req, res) => {
  const uid = parseIntSafe(req.query.uid, 0);
  const target = parseIntSafe(req.query.target, 0);

  log("accept_meepcity_friend_request", { uid, target });

  if (!uid || !target || uid === target) {
    return res.json(makeFriendResponse(false, "ERROR"));
  }

  const requests = getFriendRequestList(uid);

  // no request exists
  if (!requests.has(target)) {
    return res.json(makeFriendResponse(false, "NO_REQUEST"));
  }

  getFriendList(uid).add(target);
  getFriendList(target).add(uid);

  requests.delete(target);
  getFriendRequestList(target).delete(uid);

  res.json(makeFriendResponse(true));
});

app.get(`${BASE}/decline_meepcity_friend_request.php`, (req, res) => {
  const uid = parseIntSafe(req.query.uid, 0);
  const target = parseIntSafe(req.query.target, 0);

  log("decline_meepcity_friend_request", { uid, target });

  if (!uid || !target || uid === target) {
    return res.json(makeFriendResponse(false, "ERROR"));
  }

  getFriendRequestList(uid).delete(target);

  res.json(makeFriendResponse(true));
});

app.get(`${BASE}/remove_meepcity_friend.php`, (req, res) => {
  const uid = parseIntSafe(req.query.uid, 0);
  const target = parseIntSafe(req.query.target, 0);

  log("remove_meepcity_friend", { uid, target });

  if (!uid || !target || uid === target) {
    return res.json(makeFriendResponse(false, "ERROR"));
  }

  getFriendList(uid).delete(target);
  getFriendList(target).delete(uid);

  getFriendRequestList(uid).delete(target);
  getFriendRequestList(target).delete(uid);

  res.json(makeFriendResponse(true));
});

app.get(`${BASE}/are_meepcity_friends.php`, (req, res) => {
  const uid = parseIntSafe(req.query.uid, 0);
  const target = parseIntSafe(req.query.target, 0);

  log("are_meepcity_friends", { uid, target });

  if (!uid || !target || uid === target) {
    return res.json({
      Response: "ERROR",
      Success: false,
      IsFriend: false,
    });
  }

  const isFriend = getFriendList(uid).has(target);

  res.json({
    Response: "SUCCESS",
    Success: true,
    IsFriend: isFriend,
  });
});

app.post("/admin/ban/:uid", (req, res) => {
  const uid = parseIntSafe(req.params.uid, 0);
  if (!bannedPlayers.includes(uid)) bannedPlayers.push(uid);
  res.json({ ok: true, bannedPlayers });
});

app.delete("/admin/ban/:uid", (req, res) => {
  const uid = parseIntSafe(req.params.uid, 0);
  const idx = bannedPlayers.indexOf(uid);
  if (idx !== -1) bannedPlayers.splice(idx, 1);
  res.json({ ok: true, bannedPlayers });
});

app.post("/admin/ban_sound/:sid", (req, res) => {
  const sid = parseIntSafe(req.params.sid, 0);
  if (!badSounds.includes(sid)) badSounds.push(sid);
  res.json({ ok: true, badSounds });
});

app.delete("/admin/ban_sound/:sid", (req, res) => {
  const sid = parseIntSafe(req.params.sid, 0);
  const idx = badSounds.indexOf(sid);
  if (idx !== -1) badSounds.splice(idx, 1);
  res.json({ ok: true, badSounds });
});

app.post("/admin/moderate_party/:pid", (req, res) => {
  const pid = parseIntSafe(req.params.pid, 0);
  const party = parties.get(pid);
  if (!party) return res.status(404).json({ error: "Party not found" });
  party.moderated = true;
  res.json({ ok: true, party: serializeParty(party) });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         MeepCity API Server — Running on :${PORT}    ║
╠══════════════════════════════════════════════════════╣
║  Endpoints mounted at /games/meepcity/               ║
║                                                      ║
║  In your Roblox Server script, set:                  ║
║    Server.APIServer =                                ║
║      "http://<YOUR_HOST>:${PORT}/games/meepcity/"    ║
║                                                      ║
║  Admin panel: http://localhost:${PORT}/admin/status  ║
╚══════════════════════════════════════════════════════╝
`);
});
