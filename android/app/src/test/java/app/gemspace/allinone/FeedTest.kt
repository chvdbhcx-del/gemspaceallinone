package app.gemspace.allinone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedTest {
    @Test
    fun newestFirstAndCapped() {
        val f = Feed()
        for (i in 0 until Feed.MAX_ITEMS + 5) assertTrue(f.push("a", "t", i.toString(), "", i * 10_000L))
        assertEquals(Feed.MAX_ITEMS, f.size)
        assertEquals((Feed.MAX_ITEMS + 4).toString(), f.items()[0].body)
    }

    @Test
    fun duplicatesWithinSecondsAreDropped() {
        val f = Feed()
        assertTrue(f.push("a", "Ирина", "Привет", "n1", 1000))
        assertFalse(f.push("a", "Ирина", "Привет", "", 2500))
        assertTrue(f.push("b", "Ирина", "Привет", "", 2500))
        assertTrue(f.push("a", "Ирина", "Привет", "", 9000))
        assertEquals(3, f.size)
    }

    @Test
    fun takeAndClear() {
        val f = Feed()
        f.push("a", "1", "x", "n1", 0)
        f.push("b", "2", "y", "", 10_000)
        f.push("a", "3", "z", "", 20_000)
        val k = f.items()[1].key
        assertEquals("2", f.take(k)?.title)
        assertNull(f.take(k))
        assertTrue(f.clear("a"))
        assertEquals(0, f.size)
        assertFalse(f.clear(null))
    }
}
