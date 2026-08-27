package edu.campus.seatline;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class SeatlineBleDetectionClient {
    private SeatlineBleDetectionClient() {}

    static int post(
        SecureSessionStore.Session session,
        SeatlineBeaconConfig config,
        SeatlineBeaconReceiver.Detection detection
    ) throws IOException, JSONException {
        URL url = new URL(session.apiOrigin + "/api/rider/ble/detected");
        byte[] body = body(config, detection).getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(8_000);
            connection.setInstanceFollowRedirects(false);
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + session.authToken);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "application/json");
            connection.setFixedLengthStreamingMode(body.length);
            connection.getOutputStream().write(body);
            int statusCode = connection.getResponseCode();
            consume(statusCode >= 400 ? connection.getErrorStream() : connection.getInputStream());
            return statusCode;
        } finally {
            connection.disconnect();
        }
    }

    static String body(SeatlineBeaconConfig config, SeatlineBeaconReceiver.Detection detection)
        throws JSONException {
        JSONObject beacon = new JSONObject()
            .put("format", config.format)
            .put("uuid", config.uuid)
            .put("rssi", detection.rssi);
        if (SeatlineBeaconConfig.FORMAT_IBEACON.equals(config.format)) {
            beacon.put("major", config.major).put("minor", config.minor);
        }
        if (detection.txPower != null) beacon.put("txPower", detection.txPower);
        return new JSONObject()
            .put("busId", config.busId)
            .put("beacon", beacon)
            .toString();
    }

    private static void consume(InputStream stream) throws IOException {
        if (stream == null) return;
        try (InputStream input = stream) {
            byte[] buffer = new byte[1024];
            while (input.read(buffer) != -1) {
                // Consume the body so the connection can be released.
            }
        }
    }
}
