package com.algokod.beastmobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * SÜREKLİ BAĞLANTI SERVİSİ — WhatsApp/Telegram gibi: uygulama arka plandayken
 * Android WebView'i (JS + WebSocket) dondurmaz; soket canlı kalır. Sessiz
 * (IMPORTANCE_MIN, ses/vitrin yok) bir ortam ikonuyla ön plan servisi çalışır.
 */
public class KeepService extends Service {

    private static final String CH = "beast_keep";
    private static final int NID = 4712;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CH, "Beast arka plan", NotificationManager.IMPORTANCE_MIN);
                ch.setDescription("Sürekli bağlantı — ses ve başlıklı uyarı yok");
                ch.setShowBadge(false);
                ch.setSound(null, null);
                ch.enableVibration(false);
                nm.createNotificationChannel(ch);
            }
        } catch (Exception ignored) {
            /* kanal kurulamadı — bildirim tipik değeriyle az gürültülü kalır */
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                b = new Notification.Builder(this, CH);
            } else {
                b = new Notification.Builder(this);
            }
            b.setContentTitle("Beast bağlı")
                    .setContentText("Sohbet arka planda çalışıyor")
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setOngoing(true);
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NID, b.build());
            }
        } catch (Exception ignored) {
            /* bildirim gösterilemedi — servis yine çalışır */
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        try { stopForeground(true); } catch (Exception ignored) {}
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
