package edu.campus.seatline;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class IBeaconParserTest {
    @Test
    public void parsesConfiguredIBeaconPayload() {
        byte[] payload = new byte[] {
            0x02, 0x15,
            0x7a, 0x4c, 0x10, 0x00, 0x00, 0x00, 0x40, 0x00,
            (byte) 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
            0x00, 0x01,
            0x00, 0x01,
            (byte) 0xc5
        };

        IBeaconParser.Beacon beacon = IBeaconParser.parse(payload);

        assertEquals("7a4c1000-0000-4000-8000-000000000001", beacon.uuid);
        assertEquals(1, beacon.major);
        assertEquals(1, beacon.minor);
        assertEquals(-59, beacon.txPower);
        assertTrue(beacon.matches("7A4C1000-0000-4000-8000-000000000001", 1, 1));
    }

    @Test
    public void rejectsNonIBeaconManufacturerData() {
        assertNull(IBeaconParser.parse(new byte[] { 0x01, 0x02, 0x03 }));
        assertNull(IBeaconParser.parse(new byte[23]));
    }
}
