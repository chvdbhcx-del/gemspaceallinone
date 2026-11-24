package app.gemspace.allinone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInTest {
    @Test
    fun signInWindowsStayInside() {
        assertTrue(SignIn.isSignInUrl("https", "oauth.telegram.org", "/auth"))
        assertTrue(SignIn.isSignInUrl("https", "web.gemspace.com", "/login"))
        assertTrue(SignIn.isSignInUrl("https", "www.google.com", "/recaptcha/api2/anchor"))
        assertFalse(SignIn.isSignInUrl("https", "t.me", "/somebody"))
        assertFalse(SignIn.isSignInUrl("https", "www.google.com", "/search"))
        assertFalse(SignIn.isSignInUrl("https", "evilgemspace.com", "/"))
        assertFalse(SignIn.isSignInUrl("http", "web.gemspace.com", "/"))
    }
}
