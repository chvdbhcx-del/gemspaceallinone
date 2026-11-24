package app.gemspace.allinone

import org.json.JSONArray
import org.json.JSONObject

/** A quick-reply template: put into the message field of a chat, never sent by itself. */
data class Template(val id: String, var title: String, var text: String)

/**
 * What the user keeps about chats of "Все чаты" besides labels, only on this phone: a note, a status
 * ("Открыт", "Ждёт клиента", "Готово" or their own), a reminder, and the templates. Chats are keyed
 * "<account id>|<chat name>". The JSON keys are the same as on Windows (desktop/src/crm.rs), so one
 * backup file works on both.
 */
class ChatMeta {
    val notes = mutableMapOf<String, String>()
    val statuses = mutableListOf<Label>()
    val chatStatus = mutableMapOf<String, String>()
    /** chat -> when to remind, ms since 1970 */
    val reminders = mutableMapOf<String, Long>()
    val templates = mutableListOf<Template>()

    fun status(key: String): Label? = chatStatus[key]?.let { id -> statuses.firstOrNull { it.id == id } }

    fun isDue(key: String, now: Long = System.currentTimeMillis()) = (reminders[key] ?: 0L).let { it in 1..now }

    /** Keeps well-formed entries only, within the limits the Windows app has too. */
    fun clean() {
        notes.entries.removeAll { (k, v) -> !chatKey(k) || v.isBlank() }
        notes.replaceAll { _, v -> v.trim().take(NOTE_MAX) }
        val seen = HashSet<String>()
        statuses.retainAll { s -> Backup.safeId(s.id) && s.name.isNotBlank() && seen.add(s.id) }
        while (statuses.size > MAX_STATUSES) statuses.removeAt(statuses.size - 1)
        statuses.forEach { it.name = it.name.trim().take(30) }
        val ids = statuses.map { it.id }.toSet()
        chatStatus.entries.removeAll { (k, v) -> !chatKey(k) || v !in ids }
        reminders.entries.removeAll { (k, v) -> !chatKey(k) || v !in 1_577_836_800_000L until 4_102_444_800_000L }
        val tseen = HashSet<String>()
        templates.retainAll { t -> Backup.safeId(t.id) && t.text.isNotBlank() && tseen.add(t.id) }
        while (templates.size > MAX_TEMPLATES) templates.removeAt(templates.size - 1)
        templates.forEach { t ->
            t.text = t.text.trim().take(TEMPLATE_MAX)
            t.title = t.title.trim().take(40).ifEmpty { t.text.split(Regex("\\s+")).joinToString(" ").take(40) }
        }
    }

    /** Drops everything of a removed account. */
    fun forget(accountId: String) {
        val p = "$accountId|"
        notes.keys.removeAll { it.startsWith(p) }
        chatStatus.keys.removeAll { it.startsWith(p) }
        reminders.keys.removeAll { it.startsWith(p) }
    }

    fun write(o: JSONObject) {
        val st = JSONArray()
        statuses.forEach { st.put(JSONObject().put("id", it.id).put("name", it.name).put("color", Backup.hex(it.color))) }
        val tp = JSONArray()
        templates.forEach { tp.put(JSONObject().put("id", it.id).put("title", it.title).put("text", it.text)) }
        o.put("notes", JSONObject(notes as Map<*, *>)).put("statuses", st).put("chat_status", JSONObject(chatStatus as Map<*, *>))
            .put("reminders", JSONObject(reminders as Map<*, *>)).put("templates", tp)
    }

    /**
     * Reads what [write] wrote, or a backup file. [merge] keeps what is here and lets the file win for a chat
     * both have; [rekey] gives a chat key its account's id on this phone. A state without "statuses" (from
     * before them) gets the default ones; a file without them adds none.
     */
    fun read(o: JSONObject, merge: Boolean, rekey: (String) -> String? = { it }) {
        if (!merge) { notes.clear(); statuses.clear(); chatStatus.clear(); reminders.clear(); templates.clear() }
        val st = o.optJSONArray("statuses")
        if (st == null && !merge) statuses += defaultStatuses()
        if (st != null) for (i in 0 until st.length()) {
            val j = st.optJSONObject(i) ?: continue
            val c = Backup.color(j.optString("color")) ?: continue
            val mine = statuses.firstOrNull { it.id == j.optString("id") }
            if (mine != null) { mine.name = j.optString("name"); mine.color = c } else statuses += Label(j.optString("id"), j.optString("name"), c)
        }
        o.optJSONObject("notes")?.let { m -> m.keys().forEach { k -> rekey(k)?.let { notes[it] = m.optString(k) } } }
        o.optJSONObject("chat_status")?.let { m -> m.keys().forEach { k -> rekey(k)?.let { chatStatus[it] = m.optString(k) } } }
        o.optJSONObject("reminders")?.let { m -> m.keys().forEach { k -> rekey(k)?.let { reminders[it] = m.optLong(k) } } }
        o.optJSONArray("templates")?.let { a ->
            for (i in 0 until a.length()) {
                val j = a.optJSONObject(i) ?: continue
                val t = Template(j.optString("id"), j.optString("title"), j.optString("text"))
                val at = templates.indexOfFirst { it.id == t.id }
                if (at >= 0) templates[at] = t else templates += t
            }
        }
        clean()
    }

    /** Reminders due at [now] that were not announced for that time yet ([told]: chat -> the time announced). */
    fun due(told: Map<String, Long>, now: Long): List<String> =
        reminders.filter { (k, at) -> at <= now && told[k] != at }.keys.sorted()

    companion object {
        const val NOTE_MAX = 1000
        const val TEMPLATE_MAX = 4000
        const val MAX_STATUSES = 12
        const val MAX_TEMPLATES = 60

        fun defaultStatuses() = listOf(
            Label("s-open", "Открыт", 0xFF3AA0FF.toInt()),
            Label("s-wait", "Ждёт клиента", 0xFFFFA726.toInt()),
            Label("s-done", "Готово", 0xFF66BB6A.toInt()),
        )

        val EXAMPLES = listOf(
            "Приветствие" to "Здравствуйте, {имя}! Чем могу помочь?",
            "Счёт отправлен" to "{имя}, счёт отправил. Проверьте, пожалуйста, и напишите, если будут вопросы.",
            "Спасибо за заказ" to "Спасибо за заказ, {имя}! Как только отправим, пришлю номер для отслеживания.",
        )

        private fun chatKey(k: String) = k.length <= 200 && k.contains('|')
    }
}
