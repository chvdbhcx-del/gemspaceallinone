package app.gemspace.allinone

/**
 * The shared feed: new messages of all accounts in one list, newest first.
 *
 * It is filled from the notifications the Gem Space pages show (inject.js reroutes them here), so
 * Gemspace never reads the pages. It is read only: a row opens its account and, when the page gave
 * the notification a click handler, the chat. Replies are written in Gem Space itself.
 */
data class FeedItem(
    val key: Long,
    val account: String,
    val title: String,
    val body: String,
    val time: Long,
    /** the page's notification id (inject.js), used to click it; empty when the page gave none */
    val nid: String,
)

class Feed {
    private val items = ArrayDeque<FeedItem>()
    private var next = 0L

    /** Adds a message on top; returns false for an immediate duplicate (page and service worker). */
    fun push(account: String, title: String, body: String, nid: String, time: Long): Boolean {
        val t = title.take(120)
        val b = body.take(300)
        val top = items.firstOrNull { it.account == account }
        if (top != null && top.title == t && top.body == b && time - top.time < DUPLICATE_MS) return false
        next += 1
        items.addFirst(FeedItem(next, account, t, b, time, nid))
        while (items.size > MAX_ITEMS) items.removeLast()
        return true
    }

    fun take(key: Long): FeedItem? {
        val i = items.indexOfFirst { it.key == key }
        return if (i < 0) null else items.removeAt(i)
    }

    /** Removes the account's messages, or all of them for null; returns whether anything went. */
    fun clear(account: String?): Boolean {
        val before = items.size
        if (account == null) items.clear() else items.removeAll { it.account == account }
        return items.size != before
    }

    fun items(): List<FeedItem> = items.toList()

    val size: Int get() = items.size

    companion object {
        const val MAX_ITEMS = 200
        private const val DUPLICATE_MS = 3000L
    }
}
