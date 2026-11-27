package com.squadvoice.app;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.view.WindowMetrics;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Native Android Foreground Service (mediaProjection) that captures the device screen
 * via MediaProjection + VirtualDisplay + ImageReader on a background thread and pushes
 * throttled JPEG frames into the WebView canvas for WebRTC streaming.
 */
public class ScreenShareService extends Service {
    public static final String ACTION_START = "com.squadvoice.app.action.SCREEN_START";
    public static final String ACTION_STOP = "com.squadvoice.app.action.SCREEN_STOP";

    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";
    public static final String EXTRA_MAX_DIMENSION = "maxDimension";
    public static final String EXTRA_FPS = "fps";
    public static final String EXTRA_QUALITY = "quality";

    private static final String CHANNEL_ID = "squadvoice_screen_share";
    private static final int NOTIFICATION_ID = 4205;

    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private HandlerThread captureThread;
    private Handler captureHandler;

    private int captureWidth = 720;
    private int captureHeight = 1280;
    private int screenDensity = 320;
    private int maxDimension = 960;
    private long minFrameIntervalMs = 55L;
    private int jpegQuality = 68;
    private long lastFrameSentMs = 0L;

    private Bitmap reusableFullBitmap;
    private Bitmap reusableCroppedBitmap;
    private Canvas reusableCropCanvas;
    private final Rect reusableSrcRect = new Rect();
    private final Rect reusableDstRect = new Rect();
    private final ByteArrayOutputStream jpegBuffer = new ByteArrayOutputStream(65536);
    private final AtomicBoolean running = new AtomicBoolean(false);

    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override
        public void onStop() {
            stopCaptureAndSelf(true);
        }

        @Override
        public void onCapturedContentResize(int width, int height) {
            if (!running.get() || width <= 0 || height <= 0) return;
            int[] scaled = computeScaledSize(width, height, maxDimension);
            if (scaled[0] != captureWidth || scaled[1] != captureHeight) {
                reconfigureCaptureSurface(scaled[0], scaled[1]);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopCaptureAndSelf(true);
            return START_NOT_STICKY;
        }

        if (!ACTION_START.equals(intent.getAction())) {
            return START_NOT_STICKY;
        }

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED);
        Intent resultData = getParcelableIntentExtra(intent, EXTRA_RESULT_DATA);
        if (resultCode != Activity.RESULT_OK || resultData == null) {
            stopCaptureAndSelf(true);
            return START_NOT_STICKY;
        }

        maxDimension = Math.max(480, Math.min(1280, intent.getIntExtra(EXTRA_MAX_DIMENSION, 960)));
        int fps = Math.max(5, Math.min(24, intent.getIntExtra(EXTRA_FPS, 18)));
        minFrameIntervalMs = Math.max(40L, 1000L / fps);
        jpegQuality = Math.max(40, Math.min(88, intent.getIntExtra(EXTRA_QUALITY, 68)));

        // Clean any prior capture session before starting a fresh one
        releaseCaptureObjects();

        // Android 14+ requires startForeground(MEDIA_PROJECTION) BEFORE getMediaProjection()
        startForegroundSafely(buildNotification());

        try {
            MediaProjectionManager mpm =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (mpm == null) {
                stopCaptureAndSelf(true);
                return START_NOT_STICKY;
            }

            mediaProjection = mpm.getMediaProjection(resultCode, resultData);
            if (mediaProjection == null) {
                stopCaptureAndSelf(true);
                return START_NOT_STICKY;
            }

            captureThread = new HandlerThread("SquadVoiceScreenCapture");
            captureThread.start();
            captureHandler = new Handler(captureThread.getLooper());

            int[] dims = computeInitialDisplaySize(maxDimension);
            captureWidth = dims[0];
            captureHeight = dims[1];
            screenDensity = dims[2];

            // Android 14+ requires registering MediaProjection.Callback BEFORE createVirtualDisplay
            mediaProjection.registerCallback(projectionCallback, captureHandler);
            running.set(true);

            createImageReader(captureWidth, captureHeight);
            virtualDisplay = mediaProjection.createVirtualDisplay(
                "SquadVoiceScreen",
                captureWidth,
                captureHeight,
                screenDensity,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                captureHandler
            );

            ScreenSharePlugin.dispatchStarted(captureWidth, captureHeight);
        } catch (Exception ex) {
            stopCaptureAndSelf(true);
        }

        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    private static Intent getParcelableIntentExtra(Intent intent, String key) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(key, Intent.class);
        }
        return intent.getParcelableExtra(key);
    }

    private void startForegroundSafely(Notification notification) {
        int serviceType = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            serviceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceType);
    }

    private int[] computeInitialDisplaySize(int maxDim) {
        int rawW = 1080;
        int rawH = 1920;
        int dpi = 320;
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        DisplayMetrics dm = getResources().getDisplayMetrics();
        if (dm != null) {
            rawW = dm.widthPixels;
            rawH = dm.heightPixels;
            dpi = dm.densityDpi;
        }
        if (wm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowMetrics metrics = wm.getCurrentWindowMetrics();
            Rect bounds = metrics.getBounds();
            if (bounds.width() > 0 && bounds.height() > 0) {
                rawW = bounds.width();
                rawH = bounds.height();
            }
        }
        int[] scaled = computeScaledSize(rawW, rawH, maxDim);
        return new int[] { scaled[0], scaled[1], Math.max(120, dpi) };
    }

    private static int[] computeScaledSize(int rawW, int rawH, int maxDim) {
        int longest = Math.max(rawW, rawH);
        float scale = longest > maxDim ? ((float) maxDim / (float) longest) : 1.0f;
        int w = Math.max(160, Math.round(rawW * scale)) & ~1;
        int h = Math.max(160, Math.round(rawH * scale)) & ~1;
        return new int[] { w, h };
    }

    private void createImageReader(int width, int height) {
        if (imageReader != null) {
            try {
                imageReader.setOnImageAvailableListener(null, null);
                imageReader.close();
            } catch (Exception ignored) {
                // Ignore
            }
        }
        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        imageReader.setOnImageAvailableListener(this::handleImageAvailable, captureHandler);
    }

    private void reconfigureCaptureSurface(int newW, int newH) {
        if (!running.get() || virtualDisplay == null) return;
        try {
            captureWidth = newW;
            captureHeight = newH;
            recycleBitmaps();
            createImageReader(newW, newH);
            virtualDisplay.resize(newW, newH, screenDensity);
            virtualDisplay.setSurface(imageReader.getSurface());
        } catch (Exception ignored) {
            // Keep existing surface if resize fails transiently
        }
    }

    private void handleImageAvailable(ImageReader reader) {
        if (!running.get()) {
            Image stale = reader.acquireLatestImage();
            if (stale != null) stale.close();
            return;
        }

        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) return;

            long now = SystemClock.elapsedRealtime();
            if (now - lastFrameSentMs < minFrameIntervalMs) {
                return;
            }
            lastFrameSentMs = now;

            Image.Plane[] planes = image.getPlanes();
            if (planes == null || planes.length == 0) return;

            int width = image.getWidth();
            int height = image.getHeight();
            ByteBuffer buffer = planes[0].getBuffer();
            int pixelStride = planes[0].getPixelStride();
            int rowStride = planes[0].getRowStride();
            if (pixelStride <= 0 || width <= 0 || height <= 0) return;

            int rowPadding = rowStride - pixelStride * width;
            int bitmapWidth = width + (rowPadding / pixelStride);

            if (
                reusableFullBitmap == null ||
                reusableFullBitmap.getWidth() != bitmapWidth ||
                reusableFullBitmap.getHeight() != height
            ) {
                if (reusableFullBitmap != null) reusableFullBitmap.recycle();
                reusableFullBitmap = Bitmap.createBitmap(bitmapWidth, height, Bitmap.Config.ARGB_8888);
            }
            reusableFullBitmap.copyPixelsFromBuffer(buffer);

            Bitmap toEncode;
            if (bitmapWidth == width) {
                toEncode = reusableFullBitmap;
            } else {
                if (
                    reusableCroppedBitmap == null ||
                    reusableCroppedBitmap.getWidth() != width ||
                    reusableCroppedBitmap.getHeight() != height
                ) {
                    if (reusableCroppedBitmap != null) reusableCroppedBitmap.recycle();
                    reusableCroppedBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                    reusableCropCanvas = new Canvas(reusableCroppedBitmap);
                }
                reusableSrcRect.set(0, 0, width, height);
                reusableDstRect.set(0, 0, width, height);
                reusableCropCanvas.drawBitmap(reusableFullBitmap, reusableSrcRect, reusableDstRect, null);
                toEncode = reusableCroppedBitmap;
            }

            jpegBuffer.reset();
            toEncode.compress(Bitmap.CompressFormat.JPEG, jpegQuality, jpegBuffer);
            String base64 = Base64.encodeToString(jpegBuffer.toByteArray(), Base64.NO_WRAP);
            ScreenSharePlugin.dispatchFrame(base64, width, height);
        } catch (Exception ignored) {
            // Skip malformed/transient frames without crashing capture loop
        } finally {
            if (image != null) {
                try {
                    image.close();
                } catch (Exception ignored) {
                    // Ignore
                }
            }
        }
    }

    private void recycleBitmaps() {
        if (reusableFullBitmap != null) {
            reusableFullBitmap.recycle();
            reusableFullBitmap = null;
        }
        if (reusableCroppedBitmap != null) {
            reusableCroppedBitmap.recycle();
            reusableCroppedBitmap = null;
        }
        reusableCropCanvas = null;
    }

    private void releaseCaptureObjects() {
        running.set(false);
        if (virtualDisplay != null) {
            try {
                virtualDisplay.release();
            } catch (Exception ignored) {
                // Ignore
            }
            virtualDisplay = null;
        }
        if (imageReader != null) {
            try {
                imageReader.setOnImageAvailableListener(null, null);
                imageReader.close();
            } catch (Exception ignored) {
                // Ignore
            }
            imageReader = null;
        }
        if (mediaProjection != null) {
            try {
                mediaProjection.unregisterCallback(projectionCallback);
                mediaProjection.stop();
            } catch (Exception ignored) {
                // Ignore
            }
            mediaProjection = null;
        }
        if (captureThread != null) {
            try {
                captureThread.quitSafely();
            } catch (Exception ignored) {
                // Ignore
            }
            captureThread = null;
            captureHandler = null;
        }
        recycleBitmaps();
    }

    private void stopCaptureAndSelf(boolean notifyJs) {
        boolean wasRunning = running.getAndSet(false);
        releaseCaptureObjects();
        if (notifyJs && wasRunning) {
            ScreenSharePlugin.dispatchStopped();
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            10,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, ScreenShareService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
            this,
            11,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Ekran Paylaşımı Aktif")
            .setContentText("SquadVoice odasında ekranın paylaşılıyor")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(contentIntent)
            .addAction(0, "Paylaşımı Durdur", stopPending)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Ekran Paylaşımı",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("SquadVoice ekran paylaşımı sırasında gösterilir");
            channel.setShowBadge(false);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopCaptureAndSelf(true);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseCaptureObjects();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
