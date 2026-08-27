# Android FCM manual test checklist

Release under test: **1.3.4** (`versionCode 9`), upgrading from **1.3.3** (`versionCode 8`).

## Firebase console setup

1. Create or select a Firebase project and register Android application ID `edu.campus.seatline`.
2. From `client/android`, run `.\gradlew.bat signingReport` and register the SHA-1 fingerprints for every debug/release signing key used in testing.
3. Download the real `google-services.json` and place it at `client/android/app/google-services.json`. Never fabricate or commit this project-specific file.
4. Configure the deployed server with exactly one credential source: `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`. Never put the service-account credential in the APK.
5. Run the API over HTTPS outside a trusted development LAN. The native action receiver calls the same configured API origin used at login.

## Automated checks

- `npm --prefix client run version:check` verifies root, client, server, Android `versionName`, and the monotonic Android code floor.
- `npm --prefix server run smoke` verifies token upsert/rotation/logout, offline-only delivery, invalid-token retirement, and the high-priority data-only action payload.
- From `client/android`, `.\gradlew.bat testDebugUnitTest assembleDebug` compiles the native service/receiver/scanner, tests canonical response URL/body construction plus iBeacon parsing, and assembles the APK. A successful closed-app BLE response is rendered locally from the canonical server prompt while FCM remains a redundant delivery path.
- GitHub Actions runs all credential-free Android checks and publishes `campus-seatline-debug-apk`; create the FCM-enabled release artifact only in a trusted release environment containing the real `google-services.json`.

## Device and API checks

1. Install the prior code-3 APK, then install the code-4 APK over it. Confirm Android updates the app without clearing rider data.
2. On a fresh install, connect to the backend, log in as a rider, and accept the Android 13+ notification permission. Confirm one active device-token record is created in the same session.
3. Register the same token repeatedly and rotate it using `previousToken`; confirm one record is updated rather than duplicated.
4. Log out and confirm the server token is inactive and the native encrypted JWT/session is cleared before another user signs in.
5. Keep the rider app open and connected, trigger a BLE prompt, and confirm it arrives over Socket.IO with no redundant FCM notification.
6. Remove the app from Recents (do not use Android's **Force stop**), lock the device, and trigger a BLE prompt. Confirm a high-priority notification appears with **Yes** and **No** buttons.
7. Tap **Yes** without unlocking/opening the app. Confirm the notification is dismissed, a “Response recorded” acknowledgement appears, and the canonical prompt becomes answered with the same occupied/arrival effects as in-app Yes.
8. Repeat with **No** and confirm the prompt becomes answered while seat counts remain unchanged.
9. Attempt to replay an action or answer the same prompt in-app. Confirm the canonical endpoint returns the already-answered response and no count can inflate.
10. Trigger an expired prompt and an offline API failure. Confirm the native acknowledgement clearly says expired/not recorded rather than claiming success.
11. Trigger a bus-at-stop broadcast for a downstream rider. Confirm the offline rider receives FCM while a socket-connected rider receives only Socket.IO.
12. Revoke a test FCM token, send again, and confirm the server deactivates tokens rejected as unregistered/invalid.

## Native action design

Capacitor Push Notifications still owns permission requests, FCM registration/token refresh, channels, and foreground JavaScript events. The authorized native layer replaces only the merged Android `FirebaseMessagingService` and adds a non-exported action receiver. It:

- accepts data only when `rider_id` matches the current native rider session;
- encrypts the JWT at rest with an Android Keystore AES-GCM key;
- renders Yes/No only for `ble_confirmation_prompt`;
- sends the answer to `POST /api/rider/prompts/:eventId/respond`, the same duplicate-safe endpoint used by the React UI;
- clears the native session on logout.

“App killed” here means the activity/WebView is closed or removed from Recents. Android intentionally suppresses FCM after a user explicitly **Force stops** an app until the user opens it again.
