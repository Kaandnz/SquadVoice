package com.squadvoice.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Native Android Foreground Service that keeps SquadVoice WebRTC voice calls alive
 * when the screen is locked or the user switches to another app/game, and displays
 * a Spotify-style MediaStyle player card in Quick Settings & on the Lock Screen.
 */
public class VoiceCallService extends Service {
    public static final String ACTION_START = "com.squadvoice.app.action.VOICE_START";
    public static final String ACTION_UPDATE = "com.squadvoice.app.action.VOICE_UPDATE";
    public static final String ACTION_REFRESH = "com.squadvoice.app.action.VOICE_REFRESH";
    public static final String ACTION_STOP = "com.squadvoice.app.action.VOICE_STOP";
    public static final String ACTION_TOGGLE_MUTE = "com.squadvoice.app.action.VOICE_TOGGLE_MUTE";
    public static final String ACTION_TOGGLE_DEAFEN = "com.squadvoice.app.action.VOICE_TOGGLE_DEAFEN";
    public static final String ACTION_HANGUP = "com.squadvoice.app.action.VOICE_HANGUP";

    private static final String CUSTOM_ACTION_MUTE = "com.squadvoice.app.media.TOGGLE_MUTE";
    private static final String CUSTOM_ACTION_DEAFEN = "com.squadvoice.app.media.TOGGLE_DEAFEN";
    private static final String CUSTOM_ACTION_HANGUP = "com.squadvoice.app.media.HANGUP";

    public static final String EXTRA_CHANNEL_NAME = "channelName";
    public static final String EXTRA_SERVER_NAME = "serverName";
    public static final String EXTRA_MUTED = "muted";
    public static final String EXTRA_DEAFENED = "deafened";

    // New channel ID so existing installs upgrade from the old IMPORTANCE_LOW silent channel
    // to an IMPORTANCE_DEFAULT (soundless) lock-screen & Quick Settings media channel.
    private static final String CHANNEL_ID = "squadvoice_media_call_v2";
    private static final int NOTIFICATION_ID = 4201;

    private static volatile boolean callActive = false;

    private String channelName = "Ses Kanalı";
    private String serverName = "SquadVoice";
    private boolean muted = false;
    private boolean deafened = false;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private MediaSession mediaSession;
    private Bitmap appIconBitmap;
    private boolean foregroundStarted = false;

    public static boolean isCallActive() {
        return callActive;
    }

    public static void refreshNotification(Context context) {
        if (!callActive || context == null) {
            return;
        }
        Intent intent = new Intent(context, VoiceCallService.class);
        intent.setAction(ACTION_REFRESH);
        try {
            context.startService(intent);
        } catch (Exception ignored) {
            // Ignore if background service start is restricted
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        appIconBitmap = loadAppIconBitmap();
        initMediaSession();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopForegroundAndSelf();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopForegroundAndSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_TOGGLE_MUTE.equals(action)) {
            VoiceCallPlugin.dispatchNotificationAction("toggleMute");
            return START_STICKY;
        }

        if (ACTION_TOGGLE_DEAFEN.equals(action)) {
            VoiceCallPlugin.dispatchNotificationAction("toggleDeafen");
            return START_STICKY;
        }

        if (ACTION_HANGUP.equals(action)) {
            VoiceCallPlugin.dispatchNotificationAction("hangup");
            stopForegroundAndSelf();
            return START_NOT_STICKY;
        }

        if (!ACTION_REFRESH.equals(action)) {
            String nextChannel = intent.getStringExtra(EXTRA_CHANNEL_NAME);
            String nextServer = intent.getStringExtra(EXTRA_SERVER_NAME);
            if (nextChannel != null && !nextChannel.isEmpty()) {
                channelName = nextChannel;
            }
            if (nextServer != null && !nextServer.isEmpty()) {
                serverName = nextServer;
            }
            if (intent.hasExtra(EXTRA_MUTED)) {
                muted = intent.getBooleanExtra(EXTRA_MUTED, muted);
            }
            if (intent.hasExtra(EXTRA_DEAFENED)) {
                deafened = intent.getBooleanExtra(EXTRA_DEAFENED, deafened);
            }
        }

        callActive = true;
        updateMediaSessionState();
        Notification notification = buildNotification();

        if (ACTION_START.equals(action) || !foregroundStarted) {
            startForegroundSafely(notification);
            acquireCpuAndWifiLocks();
            foregroundStarted = true;
        } else {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIFICATION_ID, notification);
            }
        }

        return START_STICKY;
    }

    private void initMediaSession() {
        mediaSession = new MediaSession(this, "SquadVoiceCallSession");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                // Tapping Play/Pause on the Spotify-style Quick Settings / Lock Screen card
                // toggles microphone mute while keeping the voice call active and connected.
                VoiceCallPlugin.dispatchNotificationAction("toggleMute");
            }

            @Override
            public void onPause() {
                VoiceCallPlugin.dispatchNotificationAction("toggleMute");
            }

            @Override
            public void onStop() {
                VoiceCallPlugin.dispatchNotificationAction("hangup");
                stopForegroundAndSelf();
            }

            @Override
            public void onCustomAction(String action, @Nullable Bundle extras) {
                if (CUSTOM_ACTION_MUTE.equals(action)) {
                    VoiceCallPlugin.dispatchNotificationAction("toggleMute");
                } else if (CUSTOM_ACTION_DEAFEN.equals(action)) {
                    VoiceCallPlugin.dispatchNotificationAction("toggleDeafen");
                } else if (CUSTOM_ACTION_HANGUP.equals(action)) {
                    VoiceCallPlugin.dispatchNotificationAction("hangup");
                    stopForegroundAndSelf();
                }
            }
        });
        mediaSession.setActive(true);
    }

    private void updateMediaSessionState() {
        if (mediaSession == null) {
            return;
        }
        String statusText = deafened
            ? "Kulaklık kapalı"
            : muted
                ? "Mikrofon sessiz"
                : "Sesli sohbet aktif";

        MediaMetadata.Builder metaBuilder = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, channelName)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, serverName + " • " + statusText)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, "SquadVoice")
            .putLong(MediaMetadata.METADATA_KEY_DURATION, -1L);
        if (appIconBitmap != null) {
            metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, appIconBitmap);
            metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, appIconBitmap);
        }
        mediaSession.setMetadata(metaBuilder.build());

        long supportedActions =
            PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_PLAY
                | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_STOP;

        int muteIcon = muted
            ? android.R.drawable.ic_lock_silent_mode_off
            : android.R.drawable.ic_lock_silent_mode;
        String muteLabel = muted ? "Mikrofonu Aç" : "Sustur";

        int deafenIcon = deafened
            ? android.R.drawable.ic_lock_silent_mode_off
            : android.R.drawable.ic_menu_call;
        String deafenLabel = deafened ? "Sesi Aç" : "Sağırlaştır";

        // Keep STATE_PLAYING even while muted so Android 13+ Quick Settings keeps
        // the Spotify-style card pinned and never suspends our background voice call.
        PlaybackState state = new PlaybackState.Builder()
            .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
            .setActions(supportedActions)
            .addCustomAction(
                new PlaybackState.CustomAction.Builder(CUSTOM_ACTION_MUTE, muteLabel, muteIcon).build()
            )
            .addCustomAction(
                new PlaybackState.CustomAction.Builder(CUSTOM_ACTION_DEAFEN, deafenLabel, deafenIcon).build()
            )
            .addCustomAction(
                new PlaybackState.CustomAction.Builder(
                    CUSTOM_ACTION_HANGUP,
                    "Ayrıl",
                    android.R.drawable.ic_menu_close_clear_cancel
                ).build()
            )
            .build();
        mediaSession.setPlaybackState(state);
        mediaSession.setActive(true);
    }

    private void startForegroundSafely(Notification notification) {
        int serviceTypes = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            serviceTypes = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            boolean hasRecordAudio =
                ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED;
            if (hasRecordAudio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                serviceTypes |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceTypes);
    }

    @SuppressWarnings("deprecation")
    private void acquireCpuAndWifiLocks() {
        if (wakeLock == null || !wakeLock.isHeld()) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SquadVoice::VoiceCallWakeLock");
                wakeLock.setReferenceCounted(false);
                // 12-hour safety cap; always explicitly released when leaving voice
                wakeLock.acquire(12L * 60L * 60L * 1000L);
            }
        }

        if (wifiLock == null || !wifiLock.isHeld()) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int lockMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                try {
                    wifiLock = wm.createWifiLock(lockMode, "SquadVoice::VoiceCallWifiLock");
                    wifiLock.setReferenceCounted(false);
                    wifiLock.acquire();
                } catch (Exception ignored) {
                    // Continue with CPU wake lock if device restricts Wi-Fi lock
                }
            }
        }
    }

    private void releaseCpuAndWifiLocks() {
        if (wakeLock != null) {
            try {
                if (wakeLock.isHeld()) {
                    wakeLock.release();
                }
            } catch (Exception ignored) {
                // Ignore double-release
            }
            wakeLock = null;
        }
        if (wifiLock != null) {
            try {
                if (wifiLock.isHeld()) {
                    wifiLock.release();
                }
            } catch (Exception ignored) {
                // Ignore double-release
            }
            wifiLock = null;
        }
    }

    private void releaseMediaSession() {
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
                mediaSession.release();
            } catch (Exception ignored) {
                // Ignore cleanup errors
            }
            mediaSession = null;
        }
    }

    @Nullable
    private Bitmap loadAppIconBitmap() {
        try {
            Drawable drawable = ContextCompat.getDrawable(this, R.mipmap.ic_launcher);
            if (drawable == null) {
                return null;
            }
            int size = 192;
            Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            drawable.setBounds(0, 0, size, size);
            drawable.draw(canvas);
            return bitmap;
        } catch (Exception ignored) {
            return null;
        }
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent mutePending = PendingIntent.getService(
            this,
            1,
            new Intent(this, VoiceCallService.class).setAction(ACTION_TOGGLE_MUTE),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent deafenPending = PendingIntent.getService(
            this,
            2,
            new Intent(this, VoiceCallService.class).setAction(ACTION_TOGGLE_DEAFEN),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent hangupPending = PendingIntent.getService(
            this,
            3,
            new Intent(this, VoiceCallService.class).setAction(ACTION_HANGUP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String subtitle = serverName + " • " + (
            deafened
                ? "Kulaklık kapalı"
                : muted
                    ? "Mikrofon sessiz"
                    : "Sesli sohbet aktif"
        );
        int muteIcon = muted
            ? android.R.drawable.ic_lock_silent_mode_off
            : android.R.drawable.ic_lock_silent_mode;
        String muteLabel = muted ? "Mikrofonu Aç" : "Sustur";

        int deafenIcon = deafened
            ? android.R.drawable.ic_lock_silent_mode_off
            : android.R.drawable.ic_menu_call;
        String deafenLabel = deafened ? "Sesi Aç" : "Sağırlaştır";

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && mediaSession != null) {
            Notification.MediaStyle mediaStyle = new Notification.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2);

            Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(channelName)
                .setContentText(subtitle)
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(contentIntent)
                .setStyle(mediaStyle)
                .addAction(
                    new Notification.Action.Builder(
                        Icon.createWithResource(this, muteIcon),
                        muteLabel,
                        mutePending
                    ).build()
                )
                .addAction(
                    new Notification.Action.Builder(
                        Icon.createWithResource(this, deafenIcon),
                        deafenLabel,
                        deafenPending
                    ).build()
                )
                .addAction(
                    new Notification.Action.Builder(
                        Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
                        "Ayrıl",
                        hangupPending
                    ).build()
                );

            if (appIconBitmap != null) {
                builder.setLargeIcon(appIconBitmap);
            }
            return builder.build();
        }

        NotificationCompat.Builder compatBuilder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(channelName)
            .setContentText(subtitle)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(contentIntent)
            .addAction(muteIcon, muteLabel, mutePending)
            .addAction(deafenIcon, deafenLabel, deafenPending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Ayrıl", hangupPending);

        if (appIconBitmap != null) {
            compatBuilder.setLargeIcon(appIconBitmap);
        }
        return compatBuilder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Sesli Sohbet Medya Kontrolü",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("Arka planda sesli sohbet bağlantısını açık tutar ve kilit ekranında kontrol gösterir");
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private void stopForegroundAndSelf() {
        callActive = false;
        foregroundStarted = false;
        releaseCpuAndWifiLocks();
        releaseMediaSession();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopForegroundAndSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        callActive = false;
        foregroundStarted = false;
        releaseCpuAndWifiLocks();
        releaseMediaSession();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
