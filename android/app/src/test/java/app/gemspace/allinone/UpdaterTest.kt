package app.gemspace.allinone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdaterTest {
    @Test
    fun buildNumbersOfTags() {
        assertEquals(12, Updater.buildOf("v0.1.12"))
        assertEquals(5, Updater.buildOf("v0.1.0-build.5"))
        assertNull(Updater.buildOf("v0.2.3"))
        assertNull(Updater.buildOf("hivogram-v1.0.0-build.3"))
        assertNull(Updater.buildOf("v0.1.x"))
    }
}
