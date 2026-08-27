package edu.campus.seatline;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SeatlineNotificationActionsPlugin.class);
        registerPlugin(SeatlineBleScannerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
