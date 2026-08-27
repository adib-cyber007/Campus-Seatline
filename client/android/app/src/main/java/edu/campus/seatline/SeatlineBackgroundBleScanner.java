package edu.campus.seatline;

import android.Manifest;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.ParcelUuid;

import androidx.core.content.ContextCompat;

import java.util.Collections;
import java.util.UUID;

final class SeatlineBackgroundBleScanner {
    static final String ACTION_SCAN_RESULT = "edu.campus.seatline.BACKGROUND_BLE_SCAN_RESULT";
    static final int APPLE_MANUFACTURER_ID = 0x004c;
    private static final int PENDING_INTENT_REQUEST = 4130;

    private SeatlineBackgroundBleScanner() {}

    static boolean start(Context context) {
        SeatlineBeaconConfig config = SeatlineBeaconConfig.load(context);
        if (!config.enabled || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN)
            != PackageManager.PERMISSION_GRANTED) return false;

        BluetoothLeScanner scanner = scanner(context);
        if (scanner == null) return false;
        try {
            scanner.stopScan(scanIntent(context));
            int result = scanner.startScan(
                Collections.singletonList(filter(config)),
                new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
                    .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
                    .build(),
                scanIntent(context)
            );
            return result == ScanCallback.SCAN_FAILED_ALREADY_STARTED || result == 0;
        } catch (SecurityException | IllegalArgumentException error) {
            return false;
        }
    }

    static void stop(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN)
            != PackageManager.PERMISSION_GRANTED) return;
        BluetoothLeScanner scanner = scanner(context);
        if (scanner == null) return;
        try {
            scanner.stopScan(scanIntent(context));
        } catch (SecurityException ignored) {
            // Nearby-device permission can be revoked while monitoring is active.
        }
    }

    static ScanFilter filter(SeatlineBeaconConfig config) {
        if (SeatlineBeaconConfig.FORMAT_SERVICE_UUID.equals(config.format)) {
            return new ScanFilter.Builder()
                .setServiceUuid(new ParcelUuid(UUID.fromString(config.uuid)))
                .build();
        }
        byte[] prefix = new byte[] { 0x02, 0x15 };
        byte[] mask = new byte[] { (byte) 0xff, (byte) 0xff };
        return new ScanFilter.Builder()
            .setManufacturerData(APPLE_MANUFACTURER_ID, prefix, mask)
            .build();
    }

    static PendingIntent scanIntent(Context context) {
        Intent intent = new Intent(context, SeatlineBeaconReceiver.class)
            .setAction(ACTION_SCAN_RESULT)
            .setPackage(context.getPackageName());
        return PendingIntent.getBroadcast(
            context,
            PENDING_INTENT_REQUEST,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
        );
    }

    private static BluetoothLeScanner scanner(Context context) {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) return null;
        return adapter.getBluetoothLeScanner();
    }
}
