package app.gemspace.allinone

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.view.MotionEvent
import android.view.animation.OvershootInterpolator
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.ScrollView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.res.ResourcesCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * One WebView per Gem Space account, each in its own WebView profile (own cookies and storage),
 * with a strip of accounts on top. The Gem Space web app itself is loaded unmodified.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var store: Store
    private lateinit var strip: LinearLayout
    private lateinit var pages: FrameLayout
    private lateinit var welcome: View
    private lateinit var welcomeContent: LinearLayout

    /** loaded (awake) accounts; access order = least recently used first */
    private val views = LinkedHashMap<String, WebView>(16, 0.75f, true)
    private val unread = HashMap<String, Int>()
    private val attention = HashSet<String>()
    /** new messages of all accounts, from their notifications (Feed.kt) */
    private val feed = Feed()
    private lateinit var feedSlot: FrameLayout
    private var shownFeed = 0
    private var resumed = false

    // what the bar and the page showed last time, so only real changes animate
    private val shownUnread = HashMap<String, Int>()
    private val shownTiles = HashSet<String>()
    private var shownActive: String? = null
    private var shownPage: String? = null

    private val fontBold: Typeface? by lazy { ResourcesCompat.getFont(this, R.font.nunito_bold) }
    private val fontHeavy: Typeface? by lazy { ResourcesCompat.getFont(this, R.font.nunito_extrabold) }

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null

    private val multiProfile by lazy { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) }
    private val injectJs by lazy { assets.open("inject.js").bufferedReader().use { it.readText() } }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        fileCallback = null
    }

    private val askMedia = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val req = pendingPermission ?: return@registerForActivityResult
        pendingPermission = null
        val ok = req.resources.filter { r ->
            when (r) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted[Manifest.permission.RECORD_AUDIO] ?: hasPerm(Manifest.permission.RECORD_AUDIO)
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted[Manifest.permission.CAMERA] ?: hasPerm(Manifest.permission.CAMERA)
                else -> false
            }
        }
        if (ok.isEmpty()) req.deny() else req.grant(ok.toTypedArray())
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        Notifier.ensureChannels(this)
        buildUi()

        if (Build.VERSION.SDK_INT >= 33 && !hasPerm(Manifest.permission.POST_NOTIFICATIONS)) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (!multiProfile && store.accounts.size > 1) {
            AlertDialog.Builder(this)
                .setTitle("Обновите Android System WebView")
                .setMessage("Для нескольких аккаунтов нужен Android System WebView версии 128 или новее. Пока работает только первый аккаунт. Обновите его в Google Play.")
                .setPositiveButton("Понятно", null)
                .show()
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = store.active?.let { views[it] }
                if (wv != null && wv.canGoBack()) wv.goBack() else moveTaskToBack(true)
            }
        })

        val start = intent.getStringExtra(Notifier.EXTRA_ACCOUNT)?.takeIf { store.find(it) != null }
            ?: store.active?.takeIf { store.find(it) != null }
            ?: store.accounts.firstOrNull()?.id
        if (start != null) switchTo(start) else render()
        // cloud updates: a newer release is offered once (Updater.kt)
        pages.postDelayed({ if (!isFinishing) Updater.checkQuietly(this) }, 15_000)
        updateKeepAlive()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(Notifier.EXTRA_ACCOUNT)?.let { if (store.find(it) != null) switchTo(it) }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        store.active?.let { attention.remove(it); Notifier.cancel(this, it) }
        render()
    }

    override fun onPause() {
        super.onPause()
        resumed = false
    }

    override fun onDestroy() {
        views.values.forEach { it.destroy() }
        views.clear()
        stopService(Intent(this, KeepAliveService::class.java))
        super.onDestroy()
    }

    // ---------- UI ----------

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(ContextCompat.getColor(context, R.color.bar))
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
            setPadding(dp(4), dp(4), dp(4), dp(2))
        }
        strip = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP }
        val scroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            // a tile cut by the screen edge fades out instead of ending abruptly
            isHorizontalFadingEdgeEnabled = true
            setFadingEdgeLength(dp(24))
            addView(strip)
        }
        feedSlot = FrameLayout(this)
        bar.addView(feedSlot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        bar.addView(scroll, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(toolTile("⚙", "Настройки") { openSettings() })
        root.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        pages = FrameLayout(this).apply { setBackgroundColor(ContextCompat.getColor(context, R.color.page)) }
        welcomeContent = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(32), dp(24), dp(32))
            val fg = ContextCompat.getColor(context, R.color.fg)
            val muted = ContextCompat.getColor(context, R.color.muted)
            addView(ImageView(context).apply {
                setImageResource(R.mipmap.ic_launcher)
                elevation = dp(10).toFloat()
            }, LinearLayout.LayoutParams(dp(96), dp(96)).apply { bottomMargin = dp(14) })
            addView(TextView(context).apply {
                text = "Gemspace"; textSize = 32f; typeface = fontHeavy; gravity = Gravity.CENTER; setTextColor(fg)
            })
            addView(TextView(context).apply {
                text = "Все ваши аккаунты Gem Space в одном приложении"
                textSize = 15f; typeface = fontBold; gravity = Gravity.CENTER; setTextColor(muted)
                setPadding(0, dp(6), 0, dp(22))
            })
            fun feature(icon: Int, title: String, body: String) = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply {
                    cornerRadius = dp(16).toFloat()
                    setColor(ContextCompat.getColor(context, R.color.bar))
                    setStroke(dp(1), ContextCompat.getColor(context, R.color.line))
                }
                addView(ImageView(context).apply {
                    setImageResource(icon)
                    setColorFilter(0xFF3AA0FF.toInt())
                    setPadding(dp(9), dp(9), dp(9), dp(9))
                    background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(0x2E3AA0FF) }
                }, LinearLayout.LayoutParams(dp(38), dp(38)).apply { marginEnd = dp(14) })
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(TextView(context).apply { text = title; textSize = 15f; typeface = fontHeavy; setTextColor(fg) })
                    addView(TextView(context).apply { text = body; textSize = 13f; setTextColor(muted) })
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            }
            val rowParams = { LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) } }
            addView(feature(R.drawable.ic_shield, "Отдельный вход", "У каждого аккаунта свои данные, как в разных браузерах"), rowParams())
            addView(feature(R.drawable.ic_feed, "Общая лента", "Новые сообщения всех аккаунтов в одном списке"), rowParams())
            addView(feature(R.drawable.ic_bell, "Уведомления", "С именем аккаунта, даже когда приложение закрыто"), rowParams())
            addView(feature(R.drawable.ic_moon, "Бережёт память", "Давно не открытые аккаунты засыпают сами"), rowParams())
            addView(TextView(context).apply {
                text = "Добавить первый аккаунт"; gravity = Gravity.CENTER; textSize = 16f; typeface = fontHeavy
                setTextColor(Color.WHITE); setPadding(dp(24), dp(15), dp(24), dp(15))
                background = GradientDrawable().apply { cornerRadius = dp(14).toFloat(); setColor(0xFF3AA0FF.toInt()) }
                elevation = dp(6).toFloat()
                setOnClickListener { editAccount(null) }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) })
            addView(TextView(context).apply {
                text = "Откроется обычная веб-версия Gem Space, вход по номеру телефона, как всегда."
                textSize = 12f; gravity = Gravity.CENTER; setTextColor(muted); setPadding(dp(8), dp(12), dp(8), 0)
            })
        }
        welcome = ScrollView(this).apply {
            isFillViewport = true
            visibility = View.GONE // render() fades it in with the features when there are no accounts
            addView(FrameLayout(context).apply {
                addView(welcomeContent, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
            })
        }
        pages.addView(welcome, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(pages, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        // Android 15 draws edge to edge: keep the bar below the status bar and the page above the keyboard
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    // Every tile of the bar has the same geometry: TILE_W x TILE_H, a round AVATAR_SIZE icon centred at the top
    // and a one-line label at the bottom, so accounts and the + / settings buttons line up.
    @SuppressLint("ClickableViewAccessibility")
    private fun tileFrame(desc: String) = FrameLayout(this).apply {
        layoutParams = LinearLayout.LayoutParams(dp(TILE_W), dp(TILE_H))
        contentDescription = desc
        // press feedback; returning false keeps click and long press working
        setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> v.animate().scaleX(0.92f).scaleY(0.92f).setDuration(90).start()
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> v.animate().scaleX(1f).scaleY(1f).setDuration(160).start()
            }
            false
        }
    }

    private fun tileLabel(text: String, strong: Boolean) = TextView(this).apply {
        this.text = text
        textSize = 10f
        maxLines = 1
        gravity = Gravity.CENTER
        setPadding(dp(2), 0, dp(2), 0)
        ellipsize = android.text.TextUtils.TruncateAt.END
        setTextColor(ContextCompat.getColor(context, if (strong) R.color.fg else R.color.muted))
        typeface = if (strong) fontHeavy else fontBold
    }

    private fun iconParams() =
        FrameLayout.LayoutParams(dp(AVATAR_SIZE), dp(AVATAR_SIZE), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = dp(AVATAR_TOP) }

    private fun labelParams() =
        FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM)

    private fun toolTile(symbol: String, label: String, onClick: () -> Unit) = tileFrame(label).apply {
        addView(TextView(context).apply {
            text = symbol
            textSize = 20f
            gravity = Gravity.CENTER
            setTextColor(ContextCompat.getColor(context, R.color.muted))
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setStroke(dp(1), ContextCompat.getColor(context, R.color.line))
            }
        }, iconParams())
        addView(tileLabel(label, false), labelParams())
        setOnClickListener { onClick() }
    }

    /** The feed button left of the accounts, shaped like an account tile, with the count of new messages. */
    private fun renderFeedTile() {
        feedSlot.removeAllViews()
        val accent = 0xFF3AA0FF.toInt()
        val n = feed.size
        val tile = tileFrame("Лента").apply { setOnClickListener { openFeed() } }
        tile.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_feed)
            setColorFilter(if (n > 0) accent else ContextCompat.getColor(context, R.color.muted))
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            setPadding(dp(11), dp(11), dp(11), dp(11))
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setStroke(dp(1), ContextCompat.getColor(context, R.color.line))
            }
        }, iconParams())
        tile.addView(tileLabel("Лента", false), labelParams())
        if (n > 0) {
            val avatarRight = (TILE_W + AVATAR_SIZE) / 2
            tile.addView(TextView(this).apply {
                text = if (n > 99) "99+" else n.toString()
                textSize = 10f
                setTextColor(Color.WHITE)
                typeface = fontHeavy
                gravity = Gravity.CENTER
                setPadding(dp(4), 0, dp(4), 0)
                minWidth = dp(18)
                if (n > shownFeed) {
                    scaleX = 0.3f; scaleY = 0.3f
                    animate().scaleX(1f).scaleY(1f).setDuration(320).setInterpolator(OvershootInterpolator(2.5f)).start()
                }
                background = GradientDrawable().apply {
                    cornerRadius = dp(9).toFloat(); setColor(accent)
                    setStroke(dp(2), ContextCompat.getColor(context, R.color.bar))
                }
            }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(18), Gravity.START or Gravity.TOP).apply {
                leftMargin = dp(avatarRight - 12)
                topMargin = dp(AVATAR_TOP - 4)
            })
        }
        shownFeed = n
        feedSlot.addView(tile)
    }

    private fun feedTime(ms: Long): String {
        val today = android.text.format.DateUtils.isToday(ms)
        val f = if (today) "HH:mm" else "d MMM, HH:mm"
        return java.text.SimpleDateFormat(f, java.util.Locale.forLanguageTag("ru")).format(java.util.Date(ms))
    }

    /** The shared feed: new messages of every account, newest first. A row opens the chat in its account. */
    private fun openFeed() {
        val items = feed.items().filter { store.find(it.account) != null }
        val fg = ContextCompat.getColor(this, R.color.fg)
        val muted = ContextCompat.getColor(this, R.color.muted)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(8), dp(4), dp(8), dp(8)) }
        lateinit var dialog: AlertDialog
        if (items.isEmpty()) {
            list.addView(TextView(this).apply {
                text = "Новых сообщений нет. Здесь появятся сообщения всех аккаунтов, как только придут."
                setTextColor(muted); setPadding(dp(16), dp(12), dp(16), dp(12))
            })
        }
        for (item in items) {
            val a = store.find(item.account) ?: continue
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = GradientDrawable().apply {
                    cornerRadius = dp(14).toFloat()
                    setColor(ContextCompat.getColor(context, R.color.page))
                    setStroke(dp(1), ContextCompat.getColor(context, R.color.line))
                }
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    dialog.dismiss()
                    openFeedItem(item.key)
                }
            }
            row.addView(TextView(this).apply {
                text = Store.initials(a.name); textSize = 14f; setTextColor(Color.WHITE); typeface = fontHeavy
                gravity = Gravity.CENTER
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(a.color) }
            }, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginEnd = dp(12) })
            val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            top.addView(TextView(this).apply {
                text = a.name; textSize = 12f; typeface = fontHeavy; setTextColor(0xFF3AA0FF.toInt()); maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            top.addView(TextView(this).apply { text = feedTime(item.time); textSize = 12f; setTextColor(muted) })
            texts.addView(top)
            texts.addView(TextView(this).apply {
                text = item.title.ifEmpty { a.name }; textSize = 15f; typeface = fontHeavy; setTextColor(fg); maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            })
            if (item.body.isNotEmpty()) texts.addView(TextView(this).apply {
                text = item.body; textSize = 14f; setTextColor(muted); maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
            })
            row.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            list.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(6)
            })
        }
        list.addView(TextView(this).apply {
            text = "Лента собирается из уведомлений аккаунтов, пока Gemspace работает. Спящие аккаунты сюда не пишут. Ответить можно в самом чате."
            textSize = 12f; setTextColor(muted); setPadding(dp(8), dp(6), dp(8), 0)
        })
        val b = AlertDialog.Builder(this)
            .setTitle("Лента")
            .setView(ScrollView(this).apply { addView(list) })
            .setNegativeButton("Закрыть", null)
        if (items.isNotEmpty()) b.setNeutralButton("Очистить") { _, _ -> feed.clear(null); render() }
        dialog = b.show()
    }

    private fun openFeedItem(key: Long) {
        val item = feed.take(key) ?: return
        if (store.find(item.account) == null) { render(); return }
        switchTo(item.account)
        if (item.nid.isNotEmpty() && item.nid.all { it.isLetterOrDigit() }) {
            views[item.account]?.evaluateJavascript("window.__gemspaceOpen && window.__gemspaceOpen('${item.nid}')", null)
        }
    }

    private fun render() {
        renderFeedTile()
        strip.removeAllViews()
        val accent = 0xFF3AA0FF.toInt()
        for (a in store.accounts) {
            val active = a.id == store.active
            val tile = tileFrame(a.name).apply {
                setOnClickListener { switchTo(a.id) }
                setOnLongClickListener { accountMenu(this, a); true }
            }
            if (active) {
                // the ring goes around the avatar, so the avatar keeps its size and position
                tile.addView(View(this).apply {
                    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setStroke(dp(2), accent) }
                    if (shownActive != a.id) {
                        alpha = 0f; scaleX = 0.7f; scaleY = 0.7f
                        animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(220).setInterpolator(OvershootInterpolator(1.6f)).start()
                    }
                }, FrameLayout.LayoutParams(dp(RING_SIZE), dp(RING_SIZE), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply {
                    topMargin = dp(AVATAR_TOP - (RING_SIZE - AVATAR_SIZE) / 2)
                })
            }
            tile.addView(TextView(this).apply {
                text = Store.initials(a.name)
                textSize = 15f
                setTextColor(Color.WHITE)
                typeface = fontHeavy
                gravity = Gravity.CENTER
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(a.color) }
                alpha = if (views.containsKey(a.id) || active) 1f else 0.55f
            }, iconParams())
            tile.addView(tileLabel(a.name, active), labelParams())
            // badge on the avatar's top right corner, the same place on every tile
            val n = unread[a.id] ?: 0
            val avatarRight = (TILE_W + AVATAR_SIZE) / 2
            if (n > 0) {
                tile.addView(TextView(this).apply {
                    text = if (n > 99) "99+" else n.toString()
                    textSize = 10f
                    setTextColor(Color.WHITE)
                    typeface = fontHeavy
                    gravity = Gravity.CENTER
                    setPadding(dp(4), 0, dp(4), 0)
                    minWidth = dp(18)
                    if (n > (shownUnread[a.id] ?: n)) {
                        scaleX = 0.3f; scaleY = 0.3f
                        animate().scaleX(1f).scaleY(1f).setDuration(320).setInterpolator(OvershootInterpolator(2.5f)).start()
                    }
                    background = GradientDrawable().apply {
                        cornerRadius = dp(9).toFloat(); setColor(accent)
                        setStroke(dp(2), ContextCompat.getColor(context, R.color.bar))
                    }
                }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(18), Gravity.START or Gravity.TOP).apply {
                    leftMargin = dp(avatarRight - 12)
                    topMargin = dp(AVATAR_TOP - 4)
                })
            } else if (a.id in attention) {
                tile.addView(View(this).apply {
                    background = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL; setColor(accent)
                        setStroke(dp(2), ContextCompat.getColor(context, R.color.bar))
                    }
                }, FrameLayout.LayoutParams(dp(12), dp(12), Gravity.START or Gravity.TOP).apply {
                    leftMargin = dp(avatarRight - 10)
                    topMargin = dp(AVATAR_TOP - 1)
                })
            }
            if (a.id !in shownTiles) {
                tile.alpha = 0f
                tile.translationX = -dp(12).toFloat()
                tile.animate().alpha(1f).translationX(0f).setDuration(240).start()
            }
            strip.addView(tile)
        }
        strip.addView(toolTile("+", "Добавить") { editAccount(null) })
        shownUnread.clear()
        store.accounts.forEach { shownUnread[it.id] = unread[it.id] ?: 0 }
        shownTiles.clear()
        store.accounts.forEach { shownTiles += it.id }
        shownActive = store.active
        val showWelcome = store.accounts.isEmpty()
        if (showWelcome && welcome.visibility != View.VISIBLE) {
            welcome.alpha = 0f
            welcome.animate().alpha(1f).setDuration(260).start()
            // logo, title and features rise one after another
            for (i in 0 until welcomeContent.childCount) {
                val v = welcomeContent.getChildAt(i)
                v.alpha = 0f
                v.translationY = dp(14).toFloat()
                v.animate().alpha(1f).translationY(0f).setStartDelay(60L * i).setDuration(360)
                    .setInterpolator(android.view.animation.DecelerateInterpolator(2f)).start()
            }
        }
        welcome.visibility = if (showWelcome) View.VISIBLE else View.GONE
        for ((id, wv) in views) {
            if (id == store.active) {
                if (shownPage != id || wv.visibility != View.VISIBLE) {
                    // the newly opened account fades in over the previous one
                    wv.alpha = 0f
                    wv.visibility = View.VISIBLE
                    wv.bringToFront()
                    wv.animate().alpha(1f).setDuration(180).withEndAction {
                        for ((other, v) in views) if (other != store.active) v.visibility = View.GONE
                    }.start()
                }
            } else if (id != shownPage) {
                wv.visibility = View.GONE
            }
        }
        shownPage = store.active
        Notifier.updateKeepAlive(this, unread.values.sum())
    }

    private fun accountMenu(anchor: View, a: Account) {
        val m = PopupMenu(this, anchor)
        m.menu.add(0, 1, 0, "Изменить")
        m.menu.add(0, 2, 1, "Перезагрузить")
        if (views.containsKey(a.id) && a.id != store.active) m.menu.add(0, 3, 2, "Усыпить сейчас")
        m.menu.add(0, 4, 3, if (a.pinned) "Можно усыплять" else "Не усыплять")
        val i = store.accounts.indexOf(a)
        if (i > 0) m.menu.add(0, 5, 4, "Левее")
        if (i < store.accounts.size - 1) m.menu.add(0, 6, 5, "Правее")
        m.menu.add(0, 7, 6, "Удалить")
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> editAccount(a)
                2 -> views[a.id]?.reload() ?: switchTo(a.id)
                3 -> { sleep(a.id); render() }
                4 -> { a.pinned = !a.pinned; store.save() }
                5, 6 -> {
                    store.accounts.removeAt(i)
                    store.accounts.add((if (it.itemId == 5) i - 1 else i + 1).coerceIn(0, store.accounts.size), a)
                    store.save(); render()
                }
                7 -> confirmRemove(a)
            }
            true
        }
        m.show()
    }

    private fun editAccount(a: Account?) {
        if (a == null && !multiProfile && store.accounts.isNotEmpty()) {
            AlertDialog.Builder(this)
                .setTitle("Нужно обновить WebView")
                .setMessage("Второй аккаунт требует Android System WebView версии 128 или новее (отдельные профили). Обновите его в Google Play и откройте Gemspace снова.")
                .setPositiveButton("Понятно", null).show()
            return
        }
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(8), dp(22), 0) }
        val name = EditText(this).apply {
            hint = "Название, например Продажи"; setText(a?.name ?: ""); inputType = InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }
        box.addView(name)
        var color = a?.color ?: Store.COLORS[store.accounts.size % Store.COLORS.size]
        val colors = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(14), 0, dp(6)) }
        fun paint() {
            for (k in 0 until colors.childCount) {
                val c = Store.COLORS[k]
                colors.getChildAt(k).background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL; setColor(c)
                    if (c == color) setStroke(dp(3), ContextCompat.getColor(this@MainActivity, R.color.fg))
                }
            }
        }
        Store.COLORS.forEach { c ->
            colors.addView(View(this).apply {
                layoutParams = LinearLayout.LayoutParams(dp(30), dp(30)).apply { marginEnd = dp(6) }
                setOnClickListener { color = c; paint() }
            })
        }
        paint()
        box.addView(colors)
        AlertDialog.Builder(this)
            .setTitle(if (a == null) "Новый аккаунт" else "Аккаунт")
            .setView(box)
            .setPositiveButton(if (a == null) "Добавить и войти" else "Сохранить") { _, _ ->
                val n = name.text.toString().trim()
                if (a == null) {
                    val acc = Account(store.newId(), n.ifEmpty { "Аккаунт ${store.accounts.size + 1}" }, color)
                    store.accounts += acc
                    store.save()
                    switchTo(acc.id)
                } else {
                    if (n.isNotEmpty()) a.name = n
                    a.color = color
                    store.save(); render()
                }
            }
            .setNegativeButton("Отмена", null)
            .show()
    }

    private fun confirmRemove(a: Account) {
        AlertDialog.Builder(this)
            .setTitle("Удалить аккаунт?")
            .setMessage("«${a.name}» исчезнет из Gemspace, его данные на телефоне будут стёрты. Сам аккаунт Gem Space останется, войти можно снова.")
            .setPositiveButton("Удалить") { _, _ -> remove(a) }
            .setNegativeButton("Отмена", null)
            .show()
    }

    private fun openSettings() {
        val s = store.settings
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(8), dp(22), 0) }
        fun check(label: String, value: Boolean) = CheckBox(this).apply { text = label; isChecked = value }.also { box.addView(it) }
        val notif = check("Уведомления о новых сообщениях", s.notifications)
        val preview = check("Текст сообщения в уведомлении", s.notifyPreview)
        val keep = check("Работать в фоне (значок в шторке, уведомления не теряются)", s.keepAlive)
        val sleepOn = check("Спящий режим: выгружать давно не открытые аккаунты", s.sleepEnabled)
        box.addView(TextView(this).apply { text = "Сколько аккаунтов держать загруженными"; setPadding(0, dp(10), 0, 0) })
        val max = EditText(this).apply { inputType = InputType.TYPE_CLASS_NUMBER; setText(s.maxAwake.toString()) }
        box.addView(max)
        box.addView(TextView(this).apply {
            text = "Спящий аккаунт не присылает уведомлений, пока его не открыть. Открытый и отмеченные «Не усыплять» не засыпают.\n\nGemspace ${BuildConfig.VERSION_NAME}. Новые версии проверяются сами при запуске. Внутри обычная веб-версия Gem Space, Gemspace её не изменяет."
            textSize = 12f; setPadding(0, dp(8), 0, dp(8))
            setTextColor(ContextCompat.getColor(context, R.color.muted))
        })
        AlertDialog.Builder(this)
            .setTitle("Настройки")
            .setView(box)
            .setPositiveButton("Сохранить") { _, _ ->
                s.notifications = notif.isChecked
                s.notifyPreview = preview.isChecked
                s.keepAlive = keep.isChecked
                s.sleepEnabled = sleepOn.isChecked
                s.maxAwake = (max.text.toString().toIntOrNull() ?: 4).coerceIn(1, 30)
                store.save()
                enforceSleep()
                updateKeepAlive()
                render()
            }
            .setNegativeButton("Отмена", null)
            .setNeutralButton("Обновления") { _, _ -> Updater.checkNow(this) }
            .show()
    }

    // ---------- accounts ----------

    private fun switchTo(id: String) {
        store.active = id
        store.save()
        attention.remove(id)
        Notifier.cancel(this, id)
        val wv = views[id] ?: createWebView(id)
        if (wv != null) {
            views[id] // touch: most recently used
            wv.requestFocus()
        }
        enforceSleep()
        render()
    }

    private fun profileName(id: String) = "acc-$id"

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(id: String): WebView? {
        if (!multiProfile && store.accounts.firstOrNull()?.id != id) {
            Toast.makeText(this, "Нужен Android System WebView 128+, работает только первый аккаунт", Toast.LENGTH_LONG).show()
            return null
        }
        val wv = WebView(this)
        if (multiProfile) {
            // must happen before the WebView is used in any other way
            WebViewCompat.setProfile(wv, profileName(id))
        }
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // look like mobile Chrome: some sites refuse the WebView marker
            userAgentString = userAgentString.replace("; wv", "").replace(Regex("Version/\\S+ "), "")
        }
        cookieManagerFor(id).setAcceptThirdPartyCookies(wv, true)

        val origins = setOf("https://web.gemspace.com", "https://*.gemspace.com")
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(wv, injectJs, origins)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(wv, "GemspaceBridge", origins) { _, message, _, isMainFrame, _ ->
                if (isMainFrame) onBridgeMessage(id, message.data)
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (!request.isForMainFrame) return false
                val host = url.host ?: return false
                if (url.scheme == "https" && (host == "gemspace.com" || host.endsWith(".gemspace.com"))) return false
                openExternal(url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) view.evaluateJavascript(injectJs, null)
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String?) {
                val n = Store.unreadFromTitle(title)
                if (unread[id] != n) {
                    // everything read in Gem Space: the account's messages leave the feed. Only on a drop
                    // to zero, so a page whose title shows no count never empties the feed.
                    if (n == 0 && (unread[id] ?: 0) > 0) feed.clear(id)
                    unread[id] = n
                    render()
                }
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    pickFiles.launch(params.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                val need = mutableListOf<String>()
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources) need += Manifest.permission.RECORD_AUDIO
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources) need += Manifest.permission.CAMERA
                if (need.isEmpty()) { request.deny(); return }
                val missing = need.filter { !hasPerm(it) }
                if (missing.isEmpty()) {
                    request.grant(request.resources.filter {
                        it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                    }.toTypedArray())
                } else {
                    pendingPermission?.deny()
                    pendingPermission = request
                    askMedia.launch(missing.toTypedArray())
                }
            }
        }
        wv.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            download(id, url, userAgent, contentDisposition, mimeType)
        }
        pages.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        views[id] = wv
        wv.loadUrl(GEM_URL)
        return wv
    }

    private fun cookieManagerFor(id: String): CookieManager =
        if (multiProfile) ProfileStore.getInstance().getOrCreateProfile(profileName(id)).cookieManager else CookieManager.getInstance()

    private fun onBridgeMessage(id: String, data: String?) {
        val o = try { JSONObject(data ?: return) } catch (e: Exception) { return }
        if (o.optString("t") != "notify") return
        val account = store.find(id) ?: return
        val added = feed.push(id, o.optString("title"), o.optString("body"), o.optString("nid"), System.currentTimeMillis())
        if (!added) return
        val visible = resumed && store.active == id
        if (store.active != id) attention += id
        render()
        if (visible) return
        if (!store.settings.notifications) return
        val title = o.optString("title").take(120)
        val body = if (store.settings.notifyPreview) o.optString("body").take(300) else "Новое сообщение"
        Notifier.message(this, account, title, body)
    }

    private fun enforceSleep() {
        if (!store.settings.sleepEnabled) return
        val limit = store.settings.maxAwake
        val sleepable = views.keys.filter { it != store.active && store.find(it)?.pinned != true }
        val fixed = views.size - sleepable.size
        val extra = sleepable.size - (limit - fixed).coerceAtLeast(0)
        sleepable.take(extra.coerceAtLeast(0)).forEach { sleep(it) }
    }

    private fun sleep(id: String) {
        val wv = views.remove(id) ?: return
        pages.removeView(wv)
        wv.destroy()
    }

    private fun remove(a: Account) {
        sleep(a.id)
        store.accounts.remove(a)
        unread.remove(a.id)
        attention.remove(a.id)
        feed.clear(a.id)
        Notifier.cancel(this, a.id)
        if (multiProfile) {
            // the profile can be deleted only once no WebView uses it; the destroy above is processed on the next frames
            pages.postDelayed({
                try { ProfileStore.getInstance().deleteProfile(profileName(a.id)) } catch (e: Exception) { }
            }, 1500)
        } else {
            CookieManager.getInstance().removeAllCookies(null)
            android.webkit.WebStorage.getInstance().deleteAllData()
        }
        if (store.active == a.id) store.active = null
        store.save()
        val next = store.active ?: store.accounts.firstOrNull()?.id
        if (next != null) switchTo(next) else render()
    }

    private fun updateKeepAlive() {
        val i = Intent(this, KeepAliveService::class.java)
        if (store.settings.keepAlive && store.accounts.isNotEmpty()) {
            ContextCompat.startForegroundService(this, i)
        } else {
            stopService(i)
        }
    }

    private fun download(id: String, url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        if (!url.startsWith("http")) {
            Toast.makeText(this, "Этот файл можно сохранить только из меню самого Gem Space", Toast.LENGTH_LONG).show()
            return
        }
        try {
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val req = DownloadManager.Request(Uri.parse(url))
                .setMimeType(mimeType)
                .addRequestHeader("User-Agent", userAgent)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            cookieManagerFor(id).getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
            getSystemService(DownloadManager::class.java).enqueue(req)
            Toast.makeText(this, "Скачивается: $name", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Не удалось скачать файл", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "Нечем открыть ссылку", Toast.LENGTH_SHORT).show()
        }
    }

    private fun hasPerm(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    companion object {
        const val GEM_URL = "https://web.gemspace.com/"

        // geometry of the bar tiles, dp
        private const val TILE_W = 62
        private const val TILE_H = 66
        private const val AVATAR_SIZE = 44
        private const val AVATAR_TOP = 5
        private const val RING_SIZE = 52
    }
}
