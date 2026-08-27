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
import java.util.List;
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
                int status = SeatlineBleDetectionClient.post(session, config, detection);
                if (status == 400 || status == 401 || status == 403 || status == 404) {
                    SeatlineBeaconConfig.disable(appContext);
                    SeatlineBackgroundBleScanner.stop(appContext);
                } else if (status < 200 || status >= 500) {
                    SeatlineBeaconConfig.releaseSubmission(appContext, now);
                }
                // A 2xx response creates the canonical FCM Yes/No prompt on the server.
                // A 409 is also safe: duplicate-report prevention deliberately rejected it.
            } catch (IOException | JSONException | RuntimeException ignored) {
                // Keep monitoring; the next Android callback may retry the failed request.
                SeatlineBeaconConfig.releaseSubmission(appContext, now);
            } finally {
                pendingResult.finish();
            }
        });
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
            if (serviceUuids == null || !serviceUuids.contains(expected)) return null;
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
