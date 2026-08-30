package edu.campus.seatline;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class SeatlineBleDetectionClient {
    private SeatlineBleDetectionClient() {}

    static Response post(
        SecureSessionStore.Session session,
        SeatlineBeaconConfig.Target target,
        SeatlineBeaconReceiver.Detection detection
    ) throws IOException, JSONException {
        URL url = new URL(session.apiOrigin + "/api/rider/ble/detected");
        byte[] body = body(target, detection).getBytes(StandardCharsets.UTF_8);
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
            String responseBody = read(
                statusCode >= 400 ? connection.getErrorStream() : connection.getInputStream()
            );
            return parseResponse(statusCode, responseBody);
        } finally {
            connection.disconnect();
        }
    }

    static String body(SeatlineBeaconConfig.Target target, SeatlineBeaconReceiver.Detection detection)
        throws JSONException {
        JSONObject beacon = new JSONObject()
            .put("format", target.format)
            .put("uuid", target.uuid)
            .put("rssi", detection.rssi);
        if (SeatlineBeaconConfig.FORMAT_IBEACON.equals(target.format)) {
            beacon.put("major", target.major).put("minor", target.minor);
        }
        if (detection.txPower != null) beacon.put("txPower", detection.txPower);
        return new JSONObject()
            .put("busId", target.busId)
            .put("beacon", beacon)
            .toString();
    }

    private static Response parseResponse(int statusCode, String responseBody) {
        Prompt prompt = null;
        try {
            JSONObject root = new JSONObject(responseBody);
            JSONArray prompts = root.optJSONArray("prompts");
            if (prompts != null && prompts.length() > 0) {
                JSONObject value = prompts.getJSONObject(0);
                String id = value.optString("id", "");
                if (!id.isEmpty()) {
                    prompt = new Prompt(
                        id,
                        value.optString("busId", ""),
                        value.optString("stopId", ""),
                        value.optString("busName", "Bus"),
                        value.optString("stopName", "your stop"),
                        value.optString("expiresAt", "")
                    );
                }
            }
        } catch (JSONException ignored) {
            // Preserve the HTTP result when a response has no prompt payload.
        }
        return new Response(statusCode, prompt);
    }

    private static String read(InputStream stream) throws IOException {
        if (stream == null) return "";
        try (InputStream input = stream) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    static final class Response {
        final int statusCode;
        final Prompt prompt;

        Response(int statusCode, Prompt prompt) {
            this.statusCode = statusCode;
            this.prompt = prompt;
        }
    }

    static final class Prompt {
        final String id;
        final String busId;
        final String stopId;
        final String busName;
        final String stopName;
        final String expiresAt;

        Prompt(
            String id,
            String busId,
            String stopId,
            String busName,
            String stopName,
            String expiresAt
        ) {
            this.id = id;
            this.busId = busId;
            this.stopId = stopId;
            this.busName = busName;
            this.stopName = stopName;
            this.expiresAt = expiresAt;
        }
    }
}
