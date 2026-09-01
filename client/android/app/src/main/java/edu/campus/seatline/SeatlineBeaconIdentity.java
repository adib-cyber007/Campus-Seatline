package edu.campus.seatline;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

final class SeatlineBeaconIdentity {
    private SeatlineBeaconIdentity() {}

    static String serviceUuidForBusId(String busId) {
        if (busId == null || busId.trim().isEmpty()) {
            throw new IllegalArgumentException("Bus ID is required");
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(
                ("campus-seatline:bus:" + busId.trim()).getBytes(StandardCharsets.UTF_8)
            );
            bytes[6] = (byte) ((bytes[6] & 0x0f) | 0x50);
            bytes[8] = (byte) ((bytes[8] & 0x3f) | 0x80);
            StringBuilder hex = new StringBuilder(32);
            for (int index = 0; index < 16; index++) {
                hex.append(String.format("%02x", bytes[index] & 0xff));
            }
            return hex.substring(0, 8) + "-" + hex.substring(8, 12) + "-" +
                hex.substring(12, 16) + "-" + hex.substring(16, 20) + "-" +
                hex.substring(20);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("Android must provide SHA-256", error);
        }
    }
}
