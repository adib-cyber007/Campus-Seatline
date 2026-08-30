# Bus beacon deployment and UUID mapping

Campus Seatline assigns every bus one unique, server-owned 128-bit BLE service UUID. The canonical mapping is stored in PostgreSQL in `bus_beacons`; riders may view it but cannot edit it or claim that an arbitrary UUID represents another bus. The API independently resolves every detected UUID and rejects unknown or mismatched UUID/bus submissions before creating a boarding prompt.

## Mapping before hardware is available

1. Sign in as Admin and open **Buses**.
2. Find the bus and copy its **Bus beacon · server assigned** UUID.
3. Record the physical asset label or simulator device beside that UUID in the transport office's deployment register.
4. Never reuse one bus's UUID on another bus and never hand-edit the database mapping. Creating a bus creates its mapping automatically; editing a bus preserves it.

The mapping can therefore be prepared and reviewed before physical beacons arrive. A bus created in a development or test database has a different identity from a separately created production bus; always use the UUID shown by the target production server.

## Configure each physical beacon

Use these settings consistently:

| Setting | Required value |
| --- | --- |
| Broadcast type | Custom 128-bit BLE service UUID |
| Service UUID | Exact UUID shown for that bus in Admin |
| Advertising mode | Legacy BLE (BLE 4.x) |
| Advertising interval | 350 ms (supported range: 250–500 ms) |
| Connectable | Off where the device supports it |
| Scan response | Optional; the UUID must be in the primary advertisement |
| GPS/location payload | None |

Start with moderate transmitter power and the app's `-75 dBm` reachable-signal threshold, then tune the threshold during a stationary bus test. The threshold is a proximity heuristic, not a distance measurement.

## Simulator acceptance test

1. Configure a second Android phone or BLE tool with Bus A's exact service UUID, Legacy mode, and a 350 ms interval.
2. Log a rider whose effective stop is served by Bus A into the Android app, confirm Bus A appears in the monitored list, and tap **Scan for nearby buses**.
3. Start the advertisement and bring it within the configured RSSI threshold.
4. Confirm the server returns the canonical Yes/No boarding prompt.
5. Submit Bus A with Bus B's UUID using the automated smoke test or API test harness; confirm `409 BEACON_BUS_MISMATCH` and no prompt/count change.
6. Submit a syntactically valid but unassigned UUID; confirm `422 UNKNOWN_BEACON_UUID`.
7. Answer Yes once for a matched prompt and confirm normal Soft Hold promotion/direct occupancy and duplicate prevention.

The server's retained mock endpoint does not prove radio detection or UUID matching. It exists only for automated occupancy-flow testing without hardware.

## Operational constraints

- Android 12+ is required for real scanning without location permission.
- Seatline requests Nearby devices and notifications only; it has no GPS or continuous location tracking.
- Swiping the app from Recents can leave the registered closed-app scan active. Android Force stop disables receivers until the app is opened again.
- Foreground and closed-app scans monitor every active bus UUID serving the rider's effective stop; detecting one bus does not suppress a different bus because cooldowns are maintained per bus.
- A static BLE UUID can be copied or replayed. Phase 2 validates identity-to-bus consistency; it is not cryptographic proof that a transmitter is genuine.
