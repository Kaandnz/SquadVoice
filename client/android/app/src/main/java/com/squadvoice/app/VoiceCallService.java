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
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Native Android Foreground Service that keeps SquadVoice WebRTC voice calls alive
 * when the screen is locked or the user switches to another app/game.
 */
public class VoiceCallService extends Service {
    public static final String ACTION_START = "com.squadvoice.app.action.VOICE_START";
    public static final String ACTION_UPDATE = "com.squadvoice.app.action.VOICE_UPDATE";
    public static final String ACTION_STOP = "com.squadvoice.app.action.VOICE_STOP";
    public static final String ACTION_TOGGLE_MUTE = "com.squadvoice.app.action.VOICE_TOGGLE_MUTE";
    public static final String ACTION_HANGUP = "com.squadvoice.app.action.VOICE_HANGUP";

    public static final String EXTRA_CHANNEL_NAME = "channelName";
    public static final String EXTRA_SERVER_NAME = "serverName";
    public static final String EXTRA_MUTED = "muted";

    private static final String CHANNEL_ID = "squadvoice_active_call";
    private static final int NOTIFICATION_ID = 4201;

    private String channelName = "Ses Kanalı";
    private String serverName = "SquadVoice";
    private boolean muted = false;

    private PowerManager.WakeLock wakeLock;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private int previousAudioMode = AudioManager.MODE_NORMAL;
    private boolean audioSessionActive = false;

    @Override
    public void onCreate() {
        super.onCreate();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
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

        if (ACTION_HANGUP.equals(action)) {
            VoiceCallPlugin.dispatchNotificationAction("hangup");
            stopForegroundAndSelf();
            return START_NOT_STICKY;
        }

        String nextChannel = intent.getStringExtra(EXTRA_CHANNEL_NAME);
        String nextServer = intent.getStringExtra(EXTRA_SERVER_NAME);
        if (nextChannel != null && !nextChannel.isEmpty()) {
            channelName = nextChannel;
        }
        if (nextServer != null && !nextServer.isEmpty()) {
            serverName = nextServer;
        }
        muted = intent.getBooleanExtra(EXTRA_MUTED, muted);

        Notification notification = buildNotification();
        if (ACTION_START.equals(action) || !audioSessionActive) {
            startForegroundSafely(notification);
            acquireCpuWakeLock();
            activateVoiceAudioMode();
        } else {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIFICATION_ID, notification);
            }
        }

        return START_STICKY;
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

    private void acquireCpuWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SquadVoice::VoiceCallWakeLock");
            wakeLock.setReferenceCounted(false);
            // 12-hour safety cap; always explicitly released when leaving voice
            wakeLock.acquire(12L * 60L * 60L * 1000L);
        }
    }

    private void releaseCpuWakeLock() {
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
    }

    private void activateVoiceAudioMode() {
        if (audioManager == null || audioSessionActive) {
            return;
        }
        try {
            previousAudioMode = audioManager.getMode();
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(true)
                    .build();
                audioManager.requestAudioFocus(audioFocusRequest);
            }
            audioSessionActive = true;
        } catch (Exception ignored) {
            // Audio routing still functions via WebView defaults
        }
    }

    private void deactivateVoiceAudioMode() {
        if (audioManager == null || !audioSessionActive) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
                audioFocusRequest = null;
            }
            audioManager.setMode(previousAudioMode);
        } catch (Exception ignored) {
            // Ignore restore errors
        }
        audioSessionActive = false;
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

        Intent muteIntent = new Intent(this, VoiceCallService.class);
        muteIntent.setAction(ACTION_TOGGLE_MUTE);
        PendingIntent mutePending = PendingIntent.getService(
            this,
            1,
            muteIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent hangupIntent = new Intent(this, VoiceCallService.class);
        hangupIntent.setAction(ACTION_HANGUP);
        PendingIntent hangupPending = PendingIntent.getService(
            this,
            2,
            hangupIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String subtitle = serverName + " • " + (muted ? "Mikrofon sessiz" : "Ses bağlantısı aktif");

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(channelName)
            .setContentText(subtitle)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(contentIntent)
            .addAction(0, muted ? "Mikrofonu Aç" : "Sustur", mutePending)
            .addAction(0, "Ayrıl", hangupPending)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Sesli Sohbet",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Arka planda sesli sohbet bağlantısını açık tutar");
            channel.setShowBadge(false);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private void stopForegroundAndSelf() {
        releaseCpuWakeLock();
        deactivateVoiceAudioMode();
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
        releaseCpuWakeLock();
        deactivateVoiceAudioMode();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
