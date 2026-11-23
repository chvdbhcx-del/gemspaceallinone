package app.gemspace.allinone

import org.junit.Assert.assertEquals
import org.junit.Test

class StoreTest {
    @Test
    fun unreadFromTitle() {
        assertEquals(0, Store.unreadFromTitle("Gem Space"))
        assertEquals(3, Store.unreadFromTitle("(3) Gem Space"))
        assertEquals(12, Store.unreadFromTitle("12 · Gem Space"))
        assertEquals(0, Store.unreadFromTitle("4G chat"))
        assertEquals(0, Store.unreadFromTitle(null))
    }

    @Test
    fun initials() {
        assertEquals("ПО", Store.initials("Продажи Опт"))
        assertEquals("S", Store.initials("Sales"))
        assertEquals("?", Store.initials("  "))
    }
}
