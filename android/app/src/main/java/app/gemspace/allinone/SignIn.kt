package app.gemspace.allinone

/**
 * Windows the Gem Space page opens while signing in: its own pages, Telegram's login and captcha checks.
 * They stay inside the account (same profile, `window.opener` kept), or the page waits for them forever.
 * Everything else a page opens (links from chats) goes to the system browser.
 */
object SignIn {
    fun isSignInUrl(scheme: String?, host: String?, path: String?): Boolean {
        if (scheme != "https" || host == null) return false
        fun on(domain: String) = host == domain || host.endsWith(".$domain")
        return on("gemspace.com") ||
            host == "oauth.telegram.org" ||
            on("recaptcha.net") ||
            (host == "www.google.com" && (path ?: "").startsWith("/recaptcha")) ||
            on("hcaptcha.com") ||
            host == "challenges.cloudflare.com"
    }
}
