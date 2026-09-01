package edu.campus.seatline;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SeatlinePromptResponseClientTest {
    @Test
    public void responseUrlUsesCanonicalRiderEndpointAndEncodesEventId() {
        assertEquals(
            "https://seatline.example.edu/api/rider/prompts/prompt%201/respond",
            SeatlinePromptResponseClient.responseUrl(
                "https://seatline.example.edu",
                "prompt 1"
            )
        );
    }

    @Test
    public void responseBodyAllowsOnlyCanonicalAnswers() {
        assertEquals("{\"response\":\"yes\"}", SeatlinePromptResponseClient.responseBody("yes"));
        assertEquals("{\"response\":\"no\"}", SeatlinePromptResponseClient.responseBody("no"));
        assertThrows(
            IllegalArgumentException.class,
            () -> SeatlinePromptResponseClient.responseBody("maybe")
        );
    }

    @Test
    public void conflictIsRecognizedAsAlreadyHandledNotRecordedAgain() {
        SeatlinePromptResponseClient.Response response =
            new SeatlinePromptResponseClient.Response(409);
        assertTrue(response.isAlreadyHandled());
    }

    @Test
    public void softHoldActionsUseTheExistingValidatedRiderEndpoints() {
        assertEquals(
            "https://seatline.example.edu/api/rider/soft-hold",
            SeatlinePromptResponseClient.softHoldUrl("https://seatline.example.edu", "yes")
        );
        assertEquals(
            "{\"busId\":\"bus-1\",\"response\":\"yes\"}",
            SeatlinePromptResponseClient.softHoldBody("bus-1", "yes")
        );
        assertEquals(
            "https://seatline.example.edu/api/rider/soft-hold/release",
            SeatlinePromptResponseClient.softHoldUrl("https://seatline.example.edu", "no")
        );
        assertEquals(
            "{\"busId\":\"bus-1\"}",
            SeatlinePromptResponseClient.softHoldBody("bus-1", "no")
        );
    }
}
