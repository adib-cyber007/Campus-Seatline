# Android FCM manual test checklist

## Firebase console setup

1. Create or select a Firebase project and register Android application ID `edu.campus.seatline`.
2. Add the debug and release SHA-1 fingerprints used to sign the app.
3. Download the real `google-services.json` and place it at `client/android/app/google-services.json`. Never commit a fabricated file.
4. Configure the server with either `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` for a service account allowed to send FCM messages.

## Device and API checks

1. Install the prior APK, then install the new APK over it and verify Android treats it as an update after the release version is confirmed.
2. On a fresh install, log in as a rider, accept the Android 13+ notification prompt, and verify one active record is returned by `POST /api/rider/device-tokens` during the same session.
3. Register the same token repeatedly and rotate it using `previousToken`; verify one record is updated rather than duplicated.
4. Log out and verify the token is marked inactive before the local JWT and Firebase registration are cleared.
5. Keep the rider app open, trigger a BLE prompt, and verify it arrives over Socket.IO without a duplicate FCM push.
6. Background the app, trigger a BLE prompt, and verify a lock-screen notification arrives with bus/stop context and opens the canonical prompt when tapped.
7. Trigger a bus-at-stop broadcast for a downstream rider and verify the offline rider receives an FCM notification while a connected rider receives only the Socket.IO update.
8. Revoke or invalidate a test FCM token, send again, and verify the server deactivates tokens rejected as unregistered/invalid.

## Known platform confirmation

The official `@capacitor/push-notifications` plugin does not provide an API for defining Android Yes/No notification buttons, and its JavaScript action listener cannot perform an API request while the app process is fully killed. Meeting that exact requirement needs an approved native `FirebaseMessagingService`/action receiver or a different plugin with native background actions.
