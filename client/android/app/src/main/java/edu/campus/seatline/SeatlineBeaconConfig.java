package edu.campus.seatline;

import android.content.Context;
import android.content.SharedPreferences;

final class SeatlineBeaconConfig {
    static final String FORMAT_IBEACON = "ibeacon";
    static final String FORMAT_SERVICE_UUID = "service_uuid";
    static final int DEFAULT_MIN_RSSI = -75;
    static final int MIN_RSSI_LIMIT = -100;
    static final int MAX_RSSI_LIMIT = -30;

    private static final String PREFERENCES = "seatline_background_beacon";
    private static final String ENABLED = "enabled";
    private static final String FORMAT = "format";
    private static final String UUID = "uuid";
    private static final String MAJOR = "major";
    private static final String MINOR = "minor";
    private static final String BUS_ID = "bus_id";
    private static final String MIN_RSSI = "min_rssi";
    private static final String LAST_SUBMITTED_AT = "last_submitted_at";
    private static final long SUBMISSION_COOLDOWN_MS = 10 * 60 * 1000L;
    private static final Object SUBMISSION_LOCK = new Object();

    final boolean enabled;
    final String format;
    final String uuid;
    final int major;
    final int minor;
    final String busId;
    final int minRssi;

    SeatlineBeaconConfig(boolean enabled, String format, String uuid, int major, int minor,
                         String busId, int minRssi) {
        this.enabled = enabled;
        this.format = format;
        this.uuid = uuid;
        this.major = major;
        this.minor = minor;
        this.busId = busId;
        this.minRssi = minRssi;
    }

    static void save(Context context, SeatlineBeaconConfig config) {
        preferences(context).edit()
            .putBoolean(ENABLED, true)
            .putString(FORMAT, config.format)
            .putString(UUID, config.uuid)
            .putInt(MAJOR, config.major)
            .putInt(MINOR, config.minor)
            .putString(BUS_ID, config.busId)
            .putInt(MIN_RSSI, config.minRssi)
            .putLong(LAST_SUBMITTED_AT, 0L)
            .apply();
    }

    static SeatlineBeaconConfig load(Context context) {
        SharedPreferences prefs = preferences(context);
        return new SeatlineBeaconConfig(
            prefs.getBoolean(ENABLED, false),
            prefs.getString(FORMAT, FORMAT_IBEACON),
            prefs.getString(UUID, ""),
            prefs.getInt(MAJOR, -1),
            prefs.getInt(MINOR, -1),
            prefs.getString(BUS_ID, ""),
            prefs.getInt(MIN_RSSI, DEFAULT_MIN_RSSI)
        );
    }

    static boolean claimSubmission(Context context, long now) {
        synchronized (SUBMISSION_LOCK) {
            SharedPreferences prefs = preferences(context);
            long lastSubmittedAt = prefs.getLong(LAST_SUBMITTED_AT, 0L);
            if (lastSubmittedAt > 0L && now - lastSubmittedAt < SUBMISSION_COOLDOWN_MS) return false;
            return prefs.edit().putLong(LAST_SUBMITTED_AT, now).commit();
        }
    }

    static void releaseSubmission(Context context, long claimedAt) {
        synchronized (SUBMISSION_LOCK) {
            SharedPreferences prefs = preferences(context);
            if (prefs.getLong(LAST_SUBMITTED_AT, 0L) == claimedAt) {
                prefs.edit().putLong(LAST_SUBMITTED_AT, 0L).apply();
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

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
