package edu.campus.seatline;

import java.nio.ByteBuffer;
import java.util.UUID;

final class IBeaconParser {
    private static final int IBEACON_PAYLOAD_LENGTH = 23;

    private IBeaconParser() {}

    static Beacon parse(byte[] manufacturerData) {
        if (manufacturerData == null || manufacturerData.length < IBEACON_PAYLOAD_LENGTH) return null;
        if ((manufacturerData[0] & 0xff) != 0x02 || (manufacturerData[1] & 0xff) != 0x15) return null;

        ByteBuffer uuidBytes = ByteBuffer.wrap(manufacturerData, 2, 16);
        UUID uuid = new UUID(uuidBytes.getLong(), uuidBytes.getLong());
        int major = ((manufacturerData[18] & 0xff) << 8) | (manufacturerData[19] & 0xff);
        int minor = ((manufacturerData[20] & 0xff) << 8) | (manufacturerData[21] & 0xff);
        int txPower = manufacturerData[22];
        return new Beacon(uuid.toString(), major, minor, txPower);
    }

    static final class Beacon {
        final String uuid;
        final int major;
        final int minor;
        final int txPower;

        Beacon(String uuid, int major, int minor, int txPower) {
            this.uuid = uuid;
            this.major = major;
            this.minor = minor;
            this.txPower = txPower;
        }

        boolean matches(String expectedUuid, int expectedMajor, int expectedMinor) {
            return uuid.equalsIgnoreCase(expectedUuid)
                && major == expectedMajor
                && minor == expectedMinor;
        }
    }
}
