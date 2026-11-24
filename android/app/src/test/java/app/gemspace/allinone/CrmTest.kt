package app.gemspace.allinone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrmTest {
    @Test
    fun oldStateGetsDefaultStatusesAndRoundTrips() {
        val m = ChatMeta()
        m.read(JSONObject("""{"accounts":[]}"""), merge = false)
        assertEquals(listOf("Открыт", "Ждёт клиента", "Готово"), m.statuses.map { it.name })
        m.notes["a1|Ирина"] = "  перезвонить  "
        m.chatStatus["a1|Ирина"] = "s-wait"
        m.chatStatus["a1|Павел"] = "nope"
        m.reminders["a1|Ирина"] = 1_800_000_000_000L
        m.reminders["a1|Павел"] = 5L
        m.templates += Template("t1", "", "Здравствуйте,   {имя}!")
        m.clean()
        assertEquals("перезвонить", m.notes["a1|Ирина"])
        assertNull(m.chatStatus["a1|Павел"])
        assertNull(m.reminders["a1|Павел"])
        assertEquals("Здравствуйте, {имя}!", m.templates[0].title)
        val o = JSONObject(); m.write(o)
        val back = ChatMeta(); back.read(JSONObject(o.toString()), merge = false)
        assertEquals("Ждёт клиента", back.status("a1|Ирина")?.name)
        assertEquals(1_800_000_000_000L, back.reminders["a1|Ирина"])
        assertEquals(1, back.templates.size)
        // all statuses deleted stay deleted
        back.statuses.clear(); back.clean()
        val o2 = JSONObject(); back.write(o2)
        val again = ChatMeta(); again.read(JSONObject(o2.toString()), merge = false)
        assertTrue(again.statuses.isEmpty())
    }

    @Test
    fun windowsBackupMergesWithRenamedAccounts() {
        val file = """{"app":"hovi-space","format":1,"platform":"windows",
            "accounts":[{"id":"../x","name":"Опт","color":"#26a69a"}],
            "statuses":[{"id":"s-open","name":"В работе","color":"#ff0000"},{"id":"s-vip","name":"VIP","color":"#00ff00"}],
            "notes":{"../x|Марк":"закупки"},"chat_status":{"../x|Марк":"s-vip"},"reminders":{"../x|Марк":1800000000000},
            "templates":[{"id":"t1","title":"Привет","text":"Здравствуйте!"}]}"""
        val meta = ChatMeta().apply { statuses += ChatMeta.defaultStatuses() }
        Backup.restore(file, mutableListOf(), Settings(), mutableListOf(), mutableMapOf(), meta) { "fresh" }
        assertEquals(listOf("В работе", "Ждёт клиента", "Готово", "VIP"), meta.statuses.map { it.name })
        assertEquals("закупки", meta.notes["fresh|Марк"])
        assertEquals("VIP", meta.status("fresh|Марк")?.name)
        assertEquals(1_800_000_000_000L, meta.reminders["fresh|Марк"])
        assertEquals("Привет", meta.templates.single().title)
        val out = JSONObject(Backup.write(emptyList(), Settings(), emptyList(), emptyMap(), meta))
        assertEquals("закупки", out.getJSONObject("notes").getString("fresh|Марк"))
        meta.forget("fresh")
        assertTrue(meta.notes.isEmpty() && meta.chatStatus.isEmpty() && meta.reminders.isEmpty())
    }

    @Test
    fun remindersComeDueOnce() {
        val m = ChatMeta()
        m.reminders["a|Ирина"] = 1000L
        m.reminders["a|Павел"] = 5000L
        val told = HashMap<String, Long>()
        assertEquals(listOf("a|Ирина"), m.due(told, 2000))
        told["a|Ирина"] = 1000L
        assertTrue(m.due(told, 2000).isEmpty())
        m.reminders["a|Ирина"] = 1500L
        assertEquals(listOf("a|Ирина", "a|Павел"), m.due(told, 6000))
        assertTrue(m.isDue("a|Ирина", 2000))
    }
}
