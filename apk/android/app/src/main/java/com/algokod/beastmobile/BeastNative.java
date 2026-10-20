package com.algokod.beastmobile;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * BEAST NATIVE - mobil uygulamanin Android tarafi yardimcilari.
 *  - mikrofon (sesli mesaj) izni
 *  - gelen mesaj bildirimi (sistem bildirimi + titreşim)
 *  - ajanin gonderdigi dosyayi telefona KAYDETME ve AÇMA
 */
@CapacitorPlugin(
    name = "BeastNative",
    permissions = {
        @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notify", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class BeastNative extends Plugin {

    private static final String CHANNEL_ID = "beast_messages";
    private static final int NOTIF_ID = 4711;

    /* UYGULAMA ÖN PLANDA MI? MainActivity.onResume/onPause günceller.
       Ön plandayken HİÇBİR sistem bildirimi basılmaz (ne JS ne alarm yolu);
       arka planda/uygulama kapalıyken bildirimler normal çalışır. */
    public static volatile boolean appVisible = false;

    /* ---------------- izinler ---------------- */

    @PluginMethod
    public void requestMic(PluginCall call) {
        requestPermissionForAlias("mic", call, "micCallback");
    }

    @PermissionCallback
    private void micCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("mic") == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void requestNotify(PluginCall call) {
        /* Android 13 altinda bildirim izni gerekmez */
        if (Build.VERSION.SDK_INT < 33) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("notify", call, "notifyCallback");
    }

    @PermissionCallback
    private void notifyCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("notify") == PermissionState.GRANTED);
        call.resolve(r);
    }

    /* ---------------- bildirim ---------------- */

    /* Sistem bildirimi (statik: plugin ve alarm alıcısı aynı yolu kullanır) */
    public static void postNotification(Context ctx, String title, String body) {
        postNotification(ctx, title, body, NOTIF_ID);
    }

    public static void postNotification(Context ctx, String title, String body, int id) {
        try {
            if (appVisible) return; /* uygulama içindeyken bildirim YOK */
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Beast mesajlari", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Ajan ve kullanici mesajlari");
                ch.enableVibration(true);
                nm.createNotificationChannel(ch);
                b = new Notification.Builder(ctx, CHANNEL_ID);
            } else {
                b = new Notification.Builder(ctx);
            }
            b.setContentTitle(title == null ? "Beast" : title)
                    .setContentText(body == null ? "" : body)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setAutoCancel(true);
            if (Build.VERSION.SDK_INT >= 21) {
                b.setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body));
            }
            Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            if (open != null) {
                open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent pi = PendingIntent.getActivity(
                        ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );
                b.setContentIntent(pi);
            }
            nm.notify(id <= 0 ? NOTIF_ID : id, b.build());
        } catch (Exception ignored) {
            /* bildirim gönderilemezse sessizce geç */
        }
    }

    @PluginMethod
    public void notify(PluginCall call) {
        String title = call.getString("title", "Beast");
        String body = call.getString("body", "");
        try {
            postNotification(getContext(), title, body);
            doVibrate(120);
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", String.valueOf(e.getMessage())));
        }
    }

    /* ---------------- ARKA PLAN YOKLAMASI (uygulama kapalıyken bildirim) ---------------- */

    private static final String PREF = "beast_poll";
    private static final int POLL_REQ = 991;

    public static void scheduleAlarm(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
            String url = sp.getString("url", "");
            if (url == null || url.isEmpty()) return;
            long every = sp.getLong("every", 60000L);
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(ctx, PollReceiver.class);
            PendingIntent pi = PendingIntent.getBroadcast(
                    ctx, POLL_REQ, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            long at = System.currentTimeMillis() + every;
            try {
                if (Build.VERSION.SDK_INT >= 23) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
                }
            } catch (SecurityException se) {
                /* exact alarm izni yoksa yaklaşık alarm */
                am.setInexactRepeating(AlarmManager.RTC_WAKEUP, at, every, pi);
            }
        } catch (Exception ignored) {
            /* alarm kurulamazsa uygulama içi bildirim devrede */
        }
    }

    @PluginMethod
    public void setPoll(PluginCall call) {
        try {
            String url = call.getString("url", "");
            String code = call.getString("code", "");
            long everySec = call.getInt("everySec", 60);
            SharedPreferences sp = getContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
            sp.edit()
                    .putString("url", url)
                    .putString("code", code)
                    .putLong("every", Math.max(15L, everySec) * 1000L)
                    .apply();
            scheduleAlarm(getContext());
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", String.valueOf(e.getMessage())));
        }
    }

    @PluginMethod
    public void clearPoll(PluginCall call) {
        try {
            SharedPreferences sp = getContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
            sp.edit().remove("url").remove("code").apply();
            AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                Intent i = new Intent(getContext(), PollReceiver.class);
                PendingIntent pi = PendingIntent.getBroadcast(
                        getContext(), POLL_REQ, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );
                am.cancel(pi);
            }
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false));
        }
    }

    /* ---------------- titreşim ---------------- */

    @PluginMethod
    public void vibrate(PluginCall call) {
        int ms = call.getInt("ms", 120);
        try {
            doVibrate(ms);
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false));
        }
    }

    private void doVibrate(int ms) {
        try {
            Vibrator v = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(ms);
                }
            }
        } catch (Exception ignored) {
            /* titreşim yoksa sorun değil */
        }
    }

    /* ---------------- SÜREKLİ BAĞLANTI (ön plan servisi) ---------------- */

    /* WhatsApp gibi: uygulama arka plandayken WebSocket düşmesin —
       sessiz ortam ikonlu ön plan servisi bağlantıyı canlı tutar */
    @PluginMethod
    public void keepAlive(PluginCall call) {
        boolean on = call.getBoolean("on", Boolean.TRUE);
        try {
            Intent i = new Intent(getContext(), KeepService.class);
            if (on) {
                if (Build.VERSION.SDK_INT >= 26) {
                    getContext().startForegroundService(i);
                } else {
                    getContext().startService(i);
                }
            } else {
                getContext().stopService(i);
            }
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", String.valueOf(e.getMessage())));
        }
    }

    /* ---------------- YEREL SES KAYDI (WebView mikrotu rezervi) ---------------- */
    /* 'mikrofona erişilemiyor' hatası WebView izninden gelirse ANDROID KENDİ
       kaydına girer: MediaRecorder (AAC/m4a) — izin seçilmez sonuç dataUrl döner */

    private MediaRecorder rec = null;
    private String recPath = null;
    private long recTs = 0;

    @PluginMethod
    public void startRec(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "micRecCallback");
            return;
        }
        startRecNow(call);
    }

    @PermissionCallback
    private void micRecCallback(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            call.resolve(new JSObject().put("ok", false).put("error", "mikrofon izni yok"));
            return;
        }
        startRecNow(call);
    }

    @SuppressWarnings("deprecation")
    private void startRecNow(PluginCall call) {
        try {
            if (rec != null) {
                call.resolve(new JSObject().put("ok", false).put("error", "zaten kayıt açık"));
                return;
            }
            int maxSec = Math.max(10, Math.min(300, call.getInt("maxSec", 120)));
            File dir = new File(getContext().getCacheDir(), "beastrec");
            if (!dir.exists()) dir.mkdirs();
            final File f = new File(dir, "kayit_" + System.currentTimeMillis() + ".m4a");
            MediaRecorder m = new MediaRecorder();
            m.setAudioSource(MediaRecorder.AudioSource.MIC);
            m.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            m.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            m.setAudioSamplingRate(44100);
            m.setAudioEncodingBitRate(64000);
            m.setAudioChannels(1);
            m.setMaxDuration(maxSec * 1000);
            m.setOutputFile(f.getAbsolutePath());
            m.prepare();
            m.start();
            rec = m;
            recPath = f.getAbsolutePath();
            recTs = System.currentTimeMillis();
            call.resolve(new JSObject().put("ok", true).put("path", recPath));
        } catch (Exception e) {
            rec = null;
            recPath = null;
            call.resolve(new JSObject().put("ok", false).put("error", String.valueOf(e.getMessage())));
        }
    }

    @PluginMethod
    public void stopRec(PluginCall call) {
        try {
            if (rec == null || recPath == null) {
                call.resolve(new JSObject().put("ok", false).put("error", "kayıt yok"));
                return;
            }
            try { rec.stop(); } catch (Exception ignored) { /* kısa kayıtta stop hata verebilir */ }
            try { rec.release(); } catch (Exception ignored) {}
            rec = null;
            File f = new File(recPath);
            if (!f.exists() || f.length() < 256) {
                try { f.delete(); } catch (Exception ignored) {}
                recPath = null;
                call.resolve(new JSObject().put("ok", false).put("error", "kayıt boş"));
                return;
            }
            byte[] bytes = readFileBytes(f);
            String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
            long dur = Math.max(1, (System.currentTimeMillis() - recTs) / 1000);
            try { f.delete(); } catch (Exception ignored) {}
            recPath = null;
            JSObject r = new JSObject();
            r.put("ok", true);
            r.put("mime", "audio/mp4");
            r.put("duration", dur);
            r.put("size", bytes.length);
            r.put("dataUrl", "data:audio/mp4;base64," + b64);
            call.resolve(r);
        } catch (Exception e) {
            rec = null;
            recPath = null;
            call.resolve(new JSObject().put("ok", false).put("error", String.valueOf(e.getMessage())));
        }
    }

    @PluginMethod
    public void cancelRec(PluginCall call) {
        try {
            if (rec != null) {
                try { rec.stop(); } catch (Exception ignored) {}
                try { rec.release(); } catch (Exception ignored) {}
                rec = null;
            }
            if (recPath != null) {
                try { new File(recPath).delete(); } catch (Exception ignored) {}
                recPath = null;
            }
        } catch (Exception ignored) {
        }
        recPath = null;
        call.resolve(new JSObject().put("ok", true));
    }

    private static byte[] readFileBytes(File f) throws Exception {
        java.io.FileInputStream is = new java.io.FileInputStream(f);
        try {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            try { is.close(); } catch (Exception ignored) {}
        }
    }

    /* ---------------- AYARLARI AÇ (izin rehberi) ---------------- */

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", getContext().getPackageName(), null));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", String.valueOf(e.getMessage())));
        }
    }

    /* ---------------- dosya kaydet (Downloads) ---------------- */

    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name", "dosya");
        String b64 = call.getString("base64", "");
        String mime = call.getString("mime", "application/octet-stream");
        try {
            if (b64 == null || b64.isEmpty()) {
                call.resolve(new JSObject().put("ok", false).put("error", "veri yok"));
                return;
            }
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            if (safe.length() > 80) safe = safe.substring(safe.length() - 80);
            Uri outUri = null;
            String savedPath = "";

            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                cv.put(MediaStore.Downloads.IS_PENDING, 1);
                ContentResolver cr = getContext().getContentResolver();
                outUri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (outUri == null) {
                    call.resolve(new JSObject().put("ok", false).put("error", "kaydedilemedi"));
                    return;
                }
                OutputStream os = cr.openOutputStream(outUri);
                if (os == null) {
                    cr.delete(outUri, null, null);
                    call.resolve(new JSObject().put("ok", false).put("error", "kaydedilemedi"));
                    return;
                }
                os.write(bytes);
                os.flush();
                os.close();
                cv.clear();
                cv.put(MediaStore.Downloads.IS_PENDING, 0);
                cr.update(outUri, cv, null, null);
                savedPath = "Downloads/" + safe;
            } else {
                File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = new File(getContext().getFilesDir(), "downloads");
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, safe);
                FileOutputStream fos = new FileOutputStream(f);
                fos.write(bytes);
                fos.flush();
                fos.close();
                outUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
                savedPath = f.getAbsolutePath();
            }
            JSObject r = new JSObject();
            r.put("ok", true);
            r.put("name", safe);
            r.put("path", savedPath);
            r.put("uri", outUri != null ? outUri.toString() : "");
            call.resolve(r);
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", String.valueOf(e.getMessage())));
        }
    }

    /* ---------------- dosya aç ---------------- */

    @PluginMethod
    public void openFile(PluginCall call) {
        String path = call.getString("path", "");
        String uriStr = call.getString("uri", "");
        try {
            Uri uri = null;
            if (uriStr != null && uriStr.startsWith("content://")) {
                uri = Uri.parse(uriStr);
            } else if (path != null && !path.isEmpty()) {
                File f = new File(path);
                if (!f.exists()) {
                    call.resolve(new JSObject().put("ok", false).put("error", "dosya yok"));
                    return;
                }
                uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            }
            if (uri == null) {
                call.resolve(new JSObject().put("ok", false).put("error", "dosya yok"));
                return;
            }
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, guessMime(path));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.resolve(new JSObject().put("ok", false).put("error", String.valueOf(e.getMessage())));
        }
    }

    private static String guessMime(String path) {
        String p = (path == null ? "" : path).toLowerCase();
        if (p.endsWith(".pdf")) return "application/pdf";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".txt") || p.endsWith(".md")) return "text/plain";
        if (p.endsWith(".doc")) return "application/msword";
        if (p.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (p.endsWith(".xls")) return "application/vnd.ms-excel";
        if (p.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".m4a")) return "audio/mp4";
        if (p.endsWith(".webm")) return "audio/webm";
        if (p.endsWith(".mp4")) return "video/mp4";
        if (p.endsWith(".zip")) return "application/zip";
        return "application/octet-stream";
    }
}
