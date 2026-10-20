package com.algokod.beastmobile;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /* Beast Native: mikrofon izni, bildirim, dosya kaydet/aç */
        registerPlugin(BeastNative.class);
        super.onCreate(savedInstanceState);

        /* BİLDİRİM KURALI: uygulama ön plandayken sistem bildirimi basılmaz;
           arka planda/uygulama kapalıyken basılır. BridgeActivity'nin
           onResume/onPause metotları final olduğu için lifecycle callbacks
           ile dinliyoruz. */
        try {
            getApplication().registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
                @Override
                public void onActivityResumed(Activity activity) {
                    if (activity instanceof MainActivity) BeastNative.appVisible = true;
                }

                @Override
                public void onActivityPaused(Activity activity) {
                    if (activity instanceof MainActivity) BeastNative.appVisible = false;
                }

                @Override public void onActivityCreated(Activity activity, Bundle b) {}
                @Override public void onActivityStarted(Activity activity) {}
                @Override public void onActivityStopped(Activity activity) {}
                @Override public void onActivitySaveInstanceState(Activity activity, Bundle b) {}
                @Override public void onActivityDestroyed(Activity activity) {}
            });
        } catch (Exception ignored) {
            /* lifecycle dinlenemezse bildirimler yine çalışır (JS tarafı da kontrol eder) */
        }
    }
}
