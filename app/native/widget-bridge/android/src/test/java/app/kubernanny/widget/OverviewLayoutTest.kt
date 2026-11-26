package app.kubernanny.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OverviewLayoutTest {
    private val phone4x2Portrait = 396f to 249.33f
    private val phone4x2Landscape = 706.67f to 140.67f

    @Test
    fun `a 4 x 2 widget keeps the summary and three rows however the launcher rounds its height`() {
        // Emulator Pixel 9 Pro XL reports 249.3 and 250.7 dp; other binds a few dp more or less.
        for (height in listOf(230f, 249.33f, 250.67f, 262f, 275f)) {
            val spec = OverviewLayout.pick(phone4x2Portrait.first, height)
            assertTrue("header at $height", spec.header)
            assertEquals("rows at $height", 3, spec.rows)
        }
    }

    @Test
    fun `three clusters in the 4 x 2 widget show no more line`() {
        val spec = OverviewLayout.pick(phone4x2Portrait.first, phone4x2Portrait.second)
        assertEquals(3, OverviewLayout.shown(3, spec))
        assertEquals(0, OverviewLayout.more(3, spec))
    }

    @Test
    fun `more counts only the clusters without a row`() {
        val spec = OverviewLayout.pick(phone4x2Landscape.first, phone4x2Landscape.second)
        assertFalse(spec.header)
        assertEquals(2, spec.rows)
        assertEquals(1, OverviewLayout.more(3, spec))
        assertEquals(0, OverviewLayout.more(2, spec))
        assertEquals(0, OverviewLayout.more(0, spec))
        assertEquals(3, OverviewLayout.more(5, spec))
    }

    @Test
    fun `small and large ends`() {
        assertTrue(OverviewLayout.pick(110f, 110f).small)
        assertTrue(OverviewLayout.pick(10f, 10f).small)
        val large = OverviewLayout.pick(396f, 500f)
        assertTrue(large.header && large.problems)
        assertEquals(4, large.rows)
        assertEquals(1, OverviewLayout.more(5, large))
    }

    @Test
    fun `no step sits within 15 dp of a phone cell height`() {
        // 1 to 4 rows of cells on common phones: about 110 to 140, 250, 370, 500 dp.
        val cells = listOf(110f, 140f, 250f, 370f, 500f)
        for (spec in OverviewLayout.SPECS.drop(1)) {
            for (cell in cells) {
                assertTrue("step ${spec.minHeight} near cell $cell", kotlin.math.abs(spec.minHeight - cell) >= 15f)
            }
        }
    }
}
