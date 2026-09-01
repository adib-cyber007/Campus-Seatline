package edu.campus.seatline;

import android.Manifest;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class SeatlineNotificationActionReceiver extends BroadcastReceiver {
    public static final String ACTION_RESPOND = "edu.campus.seatline.RESPOND_TO_PROMPT";
    private static final ExecutorService NETWORK_EXECUTOR = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_RESPOND.equals(intent.getAction())) return;

        String answer = intent.getStringExtra("answer");
        String eventType = intent.getStringExtra("event_type");
        String eventId = intent.getStringExtra("event_id");
        String busId = intent.getStringExtra("bus_id");
        String riderId = intent.getStringExtra("rider_id");
        int notificationId = intent.getIntExtra("notification_id", 0);
        SecureSessionStore.Session session = SecureSessionStore.load(context);
        if (session == null
            || !session.matchesUser(riderId)
            || !isValidTarget(eventType, eventId, busId)
            || (!"yes".equals(answer) && !"no".equals(answer))) {
            return;
        }

        context.getSystemService(NotificationManager.class).cancel(notificationId);
        PendingResult pendingResult = goAsync();
        NETWORK_EXECUTOR.execute(() -> {
            try {
                boolean softHoldAction = "soft_hold_prompt".equals(eventType);
                SeatlinePromptResponseClient.Response response = softHoldAction
                    ? SeatlinePromptResponseClient.postSoftHold(session, busId, answer)
                    : SeatlinePromptResponseClient.post(session, eventId, answer);
                showOutcome(context, eventType, answer, response);
            } catch (IOException | RuntimeException error) {
                showFailure(context);
            } finally {
                pendingResult.finish();
            }
        });
    }

    private static void showOutcome(
        Context context,
        String eventType,
        String answer,
        SeatlinePromptResponseClient.Response response
    ) {
        boolean softHoldAction = "soft_hold_prompt".equals(eventType);
        if (response.isRecorded()) {
            String result = softHoldAction
                ? ("yes".equals(answer) ? "Your Soft Hold remains active." : "Your Soft Hold was released.")
                : "Boarding response: " + displayAnswer(answer);
            showResult(context, "Response recorded", result);
            if (!softHoldAction && "yes".equals(answer)) {
                SeatlineBackgroundBleScanner.stop(context);
                SeatlineBeaconConfig.disable(context);
            }
        } else if (response.isAlreadyHandled()) {
            showResult(context, "Response already handled", "This boarding prompt was already answered.");
        } else if (response.statusCode == 410) {
            showResult(context, "Prompt expired", "The seat count was not changed.");
        } else if (response.statusCode == 401 || response.statusCode == 403) {
            showResult(context, "Sign in required", "Open Campus Seatline and sign in again.");
        } else {
            showFailure(context);
        }
    }

    static boolean isValidTarget(String eventType, String eventId, String busId) {
        if ("ble_confirmation_prompt".equals(eventType)) {
            return eventId != null && !eventId.trim().isEmpty();
        }
        if ("soft_hold_prompt".equals(eventType)) {
            return busId != null && !busId.trim().isEmpty();
        }
        return false;
    }

    private static void showFailure(Context context) {
        showResult(
            context,
            "Response not recorded",
            "Open Campus Seatline and answer the boarding prompt again."
        );
    }

    private static void showResult(Context context, String title, String body) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        Intent openApp = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            context,
            SeatlineMessagingService.positiveHash(title + body),
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder notification = new NotificationCompat.Builder(
            context,
            SeatlineMessagingService.CHANNEL_ID
        )
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(contentIntent);
        NotificationManagerCompat.from(context).notify(
            SeatlineMessagingService.positiveHash("result:" + title + body),
            notification.build()
        );
    }

    private static String displayAnswer(String answer) {
        return "yes".equals(answer) ? "Yes" : "No";
    }
}
