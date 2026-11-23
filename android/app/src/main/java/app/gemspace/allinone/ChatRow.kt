package app.gemspace.allinone

import org.json.JSONObject
import java.util.Calendar

/** One row of an account's chat list as its page shows it (shared/chats.js). */
data class ChatRow(val name: String, val time: String, val preview: String, val unread: Int) {
    companion object {
        fun of(o: JSONObject): ChatRow? {
            val name = o.optString("name").trim().take(80)
            if (name.isEmpty()) return null
            return ChatRow(name, o.optString("time").take(16), o.optString("preview").take(160), o.optInt("unread").coerceIn(0, 99999))
        }

        private val WEEK = mapOf("вс" to 1, "пн" to 2, "вт" to 3, "ср" to 4, "чт" to 5, "пт" to 6, "сб" to 7,
            "sun" to 1, "mon" to 2, "tue" to 3, "wed" to 4, "thu" to 5, "fri" to 6, "sat" to 7)

        /** Rough time of the last message from the label Gem Space shows ("18:05", "Вчера", "Пн", "23.11.2026"), to merge accounts in order. */
        fun timeOf(label: String, now: Calendar = Calendar.getInstance()): Long {
            val t = label.trim().lowercase()
            val day = (now.clone() as Calendar).apply {
                set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
            }.timeInMillis
            Regex("^(\\d{1,2}):(\\d{2})$").find(t)?.let { m ->
                return day + (m.groupValues[1].toInt() * 60 + m.groupValues[2].toInt()) * 60_000L
            }
            if (t.startsWith("вчера") || t.startsWith("yesterday")) return day - 12 * 3_600_000L
            // only a bare weekday label ("пн", "пн.", "mon"), never a word that starts like one
            val w = if (t.length <= 4) WEEK[t.trimEnd('.')] else null
            if (w != null) {
                val back = ((now.get(Calendar.DAY_OF_WEEK) - w + 7) % 7).let { if (it == 0) 7 else it }
                return day - back * 86_400_000L + 12 * 3_600_000L
            }
            Regex("^(\\d{1,2})[./-](\\d{1,2})(?:[./-](\\d{2,4}))?$").find(t)?.let { m ->
                val y = m.groupValues[3].toIntOrNull()?.let { if (it < 100) 2000 + it else it } ?: now.get(Calendar.YEAR)
                return Calendar.getInstance().apply { set(y, m.groupValues[2].toInt() - 1, m.groupValues[1].toInt(), 12, 0, 0) }.timeInMillis
            }
            return 0
        }
    }
}
