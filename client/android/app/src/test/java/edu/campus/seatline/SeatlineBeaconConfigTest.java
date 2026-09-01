package edu.campus.seatline;

import org.junit.Test;

import java.util.Arrays;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
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

    @Test
    public void targetSignatureIncludesEveryBusAndIsOrderIndependent() {
        SeatlineBeaconConfig.Target busA = new SeatlineBeaconConfig.Target(
            "bus-a", "service_uuid", "7A4C1000-0000-4000-8000-000000000001", -1, -1
        );
        SeatlineBeaconConfig.Target busB = new SeatlineBeaconConfig.Target(
            "bus-b", "service_uuid", "7A4C1000-0000-4000-8000-000000000002", -1, -1
        );

        SeatlineBeaconConfig first = new SeatlineBeaconConfig(true, Arrays.asList(busB, busA), -75);
        SeatlineBeaconConfig second = new SeatlineBeaconConfig(true, Arrays.asList(busA, busB), -75);

        assertEquals(
            "bus-a|bus-b",
            first.targetSignature()
        );
        assertEquals(first.targetSignature(), second.targetSignature());
        assertEquals(2, first.targets.size());
    }

    @Test
    public void serviceUuidIsDerivedInsideNativeCodeWithoutWebViewDisclosure() {
        SeatlineBeaconConfig.Target target = new SeatlineBeaconConfig.Target(
            "bus-a", "service_uuid", "", -1, -1
        );
        assertEquals("e4120669-f11c-5ae8-a868-2b5b70bd5637", target.uuid);
        assertEquals(target.uuid, SeatlineBeaconIdentity.serviceUuidForBusId("bus-a"));
    }
}
