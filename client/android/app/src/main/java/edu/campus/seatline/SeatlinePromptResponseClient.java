package edu.campus.seatline;

import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class SeatlinePromptResponseClient {
    private SeatlinePromptResponseClient() {}

    static Response post(
        SecureSessionStore.Session session,
        String eventId,
        String answer
    ) throws IOException {
        URL url = new URL(responseUrl(session.apiOrigin, eventId));
        byte[] body = responseBody(answer).getBytes(StandardCharsets.UTF_8);
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
            return new Response(statusCode);
        } finally {
            connection.disconnect();
        }
    }

    static String responseUrl(String apiOrigin, String eventId) {
        String encodedId;
        try {
            encodedId = URLEncoder.encode(eventId, StandardCharsets.UTF_8.name())
                .replace("+", "%20");
        } catch (UnsupportedEncodingException error) {
            throw new IllegalStateException("UTF-8 must be supported", error);
        }
        return apiOrigin + "/api/rider/prompts/" + encodedId + "/respond";
    }

    static String responseBody(String answer) {
        if (!"yes".equals(answer) && !"no".equals(answer)) {
            throw new IllegalArgumentException("Answer must be yes or no");
        }
        return "{\"response\":\"" + answer + "\"}";
    }

    private static void consume(InputStream stream) throws IOException {
        if (stream == null) return;
        try (InputStream input = stream) {
            byte[] buffer = new byte[1024];
            while (input.read(buffer) != -1) {
                // Consume the response so HttpURLConnection can release resources.
            }
        }
    }

    static final class Response {
        final int statusCode;

        Response(int statusCode) {
            this.statusCode = statusCode;
        }

        boolean isRecorded() {
            return statusCode >= 200 && statusCode < 300;
        }

        boolean isAlreadyHandled() {
            return statusCode == 409;
        }
    }
}
