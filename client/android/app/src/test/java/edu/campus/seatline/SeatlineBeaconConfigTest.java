package edu.campus.seatline;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SeatlineBeaconConfigTest {
    @Test
    public void proximityIncludesSignalsAtThreshold() {
        assertTrue(SeatlineBeaconConfig.isWithinProximity(-75, -75));
        assertTrue(SeatlineBeaconConfig.isWithinProximity(-61, -75));
    }

    @Test
    public void proximityRejectsSignalsBelowThreshold() {
        assertFalse(SeatlineBeaconConfig.isWithinProximity(-76, -75));
        assertFalse(SeatlineBeaconConfig.isWithinProximity(-95, -75));
    }
}
