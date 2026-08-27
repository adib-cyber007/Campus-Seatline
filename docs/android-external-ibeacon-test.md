# Android external iBeacon test

Release: **1.3.4** (`versionCode 9`)

Campus Seatline can detect either a third-party iBeacon advertisement or a custom 128-bit BLE
service UUID in a one-time foreground scan or through optional closed-app monitoring. This test
path uses Android nearby-device permissions only. It does not request GPS, location permission,
or continuous location data.

## Requirements

- A rider phone running Android 12 or newer with the code-6 APK installed.
- A second phone, ESP32, Raspberry Pi, or BLE beacon capable of advertising iBeacon.
- The Seatline API running and reachable from the rider phone.
- The rider logged in with at least one bus serving their effective stop.

## Default test identity

Configure the beacon simulator in **iBeacon** mode:

| Field | Value |
| --- | --- |
| UUID | `7A4C1000-0000-4000-8000-000000000001` |
| Major | `1` |
| Minor | `1` |

The rider screen lets the tester change all three values. The simulator and Seatline values must
match exactly.

Android documents that its `neverForLocation` manifest assertion can filter some BLE beacon
frames. Release 1.3.4 keeps that privacy assertion so scans work without requesting location
permission on devices that enforce the declaration. Use **Custom BLE service UUID** and advertise
the same UUID as a 128-bit service for the supported portable test path. Major and minor are not
used in that mode.

## Test procedure

1. Start the API and keep the Firebase Admin credential configured if notification testing is
   also required.
2. Install the code-9 APK and log in as the rider.
3. On the second device, start the iBeacon advertisement using the UUID, major and minor above.
4. On the rider screen, find **Detect bus proximity**.
5. Choose which Seatline bus the test beacon represents.
6. Choose **iBeacon** or **Custom BLE service UUID**, then confirm the displayed identity matches
   the simulator.
7. Set **Reachable signal** to `-75` dBm initially and grant the Android nearby-device permission.
8. For a one-time test, tap **Scan for iBeacon**, bring the transmitter near, and confirm the
   canonical Yes/No prompt appears.
9. For the closed-app test, tap **Enable closed-app alerts**, then swipe Seatline away from Recent
   Apps without using Android's Force stop control.
10. Start the matching advertisement on the second device and bring it close enough to meet the
    configured RSSI threshold.
11. Confirm the FCM Yes/No notification appears in the Android notification tray, answer it, and
    verify the same duplicate-safe occupancy behavior used by the mock BLE flow.

The one-time scan automatically stops after a match, after 30 seconds, or when Seatline leaves the
foreground. Closed-app monitoring uses an Android filtered `PendingIntent` scan, survives normal
process removal, restarts after reboot/app upgrade/Bluetooth re-enable, and applies a ten-minute
local submission cooldown to prevent notification bursts. A successful **Yes** response stops
monitoring for that trip. **Use mock trigger** remains available for testing without hardware.

Android Force stop disables all receivers and background work until the user opens Seatline again.

## Troubleshooting

- **No matching iBeacon:** confirm the simulator emits Apple manufacturer ID `0x004C`, iBeacon
  prefix `0x02 0x15`, and the exact UUID/major/minor. If those match but detection still fails,
  use **Custom BLE service UUID** mode for that transmitter.
- **No matching service UUID:** confirm the simulator advertises the UUID in its advertising
  packet, not only after a GATT connection.
- **Nearby devices denied:** enable it under Android Settings → Apps → Campus Seatline →
  Permissions → Nearby devices.
- **No closed-app notification:** ensure notifications and Nearby devices are permitted, battery
  restrictions are not blocking Seatline, Firebase Admin credentials are configured on the
  reachable server, and the app was swiped away rather than force-stopped.
- **Bus rejected by server:** select a bus that serves the rider's effective stop today and make
  sure the rider has not already boarded for the trip.
- **Android 11 or older:** use the retained mock trigger. Real scanning is intentionally limited
  to Android 12+ to preserve the no-location-permission constraint.

## Prototype security boundary

The selected bus-to-beacon mapping is a tester-controlled mapping for external simulator
validation. Ordinary iBeacon advertisements can be copied. A production deployment should store
admin-managed beacon assignments and use rotating or authenticated beacon identifiers. The
boarding result still requires the rider's explicit Yes/No confirmation and retains all existing
duplicate-report protection.
