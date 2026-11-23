package app.gemspace.allinone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

class ChatRowTest {
    // Wednesday 2026-11-25, 15:00
    private val now = Calendar.getInstance().apply { set(2026, Calendar.NOVEMBER, 25, 15, 0, 0); set(Calendar.MILLISECOND, 0) }

    @Test
    fun ordersLabelsFromNewestToOldest() {
        val labels = listOf("14:59", "09:00", "Вчера", "Пн", "Вс", "20.11.2026", "01.01.2025", "что-то")
        val times = labels.map { ChatRow.timeOf(it, now) }
        assertEquals(times.sortedDescending(), times)
    }

    @Test
    fun weekdayIsInThePastWeek() {
        val mon = ChatRow.timeOf("Пн", now)
        assertTrue(mon < ChatRow.timeOf("Вчера", now))
        assertTrue(mon > ChatRow.timeOf("20.11.2026", now))
    }

    @Test
    fun parsesAndBoundsRows() {
        assertNull(ChatRow.of(JSONObject().put("name", " ")))
        val r = ChatRow.of(JSONObject().put("name", "x".repeat(200)).put("unread", 3).put("time", "12:00"))!!
        assertEquals(80, r.name.length)
        assertEquals(3, r.unread)
    }
}
