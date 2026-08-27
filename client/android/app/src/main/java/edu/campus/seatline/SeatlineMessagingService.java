package edu.campus.seatline;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public class SeatlineMessagingService extends FirebaseMessagingService {
    static final String CHANNEL_ID = "seatline-prompts";
    private static final String BLE_PROMPT = "ble_confirmation_prompt";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Map<String, String> data = remoteMessage.getData();
        SecureSessionStore.Session session = SecureSessionStore.load(this);
        if (session == null || !session.matchesUser(data.get("rider_id"))) return;

        // Preserve the standard Capacitor foreground event contract.
        PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
        showDataNotification(this, data, remoteMessage.getMessageId());
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        PushNotificationsPlugin.onNewToken(token);
    }

    static void showDataNotification(Context context, Map<String, String> data, String messageId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        createChannel(context);
        String eventId = data.get("event_id");
        String eventType = data.get("event_type");
        String title = text(data.get("title"), "Campus Seatline");
        String body = text(data.get("body"), "Open Campus Seatline for the latest update.");
        int notificationId = positiveHash(text(eventId, messageId));

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(contentIntent(context, data, messageId, notificationId));

        boolean actionable = BLE_PROMPT.equals(eventType)
            && "true".equals(data.get("native_actionable"))
            && eventId != null
            && !eventId.trim().isEmpty();
        if (actionable) {
            builder.addAction(0, "Yes", responseIntent(context, data, "yes", notificationId))
                .addAction(0, "No", responseIntent(context, data, "no", notificationId));
        }

        NotificationManagerCompat.from(context).notify(notificationId, builder.build());
    }

    private static PendingIntent contentIntent(
        Context context,
        Map<String, String> data,
        String messageId,
        int requestCode
    ) {
        Intent intent = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("google.message_id", text(messageId, String.valueOf(requestCode)));
        for (Map.Entry<String, String> entry : data.entrySet()) {
            intent.putExtra(entry.getKey(), entry.getValue());
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static PendingIntent responseIntent(
        Context context,
        Map<String, String> data,
        String answer,
        int notificationId
    ) {
        Intent intent = new Intent(context, SeatlineNotificationActionReceiver.class)
            .setAction(SeatlineNotificationActionReceiver.ACTION_RESPOND)
            .putExtra("answer", answer)
            .putExtra("event_id", data.get("event_id"))
            .putExtra("rider_id", data.get("rider_id"))
            .putExtra("notification_id", notificationId);
        int requestCode = positiveHash(data.get("event_id") + ":" + answer);
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Boarding prompts",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Time-sensitive bus boarding and arrival updates");
        channel.enableVibration(true);
        channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static int positiveHash(String value) {
        return (value == null ? "seatline" : value).hashCode() & 0x7fffffff;
    }

    private static String text(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }
}
