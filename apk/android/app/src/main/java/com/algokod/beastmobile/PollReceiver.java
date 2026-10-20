package com.algokod.beastmobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * ARKA PLAN YOKLAMASI — uygulama tamamen KAPALIYKEN bile bildirim gelmesi için.
 *
 * AlarmManager ile periyodik olarak uyanır, masaüstündeki /notif ucunu
 * sorar; "since" sonrası yeni mesaj varsa sistem bildirimi basar.
 * (WS bağlantısı kapalı olduğu için bu yol devreye girer.)
 */
public class PollReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        final Context context = ctx.getApplicationContext();
        try {
            final SharedPreferences sp = context.getSharedPreferences("beast_poll", Context.MODE_PRIVATE);
            final String url = sp.getString("url", "");
            final String code = sp.getString("code", "");
            final long since = sp.getLong("since", 0L);
            if (url == null || url.isEmpty()) return;
            new Thread(() -> {
                try {
                    String full = url + "?code=" + URLEncoder.encode(code == null ? "" : code, "UTF-8") + "&since=" + since;
                    HttpURLConnection c = (HttpURLConnection) new URL(full).openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    c.setRequestMethod("GET");
                    String resp = readAll(c.getInputStream());
                    c.disconnect();
                    try {
                        JSONObject o = new JSONObject(resp);
                        long ts = o.optLong("ts", since);
                        sp.edit().putLong("since", ts).apply();
                        /* YENİ MESAJLAR LİSTESİ: since'ten beri kaçırılan HER mesaj
                           ayrı bildirim olarak basılır (nid'ler çakışmaz —
                           birbirini ezmez) — WhatsApp gibi eksiksiz */
                        org.json.JSONArray items = o.optJSONArray("items");
                        if (items != null && items.length() > 0) {
                            for (int i = 0; i < items.length(); i++) {
                                JSONObject it = items.getJSONObject(i);
                                String b = it.optString("body", "");
                                if (b == null || b.isEmpty()) continue;
                                BeastNative.postNotification(
                                    context,
                                    it.optString("title", "Beast"),
                                    b,
                                    it.optInt("nid", 4711 + i)
                                );
                            }
                        } else {
                            String body = o.optString("body", "");
                            if (body != null && !body.isEmpty()) {
                                BeastNative.postNotification(context, o.optString("title", "Beast"), body);
                            }
                        }
                    } catch (Exception ignored) {
                        /* bozuk yanıt — sessizce geç */
                    }
                } catch (Exception ignored) {
                    /* ağ yok / sunucu kapalı — sessizce geç */
                }
                /* sonraki alarmı kur */
                BeastNative.scheduleAlarm(context);
            }).start();
        } catch (Exception ignored) {
            /* yoklama başlatılamadı */
        }
    }

    private static String readAll(InputStream is) throws Exception {
        StringBuilder sb = new StringBuilder();
        BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"));
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        br.close();
        return sb.toString();
    }
}
