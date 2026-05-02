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

// Parse compressed JSON bodies (the Roblox server compresses POSTs)
app.use((req, res, next) => {
  if (
    req.method === "POST" &&
    req.headers["content-encoding"] === "gzip"
  ) {
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

let instanceCounter = 1000;          // Increments per new server instance
const serverInstances = new Map();   // unique -> { playerList, platform, ... }

const parties = new Map();           // partyId -> partyObject
let partyCounter = 1;

const assetSales = new Map();        // assetId (string) -> totalSales (number)
const pendingSales = new Map();      // assetId -> pendingSales (flushed on set_asset_sales)

const bannedPlayers = [];            // array of UserIds (numbers)
const badSounds = [];                // array of SoundIds (numbers)
const reportedSounds = new Map();    // soundId -> reportCount

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

// ─── Base path ────────────────────────────────────────────────────────────────

const BASE = "/games/meepcity";

// ─────────────────────────────────────────────────────────────────────────────
// 1.  raw_unixtime.php
//     Returns the current UNIX timestamp as plain text.
//     Called by: Server.serverRequest("raw_unixtime", "cb=1")
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/raw_unixtime.php`, (req, res) => {
  log("raw_unixtime");
  res.type("text/plain").send(String(unixtime()));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.  instance.php  (POST)
//     Heartbeat sent every 60 s. Carries player counts, memory usage, jobId
//     and a JSON body of [ { UserId, Username, PlayerCoins }, ... ].
//
//     Returns JSON:
//       { Unique, ServerTime, BadSounds: [], BannedPlayers: [] }
// ─────────────────────────────────────────────────────────────────────────────
app.post(`${BASE}/instance.php`, (req, res) => {
  const q = req.query;
  log("instance", q);

  let unique = parseInt(q.unique, 10) || 0;

  if (unique === 0) {
    // New server – assign an ID
    unique = instanceCounter++;
    serverInstances.set(unique, { created: unixtime() });
  }

  const playerList = Array.isArray(req.body) ? req.body : [];

  // Update stored snapshot
  serverInstances.set(unique, {
    ...(serverInstances.get(unique) || {}),
    lastSeen: unixtime(),
    players: playerList,
    memory: parseInt(q.memory, 10) || 0,
    jobId: q.jobid || "",
    platform: {
      pc: parseInt(q.players_pc, 10) || 0,
      tablet: parseInt(q.players_tablet, 10) || 0,
      phone: parseInt(q.players_phone, 10) || 0,
      gamepad: parseInt(q.players_gamepad, 10) || 0,
    },
  });

  res.json({
    Unique: unique,
    ServerTime: unixtime(),
    BadSounds: badSounds,
    BannedPlayers: bannedPlayers,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.  report_error.php
//     Receives server/client errors.
//     Params: errortype (1=server, 2=client, 3=warning), version, message,
//             trace, serverid, userid, addtocount
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// 4.  get_parties.php
//     Returns the list of active parties for a given placeid/platform.
//     Params: placeid, platform (1=PC/mobile, 2=Xbox)
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/get_parties.php`, (req, res) => {
  const { placeid, platform } = req.query;
  log("get_parties", { placeid, platform });

  const list = [];
  for (const [id, p] of parties) {
    if (
      String(p.placeId) === String(placeid) &&
      String(p.platform) === String(platform) &&
      !p.moderated &&
      !p.dead
    ) {
list.push({
  PartyId: id,
  PartyOwnerId: p.ownerId,
  PartyOwnerUsername: p.ownerUsername,
  PartyTitle: p.title,
  PartyPlayersOnline: p.playersOnline,
  PartyMaxPlayers: p.maxPlayers,
  PartyTier: p.estateTier,
  PartyReserveId: p.reserveId,

  PartyThumbsUp: p.thumbsUp || 0,
  PartyCategory: p.category || 4,
  PartyLanguage: p.language || "English",
  PartyEstateVW: p.estateVW || 0,
});

    }
  }

  res.json(list);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.  create_party.php
//     Creates a new party. Params: uid, username, title, reserve, placeid,
//                                   maxplayers, estatetier, platform
//     Returns JSON: { Response: "SUCCESS"|"BANNED", PartyId, BanHoursLeft }
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/create_party.php`, (req, res) => {
  const q = req.query;
  log("create_party", q);

  // Check if owner is banned (extend with real ban logic as needed)
  if (bannedPlayers.includes(parseInt(q.uid, 10))) {
    return res.json({ Response: "BANNED", BanHoursLeft: 24 });
  }

  const partyId = partyCounter++;

parties.set(partyId, {
  partyId,
  ownerId: parseInt(q.uid, 10),
  ownerUsername: q.username || "Unknown",
  title: decodeURIComponent(q.title || "Untitled Party"),
  reserveId: q.reserve,
  placeId: q.placeid,
  maxPlayers: parseInt(q.maxplayers, 10) || 30,
  estateTier: parseInt(q.estatetier, 10) || 1,
  platform: parseInt(q.platform, 10) || 1,
  playersOnline: 1,
  created: unixtime(),
  moderated: false,
  dead: false,

  thumbsUp: 0,
  category: parseInt(q.category, 10) || 4,
  language: q.language || "English",
  estateVW: parseInt(q.estatevw, 10) || 0,
});


  console.log(`[PARTY] Created party #${partyId} by ${q.username} (${q.uid})`);

  res.json({ Response: "SUCCESS", PartyId: partyId });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6.  update_party.php
//     Updates player count for a party.
//     Params: pid, players
//     Returns JSON: { PartyIsModerated: 0|1 }
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/update_party.php`, (req, res) => {
  const { pid, players } = req.query;
  const party = parties.get(parseInt(pid, 10));

  if (party) {
    party.playersOnline = parseInt(players, 10) || 0;
  }

  res.json({
    PartyIsModerated: party && party.moderated ? 1 : 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7.  kill_party.php
//     Marks a party as dead/ended.
//     Params: pid
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/kill_party.php`, (req, res) => {
  const { pid } = req.query;
  const party = parties.get(parseInt(pid, 10));
  if (party) {
    party.dead = true;
    console.log(`[PARTY] Party #${pid} ended`);
  }
  res.type("text/plain").send("ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8.  get_party_data.php
//     Returns details about a specific party.
//     Params: pid
//     Returns JSON: { Response: "SUCCESS"|"NOTFOUND", PartyOwner, ... }
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/get_party_data.php`, (req, res) => {
  const { pid } = req.query;
  const party = parties.get(parseInt(pid, 10));

  if (!party) {
    return res.json({ Response: "NOTFOUND" });
  }

res.json({
  Response: "SUCCESS",
  PartyId: party.partyId,
  PartyOwner: party.ownerId,
  PartyOwnerUsername: party.ownerUsername,
  PartyTitle: party.title,
  PartyReserveId: party.reserveId,
  PartyMaxPlayers: party.maxPlayers,
  PartyEstateTier: party.estateTier,
  PartyIsModerated: party.moderated ? 1 : 0,

  PartyThumbsUp: party.thumbsUp || 0,
  PartyCategory: party.category || 4,
  PartyLanguage: party.language || "English",
  PartyEstateVW: party.estateVW || 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9.  get_asset_sales.php
//     Returns total sales per asset.
//     Returns JSON array: [ { AssetId: "N", Sales: "N" }, ... ]
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/get_asset_sales.php`, (req, res) => {
  log("get_asset_sales");

  const result = [];
  for (const [assetId, sales] of assetSales) {
    result.push({ AssetId: assetId, Sales: String(sales) });
  }

  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. set_asset_sales.php  (POST)
//     Receives new sales delta from the game server.
//     Body: JSON array of [ [assetId, deltaSales], ... ]
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// 11. assetPurchased.php
//     Records a developer product purchase.
//     Params: pUId, DProduct, type, robux, receipt
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/assetPurchased.php`, (req, res) => {
  const q = req.query;
  log("assetPurchased", q);
  console.log(
    `[SALE] uid=${q.pUId} product=${q.DProduct} type=${q.type} robux=${q.robux} receipt=${q.receipt}`
  );
  res.type("text/plain").send("ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. record_apt.php
//     Records average play time for analytics.
//     Params: uid, pt (play time seconds), d (platform id)
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/record_apt.php`, (req, res) => {
  const q = req.query;
  log("record_apt", q);
  // Store or log as needed
  console.log(`[APT] uid=${q.uid} playtime=${q.pt}s platform=${q.d}`);
  res.type("text/plain").send("ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. search_music.php
//     Music search endpoint used by the Boombox.
//     Params: search (URL-encoded query)
//     Returns JSON array: [ { Id, Title }, ... ]
//     Note: Roblox's Marketplace API is used in production. Here we return
//     a stub — replace with a real music lookup if needed.
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/search_music.php`, (req, res) => {
  const search = decodeURIComponent(req.query.search || "");
  log("search_music", { search });

  // Stub: return empty results. Hook into your own music catalog here.
  res.json([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. twitter_code_use.php
//     Records that a player redeemed a Twitter promo code.
//     Params: uid, title (code string)
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/twitter_code_use.php`, (req, res) => {
  const q = req.query;
  log("twitter_code_use", q);
  console.log(`[PROMO] uid=${q.uid} used code="${q.title}"`);
  res.type("text/plain").send("ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. report_bad_sound.php
//     Called when players flag a loud/inappropriate sound.
//     Params: sid (sound asset id)
// ─────────────────────────────────────────────────────────────────────────────
app.get(`${BASE}/report_bad_sound.php`, (req, res) => {
  const sid = parseInt(req.query.sid, 10);
  log("report_bad_sound", { sid });

  const count = (reportedSounds.get(sid) || 0) + 1;
  reportedSounds.set(sid, count);

  if (count >= 2 && !badSounds.includes(sid)) {
    badSounds.push(sid);
    console.warn(`[BAD_SOUND] SoundId ${sid} auto-banned after ${count} reports`);
  }

  res.type("text/plain").send("ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. update_party_thumbs.php
//     Called when players likes the party
//     Params: pid (party id)
// ─────────────────────────────────────────────────────────────────────────────

app.get(`${BASE}/update_party_thumbs.php`, (req, res) => {
  const { pid, thumbs } = req.query;
  const party = parties.get(parseInt(pid, 10));

  if (!party) {
    return res.type("text/plain").send("ok");
  }

  party.thumbsUp = parseInt(thumbs, 10) || party.thumbsUp || 0;
  res.type("text/plain").send("ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. get_population.php
//     Handles how many players are in the game
// ─────────────────────────────────────────────────────────────────────────────

app.get(`${BASE}/get_population.php`, (req, res) => {
  const { placeid } = req.query;
  log("get_population", { placeid });

  let total = 0;
  for (const [, instance] of serverInstances) {
    const players = Array.isArray(instance.players) ? instance.players : [];
    total += players.length;
  }

  res.json(total);
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin helpers (not called by the game – useful for management)
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/status  – quick overview
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

// POST /admin/ban/:uid   – ban a player
app.post("/admin/ban/:uid", (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  if (!bannedPlayers.includes(uid)) bannedPlayers.push(uid);
  res.json({ ok: true, bannedPlayers });
});

// DELETE /admin/ban/:uid  – unban
app.delete("/admin/ban/:uid", (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  const idx = bannedPlayers.indexOf(uid);
  if (idx !== -1) bannedPlayers.splice(idx, 1);
  res.json({ ok: true, bannedPlayers });
});

// POST /admin/ban_sound/:sid
app.post("/admin/ban_sound/:sid", (req, res) => {
  const sid = parseInt(req.params.sid, 10);
  if (!badSounds.includes(sid)) badSounds.push(sid);
  res.json({ ok: true, badSounds });
});

// DELETE /admin/ban_sound/:sid
app.delete("/admin/ban_sound/:sid", (req, res) => {
  const sid = parseInt(req.params.sid, 10);
  const idx = badSounds.indexOf(sid);
  if (idx !== -1) badSounds.splice(idx, 1);
  res.json({ ok: true, badSounds });
});

// POST /admin/moderate_party/:pid
app.post("/admin/moderate_party/:pid", (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const party = parties.get(pid);
  if (!party) return res.status(404).json({ error: "Party not found" });
  party.moderated = true;
  res.json({ ok: true, party });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

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
