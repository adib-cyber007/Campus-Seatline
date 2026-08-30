# Android external bus beacon test

Release: **1.3.5** (`versionCode 10`)

Campus Seatline's supported radio identity is a server-assigned custom 128-bit BLE service UUID. It works in a one-time foreground scan or through optional closed-app monitoring using Android Nearby devices permission only. The app does not request GPS, location permission, or continuous location data.

## Requirements

- A rider phone running Android 12 or newer with the APK installed.
- A second phone, ESP32, Raspberry Pi, or physical BLE beacon capable of advertising a custom 128-bit service UUID in Legacy BLE mode.
- The Seatline API reachable from the rider phone.
- A logged-in rider with at least one bus serving their effective stop.

## Get the correct identity

Each bus has a different UUID. Sign in as Admin, open **Buses**, and copy the target bus's **Bus beacon · server assigned** UUID. The rider screen lists every read-only beacon identity for buses serving the rider's effective stop. There is intentionally no bus selector, rider-editable UUID, iBeacon major, or iBeacon minor.

Configure the transmitter as follows:

| Field | Value |
| --- | --- |
| Broadcast format | Custom 128-bit BLE service UUID |
| UUID | The exact UUID assigned to the chosen bus |
| Advertising mode | Legacy BLE (BLE 4.x) |
| Interval | 350 ms (250–500 ms is accepted operationally) |
| Connectable | Off if supported |

The UUID must appear in the primary advertising packet, not only after a GATT connection. See [bus-beacon-deployment.md](./bus-beacon-deployment.md) for the fleet mapping procedure.

## Test procedure

1. Start the API and configure Firebase Admin credentials if redundant FCM delivery is also being tested.
2. Install the APK and log in as a rider.
3. Configure the second device using the chosen bus's exact server-assigned UUID and start Legacy BLE advertising.
4. On the rider screen, open **Detect bus proximity** and confirm the target bus appears in the automatically monitored beacon list.
5. Set **Reachable signal** to `-75` dBm initially and grant Nearby devices permission.
6. Tap **Scan for nearby buses**, bring the transmitter near, and confirm the app identifies the correct bus and the canonical Yes/No prompt appears.
7. For a closed-app test, tap **Enable closed-app alerts**, swipe Seatline away from Recents without using Force stop, then move the active transmitter within threshold.
8. Confirm the Yes/No notification appears in the notification tray, answer it, and verify the same duplicate-safe occupancy behavior as the in-app prompt.

A one-time scan watches all eligible bus UUIDs and stops after a match, 30 seconds, or when Seatline leaves the foreground. Closed-app monitoring uses filtered Android scans for all eligible buses, survives normal process removal, restarts after reboot/app upgrade/Bluetooth re-enable, and applies an independent ten-minute local submission cooldown per bus. A successful Yes response stops monitoring for that trip. The server mock endpoint remains available to automated tests but does not test radio or UUID validation.

Android Force stop disables receivers and background work until the user opens Seatline again.

## Expected server validation

- Correct bus + its assigned UUID: the server creates or returns the canonical prompt.
- Bus A + Bus B's UUID: `409 BEACON_BUS_MISMATCH`; no prompt or occupancy change.
- Unknown valid UUID: `422 UNKNOWN_BEACON_UUID`; no prompt or occupancy change.
- iBeacon/manufacturer-format payload: rejected as unsupported on the production detection endpoint.

## Troubleshooting

- **No matching signal:** verify the complete 128-bit UUID, Legacy mode, advertisement running, and UUID present in the primary packet.
- **Nearby devices denied:** enable it under Android Settings → Apps → Campus Seatline → Permissions → Nearby devices.
- **No closed-app notification:** allow notifications and Nearby devices, remove battery restrictions, confirm server reachability and authentication, and swipe away rather than Force stop.
- **Bus mismatch:** verify the transmitter UUID belongs to one of the buses listed for the rider's effective stop. Riders cannot override the server mapping.
- **Android 11 or older:** use the server test endpoint from a development environment. Real scanning is limited to Android 12+ to preserve the no-location-permission constraint.

## Security boundary

The native scanner maps the detected UUID to a bus from the server-supplied list, and the server independently verifies that mapping and the rider's effective-stop topology. Static BLE advertisements can still be copied or replayed, so this validates mapping consistency rather than cryptographic transmitter authenticity. Explicit rider confirmation and all existing duplicate-report prevention remain required.
