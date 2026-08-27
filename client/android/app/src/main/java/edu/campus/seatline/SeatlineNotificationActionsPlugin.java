package edu.campus.seatline;

import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.GeneralSecurityException;

@CapacitorPlugin(name = "SeatlineNotificationActions")
public class SeatlineNotificationActionsPlugin extends Plugin {
    @PluginMethod
    public void configure(PluginCall call) {
        String apiOrigin = clean(call.getString("apiOrigin"));
        String authToken = clean(call.getString("authToken"));
        String userId = clean(call.getString("userId"));

        Uri parsed = Uri.parse(apiOrigin);
        boolean validOrigin = parsed.isAbsolute()
            && ("http".equals(parsed.getScheme()) || "https".equals(parsed.getScheme()))
            && parsed.getHost() != null;
        if (!validOrigin || authToken.isEmpty() || userId.isEmpty()) {
            call.reject("apiOrigin, authToken and userId are required for notification actions");
            return;
        }

        try {
            SecureSessionStore.save(
                getContext(),
                apiOrigin.replaceAll("/+$", ""),
                authToken,
                userId
            );
            call.resolve(new JSObject().put("configured", true));
        } catch (GeneralSecurityException error) {
            call.reject("Could not protect the notification-action session", error);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        SeatlineBackgroundBleScanner.stop(getContext());
        SeatlineBeaconConfig.clear(getContext());
        SecureSessionStore.clear(getContext());
        call.resolve(new JSObject().put("cleared", true));
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
