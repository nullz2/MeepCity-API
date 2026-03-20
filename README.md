# MeepCity API Server

A replica of `https://alexnewtron.herokuapp.com/games/meepcity/` — the external API the MeepCity Roblox game server communicates with.

## Setup

```bash
npm install
npm start
```

The server starts on port `3000` by default. Override with `PORT=8080 npm start`.

## Connecting your game

In `ServerScriptService > Server`, change:

```lua
APIServer = "https://alexnewtron.herokuapp.com/games/meepcity/",
```

to:

```lua
APIServer = "http://YOUR_HOST:3000/games/meepcity/",
```

Enable **HTTP Requests** in your Roblox game settings.

---

## Endpoints

All endpoints are mounted under `/games/meepcity/`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `raw_unixtime.php` | Returns current UNIX timestamp (plain text) |
| POST | `instance.php` | Server heartbeat — registers server, returns Unique ID, server time, banned players & bad sounds |
| GET | `report_error.php` | Receives server/client error reports |
| GET | `get_parties.php` | Lists active parties for a place |
| GET | `create_party.php` | Creates a new party, returns PartyId |
| GET | `update_party.php` | Updates player count for a party |
| GET | `kill_party.php` | Marks a party as ended |
| GET | `get_party_data.php` | Returns details for a specific party |
| GET | `get_asset_sales.php` | Returns cumulative asset sales |
| POST | `set_asset_sales.php` | Receives sales delta from the game |
| GET | `assetPurchased.php` | Records a developer product purchase |
| GET | `record_apt.php` | Records average play time |
| GET | `search_music.php` | Music search (stub — extend as needed) |
| GET | `twitter_code_use.php` | Records a redeemed Twitter promo code |
| GET | `report_bad_sound.php` | Flags a sound ID as inappropriate |

---

## Admin API

Useful for moderation tooling (not called by the game).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/status` | Overview of active instances, parties, bans |
| POST | `/admin/ban/:uid` | Ban a player by UserId |
| DELETE | `/admin/ban/:uid` | Unban a player |
| POST | `/admin/ban_sound/:sid` | Blacklist a sound ID |
| DELETE | `/admin/ban_sound/:sid` | Remove sound from blacklist |
| POST | `/admin/moderate_party/:pid` | Moderate (close) a party |

---

## Notes

- All state is **in-memory** — it resets on restart. Swap the Maps for a database (SQLite, Postgres, etc.) for persistence.
- `search_music.php` returns an empty array by default. You can hook it into the Roblox Open Cloud marketplace endpoint or your own music catalog.
- The `instance.php` body is gzip-compressed by the game server (Roblox's `HttpService:PostAsync` with `compress=true`). The middleware handles decompression automatically.

---

> **⚠️ Disclaimer**
>
> This project is an **unofficial, reverse-engineered replica** of the external API server used by [MeepCity](https://www.roblox.com/games/370731277/MeepCity) on Roblox. It is **not affiliated with, endorsed by, or approved by** Alexnewtron or Roblox Corporation in any way.
>
> This repository exists purely for **educational and personal use** — specifically to allow local playtesting of a private copy of the game. It is not intended for commercial use, public deployment, or redistribution of any proprietary game logic.
>
> All original game design, logic, and assets belong to their respective owners. If you are the rights holder and have concerns about this repository, please open an issue or contact me directly and I will address it promptly.

---
