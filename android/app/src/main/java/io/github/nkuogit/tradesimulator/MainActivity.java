package io.github.nkuogit.tradesimulator;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** 用 WebView 包住 GitHub Pages 上的網站：行情和新功能都會自動更新，不用重裝 App。 */
public class MainActivity extends Activity {
    private static final String HOME = "https://nkuo-git.github.io/trade-simulator/";
    private static final String LATEST_RELEASE =
            "https://api.github.com/repos/nkuo-git/trade-simulator/releases/latest";
    private static final String APK_URL =
            "https://github.com/nkuo-git/trade-simulator/releases/latest/download/trade-simulator.apk";
    private static final int PICK_FILE = 1;
    private static final int SAVE_FILE = 2;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSave;

    private static final String OFFLINE_HTML =
            "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
            + "<body style='font-family:sans-serif;text-align:center;padding:30vh 24px;background:#f6f7fb;color:#1f2330'>"
            + "<div style='font-size:48px'>📡</div><h2>沒有網路</h2><p>小小操盤手需要網路才能讀取行情。</p>"
            + "<button style='font-size:18px;padding:12px 24px;border:0;border-radius:12px;background:#4f46e5;color:#fff' "
            + "onclick=\"location.href='" + HOME + "'\">重新連線</button></body></html>";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "AndroidApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if (uri.toString().startsWith(HOME)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    view.loadDataWithBaseURL(null, OFFLINE_HTML, "text/html", "utf-8", null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (state != null) web.restoreState(state);
        else {
            web.loadUrl(HOME);
            checkForUpdate();
        }
    }

    /** 打開 App 時看看 Releases 上有沒有比較新的 APK（版號 = 發布編號 android-N）。 */
    private void checkForUpdate() {
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(LATEST_RELEASE).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                if (c.getResponseCode() != 200) return;
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                try (InputStream in = c.getInputStream()) {
                    byte[] b = new byte[8192];
                    for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
                }
                String tag = new JSONObject(buf.toString("UTF-8")).optString("tag_name");
                if (!tag.startsWith("android-")) return;
                long latest = Long.parseLong(tag.substring("android-".length()));
                if (latest > installedVersion()) runOnUiThread(() -> showUpdate(latest));
            } catch (Exception ignored) {
                // 沒網路或 GitHub 連不上就算了，下次打開再檢查
            }
        }).start();
    }

    @SuppressWarnings("deprecation")
    private long installedVersion() throws Exception {
        android.content.pm.PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
        return android.os.Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
    }

    private void showUpdate(long latest) {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setTitle("有新版 App 🎉")
                .setMessage("小小操盤手 1.0." + latest + " 已經推出了。\n\n"
                        + "按「下載更新」會下載新的安裝檔，下載完點開它、按「更新」就好，你的進度不會不見。")
                .setPositiveButton("下載更新", (d, w) -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(APK_URL)));
                    } catch (Exception e) {
                        Toast.makeText(this, "打不開瀏覽器", Toast.LENGTH_SHORT).show();
                    }
                })
                .setNegativeButton("下次再說", null)
                .show();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // 讓網頁先處理（關掉視窗、回上一頁），網頁說沒得退了才離開 App
        web.evaluateJavascript("window.appBack ? window.appBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
        } else if (requestCode == SAVE_FILE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingSave != null) {
                try (OutputStream os = getContentResolver().openOutputStream(data.getData())) {
                    os.write(pendingSave.getBytes(StandardCharsets.UTF_8));
                    Toast.makeText(this, "已儲存備份", Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(this, "儲存失敗", Toast.LENGTH_SHORT).show();
                }
            }
            pendingSave = null;
        }
    }

    /** 給網頁呼叫：匯出進度時用系統的「另存新檔」。 */
    private class Bridge {
        @JavascriptInterface
        public void saveFile(String name, String content) {
            runOnUiThread(() -> {
                pendingSave = content;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/json");
                i.putExtra(Intent.EXTRA_TITLE, name);
                startActivityForResult(i, SAVE_FILE);
            });
        }
    }
}
