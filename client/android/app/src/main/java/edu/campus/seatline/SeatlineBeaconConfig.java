package edu.campus.seatline;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

final class SeatlineBeaconConfig {
    static final String FORMAT_IBEACON = "ibeacon";
    static final String FORMAT_SERVICE_UUID = "service_uuid";
    static final int DEFAULT_MIN_RSSI = -75;
    static final int MIN_RSSI_LIMIT = -100;
    static final int MAX_RSSI_LIMIT = -30;

    private static final String PREFERENCES = "seatline_background_beacon";
    private static final String ENABLED = "enabled";
    private static final String TARGETS_JSON = "targets_json";
    private static final String FORMAT = "format";
    private static final String UUID_VALUE = "uuid";
    private static final String MAJOR = "major";
    private static final String MINOR = "minor";
    private static final String BUS_ID = "bus_id";
    private static final String MIN_RSSI = "min_rssi";
    private static final String LAST_SUBMITTED_AT_PREFIX = "last_submitted_at:";
    private static final long SUBMISSION_COOLDOWN_MS = 10 * 60 * 1000L;
    private static final Object SUBMISSION_LOCK = new Object();

    final boolean enabled;
    final List<Target> targets;
    final int minRssi;

    SeatlineBeaconConfig(boolean enabled, List<Target> targets, int minRssi) {
        this.targets = Collections.unmodifiableList(new ArrayList<>(targets));
        this.enabled = enabled && !this.targets.isEmpty();
        this.minRssi = minRssi;
    }

    static void save(Context context, SeatlineBeaconConfig config) {
        preferences(context).edit()
            .clear()
            .putBoolean(ENABLED, config.enabled)
            .putString(TARGETS_JSON, targetsJson(config.targets))
            .putInt(MIN_RSSI, config.minRssi)
            .apply();
    }

    static SeatlineBeaconConfig load(Context context) {
        SharedPreferences prefs = preferences(context);
        List<Target> targets = parseTargetsJson(prefs.getString(TARGETS_JSON, ""));

        // Upgrade a configuration saved by Seatline 1.3.4 or earlier.
        if (targets.isEmpty()) {
            String legacyBusId = prefs.getString(BUS_ID, "");
            String legacyUuid = prefs.getString(UUID_VALUE, "");
            if (!legacyBusId.isEmpty() && !legacyUuid.isEmpty()) {
                try {
                    targets.add(new Target(
                        legacyBusId,
                        prefs.getString(FORMAT, FORMAT_SERVICE_UUID),
                        legacyUuid,
                        prefs.getInt(MAJOR, -1),
                        prefs.getInt(MINOR, -1)
                    ));
                } catch (IllegalArgumentException ignored) {
                    // Invalid legacy values are ignored and monitoring remains disabled.
                }
            }
        }

        return new SeatlineBeaconConfig(
            prefs.getBoolean(ENABLED, false),
            targets,
            prefs.getInt(MIN_RSSI, DEFAULT_MIN_RSSI)
        );
    }

    static List<Target> parseTargetsJson(String raw) {
        List<Target> targets = new ArrayList<>();
        if (raw == null || raw.trim().isEmpty()) return targets;
        try {
            JSONArray array = new JSONArray(raw);
            for (int index = 0; index < array.length(); index++) {
                JSONObject item = array.getJSONObject(index);
                targets.add(new Target(
                    item.optString("busId", ""),
                    item.optString("format", FORMAT_SERVICE_UUID),
                    item.optString("uuid", ""),
                    item.optInt("major", -1),
                    item.optInt("minor", -1)
                ));
            }
        } catch (JSONException | IllegalArgumentException ignored) {
            targets.clear();
        }
        return targets;
    }

    static String targetsJson(List<Target> targets) {
        JSONArray array = new JSONArray();
        for (Target target : targets) {
            try {
                array.put(new JSONObject()
                    .put("busId", target.busId)
                    .put("format", target.format)
                    .put("uuid", target.uuid)
                    .put("major", target.major)
                    .put("minor", target.minor));
            } catch (JSONException ignored) {
                // All values above are primitive JSON values and should always serialize.
            }
        }
        return array.toString();
    }

    String targetSignature() {
        List<Target> sorted = new ArrayList<>(targets);
        sorted.sort(Comparator.comparing(target -> target.busId));
        StringBuilder value = new StringBuilder();
        for (Target target : sorted) {
            if (value.length() > 0) value.append('|');
            value.append(target.busId).append(':').append(target.uuid.toLowerCase(Locale.ROOT));
        }
        return value.toString();
    }

    static boolean claimSubmission(Context context, Target target, long now) {
        synchronized (SUBMISSION_LOCK) {
            SharedPreferences prefs = preferences(context);
            String key = submissionKey(target);
            long lastSubmittedAt = prefs.getLong(key, 0L);
            if (lastSubmittedAt > 0L && now - lastSubmittedAt < SUBMISSION_COOLDOWN_MS) return false;
            return prefs.edit().putLong(key, now).commit();
        }
    }

    static void releaseSubmission(Context context, Target target, long claimedAt) {
        synchronized (SUBMISSION_LOCK) {
            SharedPreferences prefs = preferences(context);
            String key = submissionKey(target);
            if (prefs.getLong(key, 0L) == claimedAt) {
                prefs.edit().putLong(key, 0L).apply();
            }
        }
    }

    static void disable(Context context) {
        preferences(context).edit().putBoolean(ENABLED, false).apply();
    }

    static void clear(Context context) {
        preferences(context).edit().clear().apply();
    }

    static boolean isWithinProximity(int rssi, int minRssi) {
        return rssi >= minRssi;
    }

    private static String submissionKey(Target target) {
        return LAST_SUBMITTED_AT_PREFIX + target.busId;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    static final class Target {
        final String busId;
        final String format;
        final String uuid;
        final int major;
        final int minor;

        Target(String busId, String format, String uuid, int major, int minor) {
            if (busId == null || busId.trim().isEmpty()) throw new IllegalArgumentException("Bus ID is required");
            String normalizedFormat = format == null || format.trim().isEmpty()
                ? FORMAT_SERVICE_UUID
                : format.trim();
            if (!FORMAT_SERVICE_UUID.equals(normalizedFormat) && !FORMAT_IBEACON.equals(normalizedFormat)) {
                throw new IllegalArgumentException("Unsupported beacon format");
            }
            if (FORMAT_IBEACON.equals(normalizedFormat)
                && (major < 0 || major > 65_535 || minor < 0 || minor > 65_535)) {
                throw new IllegalArgumentException("Invalid iBeacon component");
            }
            this.busId = busId.trim();
            this.format = normalizedFormat;
            this.uuid = UUID.fromString(uuid == null ? "" : uuid.trim()).toString();
            this.major = major;
            this.minor = minor;
        }
    }
}
