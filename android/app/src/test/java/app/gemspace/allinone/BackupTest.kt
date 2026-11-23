package app.gemspace.allinone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class BackupTest {
    private val teal = 0xFF26A69A.toInt()

    @Test
    fun roundTrip() {
        val s = Settings(maxAwake = 7)
        val labels = listOf(Label("l1", "Клиенты", 0xFFFF4D4D.toInt()))
        val file = Backup.write(listOf(Account("a1", "Продажи", teal), Account("a2", "Поддержка", teal, true)), s, labels, mapOf("a1|Ирина" to listOf("l1")))

        val accounts = mutableListOf(Account("a2", "Старое", 0))
        val mine = Settings()
        val ls = mutableListOf<Label>()
        val map = mutableMapOf<String, MutableList<String>>()
        val (added, updated) = Backup.restore(file, accounts, mine, ls, map) { "new" }
        assertEquals(1 to 1, added to updated)
        assertEquals(listOf("Поддержка", "Продажи"), accounts.map { it.name })
        assertEquals(teal, accounts[0].color)
        assertTrue(accounts[0].pinned)
        assertEquals(7, mine.maxAwake)
        assertEquals(listOf("l1"), map["a1|Ирина"])
        assertEquals("#ff4d4d", Backup.hex(ls[0].color))
    }

    @Test
    fun windowsFileKeepsAndroidSettings() {
        val file = """{"app":"hovi-space","format":1,"platform":"windows","settings":{"max_awake":2},
            "accounts":[{"id":"../x","name":" ","color":"red","proxy":"socks5://h:1","pinned":false}],
            "labels":[{"id":"l1","name":"Оплата","color":"#00ff00"},{"id":"bad id","name":"x","color":"#000000"}],
            "chat_labels":{"../x|Чат":["l1","nope"],"nobar":["l1"]}}"""
        val accounts = mutableListOf<Account>()
        val s = Settings()
        val ls = mutableListOf<Label>()
        val map = mutableMapOf<String, MutableList<String>>()
        assertEquals(1 to 0, Backup.restore(file, accounts, s, ls, map) { "fresh" })
        assertEquals("fresh", accounts[0].id)
        assertEquals("Аккаунт 1", accounts[0].name)
        assertEquals(Store.COLORS[0], accounts[0].color)
        assertEquals(4, s.maxAwake)
        assertEquals(listOf("l1"), ls.map { it.id })
        assertEquals(mapOf("fresh|Чат" to listOf("l1")), map)
    }

    @Test
    fun rejectsOtherFiles() {
        try {
            Backup.restore("""{"app":"other","format":1}""", mutableListOf(), Settings(), mutableListOf(), mutableMapOf()) { "x" }
            fail()
        } catch (e: IllegalArgumentException) {
            assertEquals("Это не резервная копия Hovi Space", e.message)
        }
    }
}
