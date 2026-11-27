package com.squadvoice.app;

import android.graphics.Color;
import android.os.Bundle;
import android.webkit.WebView;
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
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }

    private void keepWebViewAliveIfInCall() {
        if (!VoiceCallService.isCallActive()) {
            return;
        }
        if (this.bridge != null && this.bridge.getWebView() != null) {
            WebView webView = this.bridge.getWebView();
            webView.onResume();
            webView.resumeTimers();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().resumeTimers();
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Keep JS timers, Firebase RTDB WebSocket, and WebRTC audio running when the
        // screen locks or the user switches apps while a voice call is active.
        keepWebViewAliveIfInCall();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewAliveIfInCall();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == VoiceCallPlugin.REQ_NOTIFICATIONS && VoiceCallService.isCallActive()) {
            VoiceCallService.refreshNotification(this);
        }
    }
}
