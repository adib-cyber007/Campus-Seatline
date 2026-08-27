package edu.campus.seatline;

import android.bluetooth.BluetoothAdapter;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class SeatlineBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean bluetoothTurnedOn = BluetoothAdapter.ACTION_STATE_CHANGED.equals(action)
            && intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
                == BluetoothAdapter.STATE_ON;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
            || bluetoothTurnedOn) {
            SeatlineBackgroundBleScanner.start(context.getApplicationContext());
        }
    }
}
