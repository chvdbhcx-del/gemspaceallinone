package app.gemspace.allinone

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Cloud updates on Android: reads the newest GitHub release of chvdbhcx-del/gemspaceallinone, and when
 * its build number is above this app's versionCode offers it. The APK is downloaded with the system
 * DownloadManager and handed to the system installer. Android installs it over this app only when it
 * is signed with the same key (gemspace.jks), so a foreign APK cannot replace Gemspace.
 */
object Updater {
    private const val LATEST = "https://api.github.com/repos/chvdbhcx-del/gemspaceallinone/releases/latest"
    private const val APK_PREFIX = "https://github.com/chvdbhcx-del/gemspaceallinone/releases/download/"
    private const val PREFS = "updates"

    data class Release(val version: String, val build: Int, val apk: String, val notes: String)

    /** Build number of a release tag: "v0.1.N" gives N, the older "v0.1.0-build.N" gives N too. */
    fun buildOf(tag: String): Int? {
        Regex("""^v\d+\.\d+\.\d+-build\.(\d+)$""").find(tag)?.let { return it.groupValues[1].toIntOrNull() }
        Regex("""^v0\.1\.(\d+)$""").find(tag)?.let { return it.groupValues[1].toIntOrNull() }
        return null
    }

    /** The release in GitHub's JSON when it has our APK; null otherwise. */
    fun parse(json: String): Release? {
        val o = JSONObject(json)
        val tag = o.optString("tag_name")
        val build = buildOf(tag) ?: return null
        if (o.optBoolean("prerelease") || o.optBoolean("draft")) return null
        val assets = o.optJSONArray("assets") ?: return null
        for (i in 0 until assets.length()) {
            val a = assets.getJSONObject(i)
            val url = a.optString("browser_download_url")
            if (a.optString("name") == "Gemspace.apk" && url.startsWith(APK_PREFIX)) {
                return Release(tag.removePrefix("v"), build, url, o.optString("body"))
            }
        }
        return null
    }

    /** Looks for a newer release off the main thread; `done` gets it (or null) on the main thread. */
    fun check(activity: Activity, done: (Release?) -> Unit) {
        Thread {
            val found = try {
                val c = URL(LATEST).openConnection() as HttpURLConnection
                c.connectTimeout = 15_000
                c.readTimeout = 15_000
                c.setRequestProperty("Accept", "application/vnd.github+json")
                c.setRequestProperty("User-Agent", "Gemspace-Android")
                try {
                    if (c.responseCode == 200) parse(c.inputStream.bufferedReader().use { it.readText() }) else null
                } finally {
                    c.disconnect()
                }
            } catch (e: Exception) {
                null
            }
            val newer = found?.takeIf { it.build > BuildConfig.VERSION_CODE }
            activity.runOnUiThread { if (!activity.isFinishing) done(newer) }
        }.start()
    }

    /** Automatic check: offers a newer version once (until the next one comes out). */
    fun checkQuietly(activity: Activity) {
        check(activity) { r ->
            if (r == null) return@check
            val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getInt("offered", 0) >= r.build) return@check
            prefs.edit().putInt("offered", r.build).apply()
            offer(activity, r)
        }
    }

    /** Check from the settings: says so when this is the newest version. */
    fun checkNow(activity: Activity) {
        Toast.makeText(activity, "Проверяю обновления…", Toast.LENGTH_SHORT).show()
        check(activity) { r ->
            if (r == null) Toast.makeText(activity, "У вас последняя версия ${BuildConfig.VERSION_NAME}", Toast.LENGTH_LONG).show()
            else offer(activity, r)
        }
    }

    fun offer(activity: Activity, r: Release) {
        AlertDialog.Builder(activity)
            .setTitle("Доступна версия ${r.version}")
            .setMessage("У вас ${BuildConfig.VERSION_NAME}. Gemspace скачает новую версию, и Android предложит её установить. Аккаунты и входы сохранятся.")
            .setPositiveButton("Обновить") { _, _ -> download(activity, r) }
            .setNegativeButton("Позже", null)
            .show()
    }

    private fun download(activity: Activity, r: Release) {
        // Android 8+: the user allows Gemspace to install apps once
        if (!activity.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(activity, "Разрешите Gemspace устанавливать приложения, вернитесь и нажмите «Обновить» ещё раз", Toast.LENGTH_LONG).show()
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            return
        }
        val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val name = "Gemspace-${r.version}.apk"
        activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.resolve(name)?.delete()
        val id = dm.enqueue(
            DownloadManager.Request(Uri.parse(r.apk))
                .setTitle("Gemspace ${r.version}")
                .setDescription("Обновление Gemspace")
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, name)
        )
        Toast.makeText(activity, "Скачиваю Gemspace ${r.version}…", Toast.LENGTH_SHORT).show()
        val app = activity.applicationContext
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return
                app.unregisterReceiver(this)
                val uri = dm.getUriForDownloadedFile(id)
                if (uri == null) {
                    Toast.makeText(app, "Не удалось скачать обновление, попробуйте позже", Toast.LENGTH_LONG).show()
                    return
                }
                val install = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    app.startActivity(install)
                } catch (e: Exception) {
                    Toast.makeText(app, "Откройте скачанный файл Gemspace из уведомления, чтобы установить", Toast.LENGTH_LONG).show()
                }
            }
        }
        ContextCompat.registerReceiver(app, receiver, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED)
    }
}
