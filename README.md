# Stop-Centric Bus Occupancy & Confirmation Platform (MVP)

A working MVP of a college bus occupancy platform built entirely around **stops**, not fixed
routes. Live `Seats Occupied` / `Soft Hold` counts are produced **only** by crowd-sourced,
notification-based reports from riders physically present at a stop.

> **Design constraint honored everywhere:** no GPS, no continuous location tracking of buses or
> riders — nothing is collected, stored, or displayed. The system only "knows" a bus arrived
> because riders at that stop confirmed it via a BLE-proximity-triggered prompt (mocked in the MVP).

## Quick start

```bash
npm run setup     # installs root + server + client deps
npm run dev       # runs API (:4000) and web app (:5173) together
```

Open http://localhost:5173

The optional Admin AI assistant uses Vercel AI Gateway from the server only. Set
`AI_GATEWAY_API_KEY` before starting the server; `ADMIN_AI_MODEL` can override the default
`openai/gpt-5.4-mini` model. If the key is absent or the provider fails, the Admin UI shows a
clear unavailable message and does not fabricate an answer.

## Android APK

The Android client is a Capacitor shell around the same React application. Build a debug APK
locally from `client/` with Android SDK 36 and Java 21 installed:

Current release: **1.1.0** on root/client/server and Android `versionName` (`versionCode 3`).

```bash
npm run android:build
```

The APK is written to `client/android/app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions
checks version parity, runs native unit tests, and publishes `campus-seatline-debug-apk`.

Live FCM requires the real Firebase project file at
`client/android/app/google-services.json` plus Firebase Admin credentials on the server. Keep both
out of source control; see `docs/android-fcm-manual-test.md` for setup and device verification.

On first launch, open **Server connection** and enter the reachable root URL of the running
Express/Socket.IO backend (for example `https://seatline.example.edu`, without `/api`). The APK
permits plain HTTP for a trusted campus-LAN development server, but production should use HTTPS.
The backend is not embedded in the APK and must be hosted separately. Offline riders receive
data-only FCM; BLE prompts are rendered natively with lock-screen Yes/No actions that reuse the
same authenticated, duplicate-safe response endpoint as the in-app prompt.

Verify the backend core loop any time with:

```bash
npm run smoke     # 114 end-to-end assertions, no server needed (spins its own instance)
```

### Seeded demo accounts

| Role                      | Email                  | Password      | Notes                          |
| ------------------------- | ---------------------- | ------------- | ------------------------------ |
| Admin                     | admin@campus.edu       | admin123      | full management + audit trail  |
| Rider + Incharge authority| incharge@campus.edu    | incharge123   | rider account with granted Incharge authority over Shuttle-01 |
| Rider                     | rider@campus.edu       | rider123      | registered at Main Gate        |
| Rider                     | rider2@campus.edu      | rider123      | registered at Library Block (downstream) |
| Rider                     | rider3@campus.edu      | rider123      | registered at Hostel Circle    |

There is no separate "Incharge login" — Incharge is an authority an Admin grants to any rider,
scoped to bus(es) and/or stop(s), revocable at any time.

Seed topology: `Shuttle-01` (40 seats): Main Gate → Library Block → Hostel Circle;
`Express-02` (24 seats): Main Gate → Sports Complex → North Campus.

### 5-minute demo script

1. **Admin** (`admin@campus.edu`): see live occupancy table; create/edit stops with timelines,
   link buses to stops, set capacity, grant/revoke Incharge authority (Incharge tab, or inline
   in a stop's editor); the Stops tab has search/sort/filters/pagination for large stop lists.
2. **Rider** (`rider@campus.edu`, open in one browser profile): sees both buses auto-resolved
   from their stop. Answer **Yes** to *"Will you be boarding Shuttle-01 today?"* → Soft Holds +1,
   Available −1 — visible **live** (Socket.IO) in every other session, no refresh.
3. Same rider: pick Shuttle-01 under *Simulate BLE detection* → trigger. The prompt
   *"Have you boarded Shuttle-01 at Main Gate?"* appears with a 2-minute countdown.
4. Answer **Yes** → Soft Hold is **promoted** to Seats Occupied (net Available unchanged),
   a `StopArrivalEvent` is created, and every user at downstream stops (e.g. `rider2@campus.edu`
   at Library Block) instantly receives *"Bus Shuttle-01 has reported at Main Gate."*
5. A rider **without** a soft hold who answers Yes to the BLE prompt goes straight to
   Seats Occupied (+1) without touching Soft Holds. Answering **No** (or letting the timer
   expire) changes nothing. Any further report attempt by a rider already boarded is rejected —
   counts can never be inflated twice.
6. **Rider with Incharge authority** (`incharge@campus.edu`): same rider view, plus an
   "Incharge controls" section on their authorized bus(es). They edit **Seats Available**;
   `Seats Occupied = capacity − seats_available − soft_holds` is back-calculated, broadcast
   live to everyone, and audit-logged with old/new values.
7. **Admin → Audit**: complete trail of report attempts (including rejected duplicates),
   arrival events, availability corrections, and authority grants/revocations.
8. A rider can move a Soft Hold to another bus, or BLE-confirm a different bus to atomically
   release the old hold and board the detected bus. Riders with one bus option are held once
   automatically and can release with one tap.
9. **Admin → AI assistant**: ask a read-only question about stops, buses, occupancy,
   assignments, or audit activity. The module has no write tools or mutation routes.

## What's real vs mocked

| Concern          | MVP implementation                                            | Production would need                     |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------- |
| BLE proximity    | **Mocked** — manual "Trigger detection" button per rider       | Real beacons on buses + scanner integration (see below) |
| Notifications    | Socket.IO in-app + offline Android FCM with native Yes/No actions | Configure Firebase credentials and production monitoring |
| Real-time sync   | Socket.IO (real)                                               | same, or Firestore streams                |
| Auth             | JWT with roles (rider/admin; Incharge = granted authority), scrypt hashes | Firebase Auth / hardened JWT rotation |
| Storage          | **In-memory** (resets on restart)                              | Firestore/Postgres persistence            |

### Where real BLE plugs in

All detection flows through one seam: [`server/src/services/bleGateway.js`](server/src/services/bleGateway.js).

- The mock UI calls `POST /api/rider/ble/simulate`, which calls `submitDetection({ userId, busId, stopId })`.
- `app.js` registers the production handler once via `onDetection(handleDetection)`.
- A real deployment replaces the simulate call with an actual scanner (Web Bluetooth PWA, or a
  React Native shell) that detects the bus beacon and submits the **same event shape** —
  `{ userId, busId, stopId }`. No other layer changes: prompts, promotion logic, arrival events,
  broadcasts, and audit all sit downstream of that single entry point.

## Architecture

```
client (React + Vite)                server (Express + Socket.IO)
├─ LoginPage (JWT, rider register)   ├─ routes/ auth · meta · me · rider · admin
├─ RiderPage   (holds, BLE sim,      ├─ services/
│   prompts, live counts,            │   ├─ bleGateway.js   ← single BLE swap-in seam
│   permission-gated Incharge        │   ├─ occupancy.js    ← one-state-per-rider machine,
│   controls, day-stop override)     │   │                     derived counts + corrections
└─ AdminPage   (stops w/ search/     │   ├─ audit.js        ← attempts/events/corrections/
     sort/filter/pager, buses,        │   │                     authority grants
     assignments, users/audit/AI)    │   └─ adminAssistant.js ← read-only LLM boundary
                                     ├─ db.js (in-memory seed + atomic state transition)
     ▲ Socket.IO rooms per user      └─ index.js (HTTP + WS bootstrap)
     └ events: occupancy · notification · prompts · arrival · audit · refresh
```

Key domain rules implemented in `services/occupancy.js`:

- **One active report state per (rider, trip/day), globally across buses** — the data-layer
  transition boundary allows only `no_report`, `soft_hold(bus_id)`, or
  `seats_occupied(bus_id)`. A bus switch releases the former Soft Hold and applies the new
  state synchronously before any realtime broadcast. Released records remain inactive history;
  every attempt is separately logged to the immutable `reportAttempts` audit trail.
- Live counts are **derived**, not accumulated: `seats_occupied = confirmed_states + manual_
  adjustment` and `available = capacity − occupied − soft_holds`.
- Soft hold "Yes" sets state `soft_hold` (idempotent); "No" logs the attempt and changes nothing.
- A single viable bus at the rider's effective stop triggers one automatic Soft Hold evaluation
  on the first overview for that daily trip context. Releasing it uses the same release endpoint
  and an evaluation marker prevents recreation that day. No timing-based seat priority is used.
- A rider can optionally select a different stop for today. BLE prompts, bus options, automatic
  holds, and downstream notifications use that effective stop; the registered stop is unchanged
  and becomes effective again automatically when the server's trip-day key changes.
- Rapid/simultaneous holds, BLE detections and prompt answers are idempotent in the single-node
  runtime; a full bus rejects new holds and direct boarding reports without changing counts.
- BLE "Yes": promotes `soft_hold → seats_occupied`, or boards directly; first confirmation for a
  bus/stop creates the `StopArrivalEvent` and fans out notifications to downstream stops' users
  plus riders holding Incharge authority covering that bus/stop. Repeat attempts after boarding
  are rejected (HTTP 409 at the route, idempotent no-op in the service) — never double-counted.
- Incharge correction (authority-gated): edits **Seats Available** only;
  `seats_occupied = capacity − seats_available − soft_holds` is back-calculated via a stored
  manual adjustment (so subsequent crowd-sourced boardings still increment naturally), broadcast
  instantly, and audit-logged with previous/new values. A correction cannot claim more available
  seats than capacity permits while Soft Holds are active, and manual adjustments reset on the
  next trip day. No reputation/trust-score/mismatch logic exists anywhere by design.

## API surface (summary)

- `POST /api/auth/login` · `POST /api/auth/register` (rider-only self-registration + stop selection)
- `GET  /api/meta` (public stop list) · `GET /api/me`
- Rider: `GET /api/rider/overview` · `POST /api/rider/soft-hold` · `POST /api/rider/ble/simulate` ·
  `POST /api/rider/soft-hold/release` · `POST/DELETE /api/rider/daily-stop` ·
  `POST /api/rider/prompts/:id/respond`
- Rider with Incharge authority (permission-gated):
  `POST /api/rider/incharge/buses/:busId/available` (edit Seats Available) ·
  `GET /api/rider/incharge/assignments`
- Admin: `GET /api/admin/overview` · `POST/PUT /api/admin/stops[/:id]` · `POST/PUT /api/admin/buses[/:id]` ·
  `POST /api/admin/incharge-assignments` · `DELETE /api/admin/incharge-assignments/:id` (revoke) ·
  `POST /api/admin/assistant/query` (strictly read-only)

## Explicitly out of scope (by design)

- **GPS / continuous location** — not collected, stored, or displayed at any layer.
- **Reputation, trust scores, mismatch flagging** — none exists, not even as a stub.

## Deferred edge cases (not silently dropped)

- Multi-trip-per-day model: arrival events and rider report states are scoped by `tripDate`
  (= calendar day, server timezone); a true multi-trip model with per-run identifiers is deferred.
- Atomicity of the one-state-per-rider rule relies on Node's single-threaded find-or-create
  (no await between check and write). A real DB would enforce it with a unique constraint on
  `(rider_id, trip_id)` plus a transactional state transition.
- There is no separate schedule-confirmation entity in this MVP. The first rider overview for a
  stop/day is the existing daily-trip confirmation boundary used for automatic Soft Holds.
- Incharge Seats Available corrections are stored as a manual adjustment relative to the
  crowd-sourced count; if the correction is meant to be absolute forever, an explicit
  adjustment-reset action would need to be added.
- "Has Incharge" filter on the Stops dashboard counts a stop as covered if any active assignment
  covers it directly (stop scope) or via a bus passing through it (bus scope).
- Prompt expiry uses in-process timers; a crash could orphan pending prompts (lazy expiry on read
  covers reads, but no background sweeper across restarts).
- Single-node in-memory store: no concurrency control, replication, or offline queueing.
- Notification fan-out is instant-only; no digest/retry if a client is offline (feed history
  partially covers this).

## MVP → production checklist

1. Swap the mocked BLE trigger for real hardware scanning (see seam above); deploy beacons per
   bus and define RSSI/proximity thresholds.
2. Replace in-memory store with Firestore/Postgres; move timers to durable jobs.
3. Complete Firebase console/signing setup and validate killed-app actions across supported Android devices.
4. Harden auth (secret rotation, refresh tokens), add rate limiting and input validation layers.
5. Model multiple trips/day and service disruptions; add admin tooling for day resets.
