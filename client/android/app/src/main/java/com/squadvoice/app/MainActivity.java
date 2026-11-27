package com.squadvoice.app;

import android.graphics.Color;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceCallPlugin.class);
        registerPlugin(ScreenSharePlugin.class);
        super.onCreate(savedInstanceState);
        if (getWindow() != null) {
            getWindow().setStatusBarColor(Color.parseColor("#111214"));
            getWindow().setNavigationBarColor(Color.parseColor("#111214"));
        }
    }
}
