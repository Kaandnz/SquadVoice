package com.squadvoice.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;

@CapacitorPlugin(name = "VoiceCall")
public class VoiceCallPlugin extends Plugin {
    public static final int REQ_NOTIFICATIONS = 4202;
    private static WeakReference<VoiceCallPlugin> activeInstance = new WeakReference<>(null);

    @Override
    public void load() {
        activeInstance = new WeakReference<>(this);
    }

    public static void dispatchNotificationAction(String eventName) {
        VoiceCallPlugin instance = activeInstance.get();
        if (instance != null) {
            instance.notifyListeners(eventName, new JSObject());
        }
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        Context ctx = getContext();
        if (ctx == null || getActivity() == null) {
            return;
        }
        if (
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                getActivity(),
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                REQ_NOTIFICATIONS
            );
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        requestNotificationPermissionIfNeeded();
        Context ctx = getContext();
        if (ctx == null) {
            call.resolve();
            return;
        }
        Intent intent = new Intent(ctx, VoiceCallService.class);
        intent.setAction(VoiceCallService.ACTION_START);
        intent.putExtra(VoiceCallService.EXTRA_CHANNEL_NAME, call.getString("channelName", "Ses Kanalı"));
        intent.putExtra(VoiceCallService.EXTRA_SERVER_NAME, call.getString("serverName", "SquadVoice"));
        intent.putExtra(VoiceCallService.EXTRA_MUTED, call.getBoolean("muted", false));
        intent.putExtra(VoiceCallService.EXTRA_DEAFENED, call.getBoolean("deafened", false));
        try {
            ContextCompat.startForegroundService(ctx, intent);
        } catch (Exception ignored) {
            // Do not crash voice join if OS blocks background start
        }
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.resolve();
            return;
        }
        Intent intent = new Intent(ctx, VoiceCallService.class);
        intent.setAction(VoiceCallService.ACTION_UPDATE);
        String channelName = call.getString("channelName");
        String serverName = call.getString("serverName");
        if (channelName != null) {
            intent.putExtra(VoiceCallService.EXTRA_CHANNEL_NAME, channelName);
        }
        if (serverName != null) {
            intent.putExtra(VoiceCallService.EXTRA_SERVER_NAME, serverName);
        }
        if (call.getData().has("muted")) {
            intent.putExtra(VoiceCallService.EXTRA_MUTED, call.getBoolean("muted", false));
        }
        if (call.getData().has("deafened")) {
            intent.putExtra(VoiceCallService.EXTRA_DEAFENED, call.getBoolean("deafened", false));
        }
        try {
            ctx.startService(intent);
        } catch (Exception ignored) {
            // Ignore if service is not running
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        if (ctx != null) {
            Intent intent = new Intent(ctx, VoiceCallService.class);
            intent.setAction(VoiceCallService.ACTION_STOP);
            try {
                ctx.stopService(intent);
            } catch (Exception ignored) {
                // Ignore if already stopped
            }
        }
        call.resolve();
    }
}
