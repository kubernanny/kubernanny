package app.kubernanny.widget

/**
 * Which overview the all-clusters widget shows at a size, and how many rows
 * and "+N more" that leaves. Plain numbers, no Android types, so it runs in a
 * unit test (OverviewLayoutTest).
 *
 * The heights sit well away from the launcher's cell heights (a phone's 4 x 2
 * is about 250 dp, 4 x 1 about 110 to 140): the size the launcher reports
 * moves by a few dp between binds (after a language change, for one), and a
 * step right at a cell height made the widget jump between layouts.
 * Budget per height: 28 dp padding, 54 the summary on top, 42 a row, 20 the
 * "+N more" line, 150 three problems.
 */
data class OverviewSpec(
    val minWidth: Float,
    val minHeight: Float,
    /** The small square: everything added up, a dot per cluster. */
    val small: Boolean = false,
    val header: Boolean = false,
    val rows: Int = 0,
    val problems: Boolean = false,
)

object OverviewLayout {
    val SPECS = listOf(
        OverviewSpec(40f, 40f, small = true),
        OverviewSpec(220f, 40f, rows = 2),
        OverviewSpec(220f, 160f, rows = 3),
        OverviewSpec(220f, 200f, header = true, rows = 3),
        OverviewSpec(220f, 280f, header = true, rows = 4),
        OverviewSpec(220f, 410f, header = true, rows = 4, problems = true),
    )

    /** The largest spec that fits the size in dp (the rule RemoteViews applies from Android 12), else the smallest. */
    fun pick(widthDp: Float, heightDp: Float): OverviewSpec =
        SPECS.lastOrNull { it.minWidth <= widthDp && it.minHeight <= heightDp } ?: SPECS.first()

    /** How many cluster rows a spec shows for a list of [total] clusters. */
    fun shown(total: Int, spec: OverviewSpec) = minOf(total, spec.rows).coerceAtLeast(0)

    /** The N of "+N more", 0 when every cluster has its row. */
    fun more(total: Int, spec: OverviewSpec) = (total - shown(total, spec)).coerceAtLeast(0)
}
