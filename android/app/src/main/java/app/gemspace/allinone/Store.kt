package app.gemspace.allinone

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class Account(
    val id: String,
    var name: String,
    var color: Int,
    var pinned: Boolean = false,
)

data class Settings(
    var notifications: Boolean = true,
    var notifyPreview: Boolean = true,
    var keepAlive: Boolean = true,
    var sleepEnabled: Boolean = true,
    var maxAwake: Int = 4,
    /** Gem Space text size in percent (WebView textZoom), 80..150 */
    var uiScale: Int = 100,
    /** broadcasts (рассылка): messages one account may send in a day, random pause in seconds, warning read */
    var bcLimit: Int = 50,
    var bcPauseMin: Int = 25,
    var bcPauseMax: Int = 70,
    var bcWarned: Boolean = false,
) {
    fun clampBroadcast() {
        bcLimit = bcLimit.coerceIn(1, 300)
        bcPauseMin = bcPauseMin.coerceIn(10, 600)
        bcPauseMax = bcPauseMax.coerceIn(bcPauseMin, 900)
    }
}

/** Accounts and settings, kept as one JSON string in SharedPreferences. */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("gemspace", Context.MODE_PRIVATE)

    val accounts = mutableListOf<Account>()
    var active: String? = null
    val settings = Settings()
    val labels = mutableListOf<Label>()
    /** "<account id>|<chat name>" -> label ids */
    val chatLabels = mutableMapOf<String, MutableList<String>>()
    /** broadcast messages sent today per account (the daily limit); sentDay is "YYYY-MM-DD" */
    var sentDay = ""
    val sent = mutableMapOf<String, Int>()

    init {
        load()
    }

    private fun load() {
        val raw = prefs.getString("state", null) ?: return
        try {
            val o = JSONObject(raw)
            val arr = o.optJSONArray("accounts") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val a = arr.getJSONObject(i)
                accounts += Account(a.getString("id"), a.getString("name"), a.getInt("color"), a.optBoolean("pinned"))
            }
            active = o.optString("active").ifEmpty { null }
            o.optJSONObject("settings")?.let { s ->
                settings.notifications = s.optBoolean("notifications", true)
                settings.notifyPreview = s.optBoolean("notifyPreview", true)
                settings.keepAlive = s.optBoolean("keepAlive", true)
                settings.sleepEnabled = s.optBoolean("sleepEnabled", true)
                settings.maxAwake = s.optInt("maxAwake", 4).coerceIn(1, 30)
                settings.uiScale = s.optInt("uiScale", 100).coerceIn(80, 150)
                settings.bcLimit = s.optInt("bcLimit", 50)
                settings.bcPauseMin = s.optInt("bcPauseMin", 25)
                settings.bcPauseMax = s.optInt("bcPauseMax", 70)
                settings.bcWarned = s.optBoolean("bcWarned", false)
                settings.clampBroadcast()
            }
            sentDay = o.optString("sentDay")
            o.optJSONObject("sent")?.let { m -> m.keys().forEach { k -> sent[k] = m.optInt(k) } }
        } catch (e: Exception) {
            accounts.clear()
        }
        // labels are optional: a broken entry loses the labels, never the accounts
        try {
            val o = JSONObject(raw)
            o.optJSONArray("labels")?.let { ls ->
                for (i in 0 until ls.length()) {
                    val l = ls.getJSONObject(i)
                    labels += Label(l.getString("id"), l.getString("name"), l.getInt("color"))
                }
            }
            o.optJSONObject("chatLabels")?.let { m ->
                m.keys().forEach { k ->
                    val v = m.getJSONArray(k)
                    chatLabels[k] = MutableList(v.length()) { v.getString(it) }
                }
            }
        } catch (e: Exception) {
            labels.clear(); chatLabels.clear()
        }
    }

    fun save() {
        val arr = JSONArray()
        accounts.forEach {
            arr.put(JSONObject().put("id", it.id).put("name", it.name).put("color", it.color).put("pinned", it.pinned))
        }
        val s = JSONObject()
            .put("notifications", settings.notifications)
            .put("notifyPreview", settings.notifyPreview)
            .put("keepAlive", settings.keepAlive)
            .put("sleepEnabled", settings.sleepEnabled)
            .put("maxAwake", settings.maxAwake)
            .put("uiScale", settings.uiScale)
            .put("bcLimit", settings.bcLimit)
            .put("bcPauseMin", settings.bcPauseMin)
            .put("bcPauseMax", settings.bcPauseMax)
            .put("bcWarned", settings.bcWarned)
        val ls = JSONArray()
        labels.forEach { ls.put(JSONObject().put("id", it.id).put("name", it.name).put("color", it.color)) }
        val map = JSONObject()
        chatLabels.forEach { (k, v) -> map.put(k, JSONArray(v)) }
        val o = JSONObject().put("accounts", arr).put("active", active ?: "").put("settings", s)
            .put("labels", ls).put("chatLabels", map)
            .put("sentDay", sentDay).put("sent", JSONObject(sent as Map<*, *>))
        prefs.edit().putString("state", o.toString()).apply()
    }

    /** Broadcast messages [id] sent today; a new day starts from zero. */
    fun sentToday(id: String): Int {
        val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
        if (sentDay != today) { sentDay = today; sent.clear() }
        return sent[id] ?: 0
    }

    fun find(id: String?): Account? = accounts.firstOrNull { it.id == id }

    fun newId(): String = "a" + System.currentTimeMillis().toString(36) + (0..99).random()

    companion object {
        val COLORS = intArrayOf(
            0xFF3AA0FF.toInt(), 0xFF26A69A.toInt(), 0xFF7E57C2.toInt(), 0xFFEF5350.toInt(),
            0xFFFFA726.toInt(), 0xFF66BB6A.toInt(), 0xFFEC407A.toInt(), 0xFF8D6E63.toInt(),
        )

        /** Unread count from the page title: "(3) Gem Space", "3 · Gem Space". */
        fun unreadFromTitle(title: String?): Int {
            val t = title?.trimStart() ?: return 0
            if (t.startsWith("(")) return t.drop(1).takeWhile { it.isDigit() }.toIntOrNull() ?: 0
            val d = t.takeWhile { it.isDigit() }
            if (d.isEmpty()) return 0
            val after = t.getOrNull(d.length)
            return if (after == ' ' || after == '·' || after == '|' || after == '-') d.toIntOrNull() ?: 0 else 0
        }

        fun initials(name: String): String {
            val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (parts.isEmpty()) return "?"
            return (parts[0].take(1) + (parts.getOrNull(1)?.take(1) ?: "")).uppercase()
        }
    }
}
