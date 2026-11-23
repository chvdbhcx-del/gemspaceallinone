package app.gemspace.allinone

import org.json.JSONArray
import org.json.JSONObject

/** A label the user puts on chats of "Все чаты" ("Клиенты", "Оплата"), kept only on this phone. */
data class Label(val id: String, var name: String, var color: Int)

/**
 * The file "Резервная копия" writes and reads: accounts (without logins), settings and labels. The same
 * format as on Windows ("hovi-space", format 1); settings are taken only from a file made on Android.
 */
object Backup {
    const val MAX_LABELS = 30

    fun hex(c: Int) = String.format("#%06x", c and 0xFFFFFF)

    fun color(s: String?): Int? =
        if (s != null && Regex("^#[0-9a-fA-F]{6}$").matches(s)) (0xFF000000L or s.substring(1).toLong(16)).toInt() else null

    fun safeId(id: String) = id.isNotEmpty() && id.length <= 40 && id.all { it.isLetterOrDigit() && it.code < 128 || it == '-' }

    fun write(accounts: List<Account>, s: Settings, labels: List<Label>, chatLabels: Map<String, List<String>>): String {
        val acc = JSONArray()
        accounts.forEach { acc.put(JSONObject().put("id", it.id).put("name", it.name).put("color", hex(it.color)).put("pinned", it.pinned)) }
        val ls = JSONArray()
        labels.forEach { ls.put(JSONObject().put("id", it.id).put("name", it.name).put("color", hex(it.color))) }
        val map = JSONObject()
        chatLabels.forEach { (k, v) -> map.put(k, JSONArray(v)) }
        val settings = JSONObject().put("notifications", s.notifications).put("notifyPreview", s.notifyPreview).put("keepAlive", s.keepAlive)
            .put("sleepEnabled", s.sleepEnabled).put("maxAwake", s.maxAwake).put("uiScale", s.uiScale)
        return JSONObject().put("app", "hovi-space").put("format", 1).put("platform", "android")
            .put("accounts", acc).put("settings", settings).put("labels", ls).put("chat_labels", map).toString(2)
    }

    /** Keeps well-formed labels (at most 30) and only assignments to labels that exist. */
    fun clean(labels: MutableList<Label>, chatLabels: MutableMap<String, MutableList<String>>) {
        val seen = HashSet<String>()
        labels.retainAll { l -> safeId(l.id) && l.name.isNotBlank() && seen.add(l.id) }
        while (labels.size > MAX_LABELS) labels.removeAt(labels.size - 1)
        labels.forEach { it.name = it.name.trim().take(30) }
        val ids = labels.map { it.id }.toSet()
        val it = chatLabels.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            val v = e.value.filter { x -> x in ids }.distinct()
            if (v.isEmpty() || !e.key.contains('|') || e.key.length > 200) it.remove() else e.setValue(v.toMutableList())
        }
    }

    /**
     * Adds the file's accounts (one already here by the same id gets its name, colour and "не усыплять" from
     * the file), its labels and, from an Android file, its settings. Returns (added, updated).
     */
    fun restore(
        json: String, accounts: MutableList<Account>, s: Settings, labels: MutableList<Label>,
        chatLabels: MutableMap<String, MutableList<String>>, newId: () -> String,
    ): Pair<Int, Int> {
        val o = try { JSONObject(json) } catch (e: Exception) { throw IllegalArgumentException("Это не резервная копия Hovi Space") }
        if (o.optString("app") != "hovi-space" || o.optInt("format") != 1) throw IllegalArgumentException("Это не резервная копия Hovi Space")
        var added = 0
        var updated = 0
        val renamed = HashMap<String, String>()
        val arr = o.optJSONArray("accounts") ?: JSONArray()
        for (i in 0 until minOf(arr.length(), 200)) {
            val a = arr.optJSONObject(i) ?: continue
            val id = a.optString("id")
            val name = a.optString("name").trim().take(40).ifEmpty { "Аккаунт ${accounts.size + 1}" }
            val color = color(a.optString("color")) ?: Store.COLORS[0]
            val mine = accounts.firstOrNull { it.id == id }
            if (mine != null) {
                mine.name = name; mine.color = color; mine.pinned = a.optBoolean("pinned")
                updated++
            } else {
                val nid = if (safeId(id)) id else newId()
                if (nid != id) renamed[id] = nid
                accounts += Account(nid, name, color, a.optBoolean("pinned"))
                added++
            }
        }
        if (o.optString("platform") == "android") o.optJSONObject("settings")?.let { j ->
            s.notifications = j.optBoolean("notifications", s.notifications)
            s.notifyPreview = j.optBoolean("notifyPreview", s.notifyPreview)
            s.keepAlive = j.optBoolean("keepAlive", s.keepAlive)
            s.sleepEnabled = j.optBoolean("sleepEnabled", s.sleepEnabled)
            s.maxAwake = j.optInt("maxAwake", s.maxAwake).coerceIn(1, 30)
            s.uiScale = j.optInt("uiScale", s.uiScale).coerceIn(80, 150)
        }
        val ls = o.optJSONArray("labels") ?: JSONArray()
        for (i in 0 until ls.length()) {
            val l = ls.optJSONObject(i) ?: continue
            val c = color(l.optString("color")) ?: continue
            val mine = labels.firstOrNull { it.id == l.optString("id") }
            if (mine != null) { mine.name = l.optString("name"); mine.color = c } else labels += Label(l.optString("id"), l.optString("name"), c)
        }
        val map = o.optJSONObject("chat_labels")
        map?.keys()?.forEach { key ->
            val acc = key.substringBefore('|', "")
            if (acc.isEmpty()) return@forEach
            val k = renamed[acc]?.let { "$it|${key.substringAfter('|')}" } ?: key
            val v = map.optJSONArray(key) ?: return@forEach
            val slot = chatLabels.getOrPut(k) { mutableListOf() }
            for (j in 0 until v.length()) v.optString(j).takeIf { it.isNotEmpty() && it !in slot }?.let { slot += it }
        }
        clean(labels, chatLabels)
        return added to updated
    }
}
