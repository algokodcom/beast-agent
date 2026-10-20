package com.algokod.beastmobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * SÜREKLİ BAĞLANTI + CANLI MOD SERVİSİ.
 *
 * - Normal mod: dataSync ön plan servisi — WebSocket uygulama arka plandayken
 *   canlı kalır.
 * - Canlı mod: aynı servis microphone FGS tipiyle çalışır; Android 11+ arka
 *   planda mikrofon erişimine izin verir. Ekran kapalıyken JS ses döngüsü
 *   durmasın diye canlı mod boyunca partial wake lock tutulur.
 *
 * Bildirim kanalı IMPORTANCE_MIN değil, canlı modda LOW: Android'in mikrofon
 * ön plan servisi için görünür bildirim beklentisini karşılar; ses/titreşim yok.
 */
public class KeepService extends Service {

    private static final String TAG = "BeastKeep";
    private static final String CH_KEEP = "beast_keep";
    private static final String CH_LIVE = "beast_live";
    private static final int NID = 4712;

    /* JS tarafındaki iki bağımsız niyet: canlı mod ve sürekli bağlantı. */
    public static volatile boolean liveActive = false;
    public static volatile boolean keepWanted = true;

    private PowerManager.WakeLock wakeLock = null;

    /**
     * Tek giriş noktası: servisi canlı/bağlantı moduna göre başlatır veya durdurur.
     * Hem keepAlive hem setLiveMode buradan geçer; iki özellik birbirini ezmez.
     */
    public static void update(Context ctx, boolean live, boolean keep) {
        liveActive = live;
        keepWanted = keep;
        try {
            Intent i = new Intent(ctx, KeepService.class);
            i.putExtra("live", live);
            i.putExtra("keep", keep);
            if (!live && !keep) {
                ctx.stopService(i);
                return;
            }
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Exception e) {
            Log.w(TAG, "update: " + e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Beast:LiveAudio");
                wakeLock.setReferenceCounted(false);
            }
        } catch (Exception e) {
            Log.w(TAG, "wakeLock: " + e);
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            NotificationChannel keep = new NotificationChannel(
                    CH_KEEP, "Beast arka plan", NotificationManager.IMPORTANCE_MIN);
            keep.setDescription("Sürekli bağlantı — ses ve başlıklı uyarı yok");
            keep.setShowBadge(false);
            keep.setSound(null, null);
            keep.enableVibration(false);
            nm.createNotificationChannel(keep);

            NotificationChannel live = new NotificationChannel(
                    CH_LIVE, "Beast canlı mod", NotificationManager.IMPORTANCE_LOW);
            live.setDescription("Canlı mod açıkken mikrofon arka planda çalışır");
            live.setShowBadge(false);
            live.setSound(null, null);
            live.enableVibration(false);
            nm.createNotificationChannel(live);
        } catch (Exception e) {
            Log.w(TAG, "channels: " + e);
        }
    }

    private Notification buildNotification() {
        String ch = liveActive ? CH_LIVE : CH_KEEP;
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, ch);
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle(liveActive ? "Beast canlı mod" : "Beast bağlı")
                .setContentText(liveActive
                        ? "Mikrofon dinliyor — arka planda çalışıyor"
                        : "Sohbet arka planda çalışıyor")
                .setSmallIcon(liveActive
                        ? android.R.drawable.ic_btn_speak_now
                        : android.R.drawable.stat_notify_chat)
                .setOngoing(true)
                .setOnlyAlertOnce(true);
        if (Build.VERSION.SDK_INT >= 21) b.setShowWhen(false);
        try {
            Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (open != null) {
                open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent pi = PendingIntent.getActivity(
                        this, 0, open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );
                b.setContentIntent(pi);
            }
        } catch (Exception ignored) {
            /* bildirime tıklama bağlanamazsa servis yine çalışır */
        }
        return b.build();
    }

    private void applyForeground() {
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
        if (liveActive && Build.VERSION.SDK_INT >= 30) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NID, buildNotification(), type);
            } else {
                startForeground(NID, buildNotification());
            }
        } catch (Exception e) {
            Log.w(TAG, "startForeground(" + type + "): " + e);
            /* Mikrofon tipi reddedilirse bağlantı servisi yine ayakta kalsın. */
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(NID, buildNotification(),
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                } else {
                    startForeground(NID, buildNotification());
                }
            } catch (Exception e2) {
                Log.w(TAG, "startForeground fallback: " + e2);
            }
        }
        if (liveActive) acquireWakeLock();
        else releaseWakeLock();
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        } catch (Exception e) {
            Log.w(TAG, "acquireWakeLock: " + e);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception e) {
            Log.w(TAG, "releaseWakeLock: " + e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            liveActive = intent.getBooleanExtra("live", liveActive);
            keepWanted = intent.getBooleanExtra("keep", keepWanted);
        }
        if (!liveActive && !keepWanted) {
            stopSelf();
            return START_NOT_STICKY;
        }
        applyForeground();
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        /* Kullanıcı uygulamayı görevden sildiyse canlı mikrofon arkada kalmasın. */
        liveActive = false;
        keepWanted = false;
        releaseWakeLock();
        try { stopForeground(true); } catch (Exception ignored) {}
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        try { stopForeground(true); } catch (Exception ignored) {}
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
