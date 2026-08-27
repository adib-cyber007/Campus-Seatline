package edu.campus.seatline;

import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.ParcelUuid;
import android.os.Build;

import org.json.JSONException;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class SeatlineBeaconReceiver extends BroadcastReceiver {
    private static final ExecutorService NETWORK_EXECUTOR = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!SeatlineBackgroundBleScanner.ACTION_SCAN_RESULT.equals(intent.getAction())) return;
        if (intent.getIntExtra(BluetoothLeScanner.EXTRA_ERROR_CODE, 0) != 0) return;

        SeatlineBeaconConfig config = SeatlineBeaconConfig.load(context);
        if (!config.enabled) return;
        Detection detection = closestMatching(intent, config);
        long now = System.currentTimeMillis();
        if (detection == null
            || !SeatlineBeaconConfig.isWithinProximity(detection.rssi, config.minRssi)
            || !SeatlineBeaconConfig.claimSubmission(context, now)) return;

        SecureSessionStore.Session session = SecureSessionStore.load(context);
        if (session == null) {
            SeatlineBeaconConfig.disable(context);
            SeatlineBackgroundBleScanner.stop(context);
            return;
        }

        PendingResult pendingResult = goAsync();
        Context appContext = context.getApplicationContext();
        NETWORK_EXECUTOR.execute(() -> {
            try {
                SeatlineBleDetectionClient.Response response =
                    SeatlineBleDetectionClient.post(session, config, detection);
                int status = response.statusCode;
                if (status == 400 || status == 401 || status == 403 || status == 404) {
                    SeatlineBeaconConfig.disable(appContext);
                    SeatlineBackgroundBleScanner.stop(appContext);
                } else if (status < 200 || status >= 500) {
                    SeatlineBeaconConfig.releaseSubmission(appContext, now);
                } else if (status < 300 && response.prompt != null) {
                    showPromptNotification(appContext, session, response.prompt);
                }
                // A 2xx response carries the canonical server prompt; FCM may update it later.
                // A 409 is also safe: duplicate-report prevention deliberately rejected it.
            } catch (IOException | JSONException | RuntimeException ignored) {
                // Keep monitoring; the next Android callback may retry the failed request.
                SeatlineBeaconConfig.releaseSubmission(appContext, now);
            } finally {
                pendingResult.finish();
            }
        });
    }

    private static void showPromptNotification(
        Context context,
        SecureSessionStore.Session session,
        SeatlineBleDetectionClient.Prompt prompt
    ) {
        Map<String, String> data = new HashMap<>();
        data.put("event_type", "ble_confirmation_prompt");
        data.put("event_id", prompt.id);
        data.put("rider_id", session.userId);
        data.put("bus_id", prompt.busId);
        data.put("stop_id", prompt.stopId);
        data.put("expires_at", prompt.expiresAt);
        data.put("title", prompt.busName + " at " + prompt.stopName);
        data.put("body", "Have you boarded? Tap Yes or No below.");
        data.put("channel_id", SeatlineMessagingService.CHANNEL_ID);
        data.put("native_actionable", "true");
        SeatlineMessagingService.showDataNotification(context, data, prompt.id);
    }

    static Detection closestMatching(Intent intent, SeatlineBeaconConfig config) {
        ArrayList<ScanResult> results = scanResults(intent);
        if (results == null || results.isEmpty()) return null;
        Detection closest = null;
        for (ScanResult result : results) {
            Detection candidate = match(result, config);
            if (candidate != null && (closest == null || candidate.rssi > closest.rssi)) {
                closest = candidate;
            }
        }

        return closest;
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<ScanResult> scanResults(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableArrayListExtra(
                BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT,
                ScanResult.class
            );
        }
        return intent.getParcelableArrayListExtra(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT);
    }

    static Detection match(ScanResult result, SeatlineBeaconConfig config) {
        ScanRecord record = result == null ? null : result.getScanRecord();
        if (record == null) return null;
        if (SeatlineBeaconConfig.FORMAT_SERVICE_UUID.equals(config.format)) {
            List<ParcelUuid> serviceUuids = record.getServiceUuids();
            ParcelUuid expected = new ParcelUuid(UUID.fromString(config.uuid));
            boolean listedService = serviceUuids != null && serviceUuids.contains(expected);
            boolean serviceData = record.getServiceData(expected) != null;
            if (!listedService && !serviceData) return null;
            Integer txPower = record.getTxPowerLevel() == Integer.MIN_VALUE
                ? null
                : record.getTxPowerLevel();
            return new Detection(result.getRssi(), txPower);
        }
        IBeaconParser.Beacon beacon = IBeaconParser.parse(
            record.getManufacturerSpecificData(SeatlineBackgroundBleScanner.APPLE_MANUFACTURER_ID)
        );
        if (beacon == null || !beacon.matches(config.uuid, config.major, config.minor)) return null;
        return new Detection(result.getRssi(), beacon.txPower);
    }

    static final class Detection {
        final int rssi;
        final Integer txPower;

        Detection(int rssi, Integer txPower) {
            this.rssi = rssi;
            this.txPower = txPower;
        }
    }
}
