package com.squadvoice.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;

@CapacitorPlugin(name = "ScreenShare")
public class ScreenSharePlugin extends Plugin {
    private static WeakReference<ScreenSharePlugin> activeInstance = new WeakReference<>(null);
    private int pendingMaxDimension = 960;
    private int pendingFps = 18;
    private int pendingQuality = 68;

    @Override
    public void load() {
        activeInstance = new WeakReference<>(this);
    }

    public static void dispatchStarted(int width, int height) {
        ScreenSharePlugin instance = activeInstance.get();
        if (instance == null) return;
        JSObject payload = new JSObject();
        payload.put("width", width);
        payload.put("height", height);
        instance.notifyListeners("started", payload);
    }

    public static void dispatchFrame(String base64Jpeg, int width, int height) {
        ScreenSharePlugin instance = activeInstance.get();
        if (instance == null) return;
        JSObject payload = new JSObject();
        payload.put("data", base64Jpeg);
        payload.put("width", width);
        payload.put("height", height);
        instance.notifyListeners("frame", payload);
    }

    public static void dispatchStopped() {
        ScreenSharePlugin instance = activeInstance.get();
        if (instance == null) return;
        instance.notifyListeners("stopped", new JSObject());
    }

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Android bağlamı hazır değil.");
            return;
        }
        MediaProjectionManager mpm =
            (MediaProjectionManager) ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("Bu cihaz ekran paylaşımını desteklemiyor.");
            return;
        }

        pendingMaxDimension = call.getInt("maxDimension", 960);
        pendingFps = call.getInt("fps", 18);
        pendingQuality = call.getInt("quality", 68);

        Intent captureIntent = mpm.createScreenCaptureIntent();
        startActivityForResult(call, captureIntent, "handleScreenCaptureResult");
    }

    @ActivityCallback
    private void handleScreenCaptureResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Ekran paylaşımı iptal edildi.");
            return;
        }

        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Android bağlamı hazır değil.");
            return;
        }

        Intent serviceIntent = new Intent(ctx, ScreenShareService.class);
        serviceIntent.setAction(ScreenShareService.ACTION_START);
        serviceIntent.putExtra(ScreenShareService.EXTRA_RESULT_CODE, result.getResultCode());
        serviceIntent.putExtra(ScreenShareService.EXTRA_RESULT_DATA, result.getData());
        serviceIntent.putExtra(ScreenShareService.EXTRA_MAX_DIMENSION, pendingMaxDimension);
        serviceIntent.putExtra(ScreenShareService.EXTRA_FPS, pendingFps);
        serviceIntent.putExtra(ScreenShareService.EXTRA_QUALITY, pendingQuality);

        try {
            ContextCompat.startForegroundService(ctx, serviceIntent);
            JSObject out = new JSObject();
            out.put("started", true);
            call.resolve(out);
        } catch (Exception ex) {
            call.reject("Ekran paylaşımı servisi başlatılamadı: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        if (ctx != null) {
            Intent stopIntent = new Intent(ctx, ScreenShareService.class);
            stopIntent.setAction(ScreenShareService.ACTION_STOP);
            try {
                ctx.stopService(stopIntent);
            } catch (Exception ignored) {
                // Ignore if already stopped
            }
        }
        call.resolve();
    }
}
