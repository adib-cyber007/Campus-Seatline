package edu.campus.seatline;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@CapacitorPlugin(
    name = "SeatlineBleScanner",
    permissions = @Permission(
        strings = { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT },
        alias = SeatlineBleScannerPlugin.BLUETOOTH_PERMISSION
    )
)
public class SeatlineBleScannerPlugin extends Plugin {
    static final String BLUETOOTH_PERMISSION = "bluetooth";
    private static final int APPLE_MANUFACTURER_ID = 0x004c;
    private static final int DEFAULT_TIMEOUT_MS = 30_000;
    private static final int MAX_TIMEOUT_MS = 120_000;
    private static final String FORMAT_IBEACON = "ibeacon";
    private static final String FORMAT_SERVICE_UUID = "service_uuid";

    private Handler mainHandler;
    private BluetoothLeScanner scanner;
    private ScanCallback callback;
    private Runnable timeoutTask;
    private boolean scanning;
    private String expectedFormat;
    private String expectedUuid;
    private int expectedMajor;
    private int expectedMinor;
    private int expectedMinRssi;

    @Override
    public void load() {
        mainHandler = new Handler(Looper.getMainLooper());
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject status = new JSObject();
        SeatlineBeaconConfig background = SeatlineBeaconConfig.load(getContext());
        boolean supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE);
        status.put("supported", supported);
        status.put("minimumAndroidApi", Build.VERSION_CODES.S);
        status.put("scanning", scanning);
        status.put("backgroundMonitoring", background.enabled);
        status.put("backgroundBusId", background.busId);
        status.put("backgroundFormat", background.format);
        status.put("backgroundUuid", background.uuid);
        status.put("backgroundMajor", background.major);
        status.put("backgroundMinor", background.minor);
        status.put("backgroundMinRssi", background.minRssi);
        status.put("permission", supported ? getPermissionState(BLUETOOTH_PERMISSION).toString().toLowerCase() : "unsupported");
        call.resolve(status);
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            call.reject("Real beacon testing requires Android 12 or newer so Seatline can scan without requesting location permission");
            return;
        }
        if (!getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            call.reject("This device does not support Bluetooth Low Energy scanning");
            return;
        }
        if (!readExpectedBeacon(call)) return;

        if (getPermissionState(BLUETOOTH_PERMISSION) != PermissionState.GRANTED) {
            requestPermissionForAlias(BLUETOOTH_PERMISSION, call, "bluetoothPermissionCallback");
            return;
        }
        beginScan(call);
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        stopScanInternal("stopped");
        call.resolve(new JSObject().put("scanning", false));
    }

    @PluginMethod
    public void enableBackgroundScan(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            call.reject("Background beacon monitoring requires Android 12 or newer");
            return;
        }
        if (!readExpectedBeacon(call)) return;
        String busId = clean(call.getString("busId"));
        if (busId.isEmpty()) {
            call.reject("Choose the bus represented by this beacon");
            return;
        }
        if (getPermissionState(BLUETOOTH_PERMISSION) != PermissionState.GRANTED) {
            requestPermissionForAlias(BLUETOOTH_PERMISSION, call, "backgroundPermissionCallback");
            return;
        }
        beginBackgroundScan(call, busId);
    }

    @PluginMethod
    public void disableBackgroundScan(PluginCall call) {
        SeatlineBackgroundBleScanner.stop(getContext());
        SeatlineBeaconConfig.disable(getContext());
        call.resolve(new JSObject().put("backgroundMonitoring", false));
    }

    @PermissionCallback
    private void backgroundPermissionCallback(PluginCall call) {
        if (getPermissionState(BLUETOOTH_PERMISSION) != PermissionState.GRANTED) {
            call.reject("Bluetooth nearby-device permission is required for background beacon monitoring");
            return;
        }
        beginBackgroundScan(call, clean(call.getString("busId")));
    }

    @PermissionCallback
    private void bluetoothPermissionCallback(PluginCall call) {
        if (getPermissionState(BLUETOOTH_PERMISSION) != PermissionState.GRANTED) {
            call.reject("Bluetooth nearby-device permission is required to scan for the bus beacon");
            return;
        }
        beginScan(call);
    }

    private boolean readExpectedBeacon(PluginCall call) {
        String format = clean(call.getString("format"));
        expectedFormat = format.isEmpty() ? FORMAT_IBEACON : format;
        if (!FORMAT_IBEACON.equals(expectedFormat) && !FORMAT_SERVICE_UUID.equals(expectedFormat)) {
            call.reject("Beacon format must be ibeacon or service_uuid");
            return false;
        }
        String uuid = clean(call.getString("uuid"));
        Integer major = call.getInt("major");
        Integer minor = call.getInt("minor");
        try {
            expectedUuid = UUID.fromString(uuid).toString();
        } catch (IllegalArgumentException error) {
            call.reject("Enter a valid iBeacon UUID");
            return false;
        }
        if (FORMAT_IBEACON.equals(expectedFormat) && (!validComponent(major) || !validComponent(minor))) {
            call.reject("iBeacon major and minor must be integers between 0 and 65535");
            return false;
        }
        expectedMajor = major == null ? -1 : major;
        expectedMinor = minor == null ? -1 : minor;
        Integer minRssi = call.getInt("minRssi", SeatlineBeaconConfig.DEFAULT_MIN_RSSI);
        if (minRssi < SeatlineBeaconConfig.MIN_RSSI_LIMIT || minRssi > SeatlineBeaconConfig.MAX_RSSI_LIMIT) {
            call.reject("Proximity threshold must be between -100 and -30 dBm");
            return false;
        }
        expectedMinRssi = minRssi;
        return true;
    }

    private void beginBackgroundScan(PluginCall call, String busId) {
        if (busId.isEmpty()) {
            call.reject("Choose the bus represented by this beacon");
            return;
        }
        SeatlineBeaconConfig config = new SeatlineBeaconConfig(
            true,
            expectedFormat,
            expectedUuid,
            expectedMajor,
            expectedMinor,
            busId,
            expectedMinRssi
        );
        SeatlineBeaconConfig.save(getContext(), config);
        if (!SeatlineBackgroundBleScanner.start(getContext())) {
            SeatlineBeaconConfig.disable(getContext());
            call.reject("Could not start background monitoring. Turn on Bluetooth and try again");
            return;
        }
        call.resolve(new JSObject()
            .put("backgroundMonitoring", true)
            .put("busId", busId)
            .put("minRssi", expectedMinRssi));
    }

    private void beginScan(PluginCall call) {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        try {
            if (adapter == null || !adapter.isEnabled()) {
                call.reject("Turn on Bluetooth before starting the beacon scan");
                return;
            }
            BluetoothLeScanner nextScanner = adapter.getBluetoothLeScanner();
            if (nextScanner == null) {
                call.reject("Bluetooth LE scanner is unavailable. Toggle Bluetooth and try again");
                return;
            }

            stopScanInternal(null);
            scanner = nextScanner;
            callback = createCallback();
            scanning = true;

            List<ScanFilter> filters;
            if (FORMAT_SERVICE_UUID.equals(expectedFormat)) {
                filters = serviceUuidFilters(expectedUuid);
            } else {
                byte[] prefix = new byte[] { 0x02, 0x15 };
                byte[] mask = new byte[] { (byte) 0xff, (byte) 0xff };
                filters = java.util.Collections.singletonList(
                    new ScanFilter.Builder()
                        .setManufacturerData(APPLE_MANUFACTURER_ID, prefix, mask)
                        .build()
                );
            }
            ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();
            scanner.startScan(filters, settings, callback);

            int timeoutMs = clampTimeout(call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS));
            timeoutTask = () -> stopScanInternal("timed_out");
            mainHandler.postDelayed(timeoutTask, timeoutMs);
            emitState("scanning", null);
            call.resolve(new JSObject().put("scanning", true).put("timeoutMs", timeoutMs));
        } catch (SecurityException error) {
            scanning = false;
            call.reject("Android denied Bluetooth scanning permission", error);
        }
    }

    private ScanCallback createCallback() {
        return new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                if (!scanning) return;
                if (!SeatlineBeaconConfig.isWithinProximity(result.getRssi(), expectedMinRssi)) return;
                ScanRecord record = result.getScanRecord();
                if (record == null) return;
                JSObject detection = new JSObject();
                detection.put("format", expectedFormat);
                if (FORMAT_SERVICE_UUID.equals(expectedFormat)) {
                    List<ParcelUuid> serviceUuids = record.getServiceUuids();
                    ParcelUuid expected = new ParcelUuid(UUID.fromString(expectedUuid));
                    boolean listedService = serviceUuids != null && serviceUuids.contains(expected);
                    boolean serviceData = record.getServiceData(expected) != null;
                    if (!listedService && !serviceData) return;
                    detection.put("uuid", expectedUuid);
                    if (record.getTxPowerLevel() != Integer.MIN_VALUE) {
                        detection.put("txPower", record.getTxPowerLevel());
                    }
                } else {
                    IBeaconParser.Beacon beacon = IBeaconParser.parse(
                        record.getManufacturerSpecificData(APPLE_MANUFACTURER_ID)
                    );
                    if (beacon == null || !beacon.matches(expectedUuid, expectedMajor, expectedMinor)) return;
                    detection.put("uuid", beacon.uuid);
                    detection.put("major", beacon.major);
                    detection.put("minor", beacon.minor);
                    detection.put("txPower", beacon.txPower);
                }
                detection.put("rssi", result.getRssi());
                detection.put("detectedAt", System.currentTimeMillis());
                stopScanInternal(null);
                emitState("matched", null);
                notifyListeners("beaconDetected", detection, true);
            }

            @Override
            public void onScanFailed(int errorCode) {
                stopScanInternal(null);
                emitState("failed", "Android BLE scan failed with code " + errorCode);
            }
        };
    }

    private void stopScanInternal(String state) {
        if (timeoutTask != null && mainHandler != null) {
            mainHandler.removeCallbacks(timeoutTask);
            timeoutTask = null;
        }
        if (scanner != null && callback != null) {
            try {
                scanner.stopScan(callback);
            } catch (SecurityException ignored) {
                // The OS may revoke nearby-device permission while a scan is active.
            }
        }
        scanner = null;
        callback = null;
        boolean wasScanning = scanning;
        scanning = false;
        if (state != null && (wasScanning || "timed_out".equals(state))) emitState(state, null);
    }

    private void emitState(String state, String message) {
        JSObject payload = new JSObject().put("state", state);
        if (message != null) payload.put("message", message);
        notifyListeners("scanStateChanged", payload, true);
    }

    @Override
    protected void handleOnPause() {
        stopScanInternal("paused");
    }

    @Override
    protected void handleOnDestroy() {
        stopScanInternal(null);
    }

    private static int clampTimeout(Integer value) {
        int timeout = value == null ? DEFAULT_TIMEOUT_MS : value;
        return Math.max(5_000, Math.min(timeout, MAX_TIMEOUT_MS));
    }

    static List<ScanFilter> serviceUuidFilters(String uuid) {
        ParcelUuid expected = new ParcelUuid(UUID.fromString(uuid));
        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(expected).build());
        filters.add(new ScanFilter.Builder().setServiceData(expected, new byte[0]).build());
        return filters;
    }

    private static boolean validComponent(Integer value) {
        return value != null && value >= 0 && value <= 65_535;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
