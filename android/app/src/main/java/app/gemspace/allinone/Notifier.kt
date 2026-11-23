package app.gemspace.allinone

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object Notifier {
    const val EXTRA_ACCOUNT = "account"
    private const val CH_MESSAGES = "messages"
    const val CH_SERVICE = "service"
    const val SERVICE_ID = 1

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CH_MESSAGES, "Сообщения", NotificationManager.IMPORTANCE_HIGH)
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_SERVICE, "Работа в фоне", NotificationManager.IMPORTANCE_MIN).apply {
                setShowBadge(false)
            }
        )
    }

    private fun idFor(accountId: String) = 1000 + (accountId.hashCode() and 0xFFFFF)

    fun openIntent(ctx: Context, accountId: String?): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (accountId != null) i.putExtra(EXTRA_ACCOUNT, accountId)
        val code = accountId?.let { idFor(it) } ?: 0
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** One notification per account; a new message replaces the previous one of that account. */
    fun message(ctx: Context, account: Account, title: String, body: String) {
        val heading = if (title.isEmpty()) account.name else "${account.name} · $title"
        val n = NotificationCompat.Builder(ctx, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setColor(account.color)
            .setContentTitle(heading)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openIntent(ctx, account.id))
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(idFor(account.id), n)
        } catch (e: SecurityException) {
            // notifications are not allowed
        }
    }

    fun cancel(ctx: Context, accountId: String) {
        NotificationManagerCompat.from(ctx).cancel(idFor(accountId))
    }

    fun serviceNotification(ctx: Context, unread: Int) =
        NotificationCompat.Builder(ctx, CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Gemspace на связи")
            .setContentText(if (unread > 0) "Непрочитанных: $unread" else "Аккаунты получают сообщения")
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(openIntent(ctx, null))
            .build()

    fun updateKeepAlive(ctx: Context, unread: Int) {
        if (!KeepAliveService.running) return
        try {
            NotificationManagerCompat.from(ctx).notify(SERVICE_ID, serviceNotification(ctx, unread))
        } catch (e: SecurityException) {
        }
    }
}
