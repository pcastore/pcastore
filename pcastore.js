/**
 * gamestore-auth-worker.js
 *
 * Standalone Cloudflare Worker — Telegram login for the PCA Store customer
 * website (pcagamestore_bot). Kept completely separate from the existing
 * telegram-order worker (which uses the admin/order bot) on purpose.
 *
 * Endpoints:
 *   POST /auth/miniapp       { initData: string }
 *   POST /auth/widget        { id, first_name, last_name?, username?, photo_url?, auth_date, hash }
 *   POST /notify-connected   { telegramId, guestId, name, balance } — pushes a
 *                             "Telegram Connected" DM (called from index.html
 *                             right after a first-time Telegram link)
 *   POST /telegram-webhook   Telegram Bot API update — /start, /menu, /help,
 *                             an inline_query handler (handleInlineQuery,
 *                             requires /setinline enabled via BotFather —
 *                             lets anyone type "@pcagamestore_bot <text>" in
 *                             any chat to search games and drop an "Open
 *                             PCA Store" link, no need to open the bot chat)
 *                             and the Shop/Game List/Wallet/My Orders/My
 *                             Account/Top Up Wallet/Help Center/Available
 *                             Games/Open PCA Store reply keyboard for
 *                             pcagamestore_bot, including:
 *                               - "📋 Available Games": asks Top Up or
 *                                 Voucher, then sends a flat, monospace
 *                                 (tap-to-copy) list of that category's game
 *                                 names via sendAvailableGamesList() — lets
 *                                 a customer copy a name and paste it after
 *                                 "@pcagamestore_bot" for inline search,
 *                                 instead of paging through Game List
 *                               - an in-chat Wallet Top Up flow (amount ->
 *                                 payment method -> confirm -> receipt
 *                                 photo) that writes the same
 *                                 "walletTopups" Firestore doc store.html
 *                                 does and pings the order-approval Worker
 *                                 so the existing admin Confirm/Reject flow
 *                                 picks it up. The confirm step shows the
 *                                 amount + method picked with ✅ Confirm /
 *                                 ✏️ Edit buttons before ever asking for a
 *                                 receipt; "🔙 Change Amount" and
 *                                 "🔙 Change Method" are available on both
 *                                 the confirm step and the receipt prompt,
 *                                 so a wrong amount/method no longer means
 *                                 Cancel + restart from scratch. If the
 *                                 receipt upload itself fails (image storage down,
 *                                 etc.), the customer gets a "🔄
 *                                 ထပ်ကြိုးစားမည်" button that retries the
 *                                 exact same photo (its file_id is stashed
 *                                 on the session) instead of forcing a
 *                                 re-send. A session left mid-flow for 18
 *                                 minutes (2 min before the 20-min
 *                                 SESSION_TIMEOUT_MS) gets a one-time "⏰ 2
 *                                 minutes left" DM via the `scheduled`
 *                                 export/warnExpiringTopupSessions() below
 *                                 — requires a Cron Trigger added to
 *                                 wrangler.toml (see the comment on
 *                                 `scheduled` in the default export)
 *                               - an in-chat Game List flow ("gl:" callback
 *                                 data): Top Up / Voucher -> genre filter
 *                                 chips (All / MOBA / Battle Royale /
 *                                 Survival / Fun / Creative — same ids as
 *                                 index.html's GAME_CATEGORIES, filtering on
 *                                 each game's `category` field) -> paged
 *                                 game list (grouped by name; a game with
 *                                 2+ server/region uploads shows as
 *                                 "Name (N)") -> server picker for
 *                                 multi-server games -> a web_app "Open in
 *                                 App" button pointed at
 *                                 "<STORE_URL>?game=<id>", which index.html
 *                                 already deep-links straight into that
 *                                 game's product card
 *                               - "🛒 Buy Account" currently always replies
 *                                 "Coming Soon" — the in-chat account
 *                                 marketplace itself isn't built yet, this
 *                                 is just the placeholder + the broadcast
 *                                 hook below
 *                               - Help Center now also offers "❓ FAQ" (a
 *                                 static bot-answered list, FAQ_ITEMS,
 *                                 which itself now ends with a "💬 Help
 *                                 Center" shortcut button back out) and
 *                                 "🔍 Track my order" (look up any order by
 *                                 exact ID via lookupOrderById(), not just
 *                                 the 5 most recent)
 *                               - "🌐 Language" is now also a persistent
 *                                 keyboard button (sendLanguagePicker()),
 *                                 not just the /language command
 *                               - "📦 My Orders" now attaches a "🧾 details"
 *                                 inline button per order (handleOrderDetail
 *                                 Callback) showing the full timeline/date/
 *                                 payment method/receipt for that one order
 *                             Every /start (or /menu) is upserted into
 *                             Firestore's "telegramBotUsers/{telegramId}"
 *                             (chatId, name, lastSeen) — this is the
 *                             audience list /admin/broadcast below sends to.
 *   POST /admin/broadcast    { secret, text, buttonText?, buttonUrl? } —
 *                             admin-triggered DM to every "telegramBotUsers"
 *                             entry (i.e. everyone who has pressed /start).
 *                             Meant to be called once from admin.html right
 *                             after the admin flips settings/gameAccounts
 *                             .enabled on and publishes listings, to tell
 *                             every bot user "Account ဝယ်လို့ရပါပြီ" — but
 *                             it's a generic broadcaster, so it works for
 *                             any future announcement too. `secret` must
 *                             match ADMIN_BROADCAST_SECRET. Requires
 *                             `text`; `buttonText`+`buttonUrl` are optional
 *                             (adds one web_app "Open in App" button, e.g.
 *                             buttonUrl: STORE_URL). Responds immediately
 *                             ({ ok: true, accepted: true, recipients: N })
 *                             and sends in the background (Worker
 *                             waitUntil) since a large user list can take
 *                             longer than a single request should block on;
 *                             per-recipient failures (bot blocked by that
 *                             user, etc.) are swallowed — a 403 "blocked by
 *                             user" response from Telegram also deletes
 *                             that person's telegramBotUsers entry so
 *                             future broadcasts stop retrying them.
 *                             Point Telegram's
 *                             webhook here after deploy:
 *                             https://api.telegram.org/bot<TOKEN>/setWebhook?url=<this-worker-url>/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
 *   POST /notify-order-status { secret, telegramId, orderId, status, game?,
 *                             price?, note? } — admin-triggered DM to one
 *                             customer when their order's status changes
 *                             (Pending/Processing/Success/Fail), called from
 *                             admin.html's notifyOrderStatusChange() right
 *                             after the "orders/{id}" write that changes it.
 *                             `secret` must match ADMIN_BROADCAST_SECRET
 *                             (same shared secret as /admin/broadcast).
 *                             `telegramId` is users/{uid}.telegramId — for a
 *                             one-on-one Telegram chat chat_id === that id,
 *                             so this doesn't need a telegramBotUsers lookup.
 *                             Also triggers maybeSendLowBalanceAlert(): a
 *                             follow-up DM if the customer's wallet balance
 *                             is now under LOW_BALANCE_THRESHOLD (5,000 MMK).
 *
 *   POST /notify-topup-status { secret, telegramId, amount, status } — DM to
 *                             the customer when an admin confirms/rejects a
 *                             wallet top-up (called by the order Worker's
 *                             notifyTopupCustomer()). Same secret as above.
 *
 * Bot keyboard: "💼 My Wallet" shows the balance with an inline "➕ Top Up
 * Wallet" button; the top-up flow starts only when that button is tapped.
 *
 * /auth/* return: { token: "<firebase custom token>", user: { id, first_name, ... } }
 * The client then calls: signInWithCustomToken(auth, token)
 *
 * Firebase UID used: `tg_<telegram_user_id>` — keep this format in mind when
 * writing Firestore security rules / matching against existing guest data.
 *
 * Required secrets (wrangler secret put ...):
 *   TELEGRAM_BOT_TOKEN     - pcagamestore_bot's bot token (NOT the order bot's)
 *   FIREBASE_PRIVATE_KEY   - service account private key (PEM, \n-escaped is fine)
 *   FIREBASE_CLIENT_EMAIL  - service account client email (used both to mint
 *                            custom tokens AND, for /telegram-webhook, to get
 *                            an OAuth2 access token for read-only Firestore
 *                            REST calls — the service account needs a role
 *                            that can read Firestore, e.g. Cloud Datastore
 *                            User / Firebase Admin)
 *   ADMIN_BROADCAST_SECRET - OPTIONAL fallback only. The live value is read
 *                            from Firestore's settings/adminBroadcast.secret
 *                            (see getAdminBroadcastSecret()) so it can be
 *                            set/rotated from admin.html's Settings page
 *                            without redeploying or touching wrangler/the
 *                            Cloudflare dashboard. This env var is only used
 *                            if that Firestore doc has no `secret` set yet.
 *   TELEGRAM_WEBHOOK_SECRET - OPTIONAL but strongly recommended. Any random
 *                            string (e.g. `openssl rand -hex 32`). Locks
 *                            /telegram-webhook down to requests that actually
 *                            came from Telegram — set it, then register it
 *                            with Telegram by adding &secret_token=<value> to
 *                            the setWebhook URL below. If unset, the check is
 *                            skipped (matches previous behavior).
 *   ADMIN_TELEGRAM_CHAT_ID - OPTIONAL. The admin's own Telegram chat id (for
 *                            a 1:1 bot chat this is just their Telegram user
 *                            id). If set, the Worker DMs that chat a 🚨 alert
 *                            when an unhandled request error or a wallet-topup
 *                            receipt failure happens — see alertAdmin(), which
 *                            retries the Telegram send itself (honoring a 429's
 *                            retry_after) up to 3 times before giving up, so a
 *                            momentary Telegram API hiccup doesn't silently
 *                            drop the alert. If unset, this is a silent no-op.
 *                            The topup-submit rate limit (5/hour/customer,
 *                            checkRateLimit()) now also tells the customer a
 *                            concrete "try again in ~N minutes" instead of a
 *                            vague "please wait".
 *
 * CORS: locked to your storefront origin(s) — default list below, or set the STORE_ORIGINS variable (comma-separated) to change it without editing code.
 */

const ALLOWED_ORIGINS = [
  'https://pcagamestoremm.vercel.app',
];

// To change the allowed website(s) WITHOUT editing code, set the Worker variable
// STORE_ORIGINS to a comma-separated list, e.g. "https://pcagameshop.com,https://www.pcagameshop.com".
// When it is set it replaces the default list above.
function originList(env) {
  const list = String((env && env.STORE_ORIGINS) || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
  return list.length ? list : ALLOWED_ORIGINS;
}

const FIREBASE_AUD =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = buildCorsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (request.method === 'POST' && url.pathname === '/auth/miniapp') {
        return await handleMiniApp(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/auth/widget') {
        return await handleWidget(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/notify-connected') {
        return await handleNotifyConnected(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/admin/broadcast') {
        return await handleAdminBroadcast(request, env, ctx, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/notify-order-status') {
        return await handleOrderStatusNotify(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/notify-topup-status') {
        return await handleTopupStatusNotify(request, env, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
        return await handleTelegramWebhook(request, env, ctx);
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true }, 200, corsHeaders);
      }
      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      console.error('auth-worker error:', err);
      if (ctx) ctx.waitUntil(alertAdmin(env, `${request.method} ${url.pathname} threw`, err));
      return json({ error: 'Internal error' }, 500, corsHeaders);
    }
  },

  // Cron entry point for the wallet-topup session-timeout warning (see
  // warnExpiringTopupSessions() below). Requires a Cron Trigger added to
  // wrangler.toml, e.g.:
  //   [triggers]
  //   crons = ["*/2 * * * *"]
  // Every 2 minutes gives comfortable coverage for a "2 minutes left"
  // warning against the 20-minute SESSION_TIMEOUT_MS. Without a Cron
  // Trigger configured, this export is simply never invoked — no other
  // behavior in the file depends on it.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(warnExpiringTopupSessions(env, ctx));
  },
};

// ---------------------------------------------------------------------------
// Mini App login — verifies Telegram WebApp initData
// ---------------------------------------------------------------------------
async function handleMiniApp(request, env, corsHeaders) {
  const body = await safeJson(request);
  const initData = body && body.initData;
  if (!initData || typeof initData !== 'string') {
    return json({ error: 'Missing initData' }, 400, corsHeaders);
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return json({ error: 'Missing hash' }, 400, corsHeaders);
  params.delete('hash');

  // auth_date freshness check (reject initData older than 24h)
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return json({ error: 'initData expired' }, 401, corsHeaders);
  }

  const dataCheckString = buildDataCheckString(params);

  // secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
  const secretKey = await hmacSha256Raw(
    strToBuf('WebAppData'),
    strToBuf(env.TELEGRAM_BOT_TOKEN)
  );
  const computedHash = await hmacSha256Hex(secretKey, strToBuf(dataCheckString));

  if (!timingSafeEqualHex(computedHash, hash)) {
    return json({ error: 'Invalid hash' }, 401, corsHeaders);
  }

  const userRaw = params.get('user');
  if (!userRaw) return json({ error: 'Missing user in initData' }, 400, corsHeaders);
  const tgUser = JSON.parse(userRaw);

  const token = await mintFirebaseToken(env, tgUser);
  return json({ token, user: tgUser }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Login Widget login — verifies the classic Telegram Login Widget payload
// ---------------------------------------------------------------------------
async function handleWidget(request, env, corsHeaders) {
  const body = await safeJson(request);
  if (!body || !body.id || !body.hash || !body.auth_date) {
    return json({ error: 'Missing widget fields' }, 400, corsHeaders);
  }

  const { hash, ...rest } = body;

  const authDate = parseInt(rest.auth_date, 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return json({ error: 'Login expired' }, 401, corsHeaders);
  }

  const dataCheckString = Object.keys(rest)
    .filter((k) => rest[k] !== undefined && rest[k] !== null)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');

  // secret_key = SHA256(bot_token)  (raw digest bytes, used as HMAC key)
  const secretKey = await sha256Raw(strToBuf(env.TELEGRAM_BOT_TOKEN));
  const computedHash = await hmacSha256Hex(secretKey, strToBuf(dataCheckString));

  if (!timingSafeEqualHex(computedHash, hash)) {
    return json({ error: 'Invalid hash' }, 401, corsHeaders);
  }

  const tgUser = {
    id: rest.id,
    first_name: rest.first_name,
    last_name: rest.last_name,
    username: rest.username,
    photo_url: rest.photo_url,
  };

  const token = await mintFirebaseToken(env, tgUser);
  return json({ token, user: tgUser }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Customer bot menu (pcagamestore_bot) — /start + a persistent reply
// keyboard designed specifically for PCA Store.
// "Account connected! Hi <name>." pattern. Reads live data straight from
// Firestore via a Google OAuth2 (service-account) token, reusing the same
// FIREBASE_PRIVATE_KEY / FIREBASE_CLIENT_EMAIL secrets already used to mint
// custom tokens. Set the webhook once after deploy:
//   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<this-worker-url>/telegram-webhook
// ---------------------------------------------------------------------------
const STORE_URL = 'https://pcagamestoremm.vercel.app';
const WALLET_TOPUP_MIN = 5000;
const WALLET_TOPUP_MAX = 10000000;
// A Top Up flow (amount -> method -> receipt) left mid-way after this long
// is treated as abandoned and auto-cleared, so a stray photo or number sent
// hours/days later doesn't get mistaken for the old flow's next step.
const SESSION_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '🛍️ Shop' }, { text: '🎮 Game List' }],
    [{ text: '📋 Available Games' }, { text: '🛒 Buy Account' }],
    [{ text: '💼 My Wallet' }, { text: '📦 My Orders' }],
    [{ text: '👤 My Account' }, { text: '💬 Help Center' }],
    [{ text: '🌐 Language' }, { text: '📱 Official Mini App', web_app: { url: STORE_URL } }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  one_time_keyboard: false,
};

// The wallet top-up flow's amount step now keeps MAIN_KEYBOARD on screen
// (it used to hide it with remove_keyboard, but that meant the only way
// out was typing /cancel — see cancelInlineKeyboard()/topup_cancel below).
// With the menu buttons visible again, a tap on any of them arrives here
// as plain text while session.step is still 'awaiting_amount', which
// would otherwise be mistaken for an invalid amount. Recognize those
// texts and silently drop the stale topup session instead of blocking
// the tap with a confusing "ပမာဏကို ဂဏန်းနဲ့ ရိုက်ထည့်ပါ" reply.
const MAIN_MENU_TEXTS = new Set([
  '🛍️ Shop', '🎮 Game List', '💼 My Wallet', '📦 My Orders',
  '👤 My Account', '🛒 Buy Account', '💬 Help Center',
  // legacy labels — customers whose Telegram still shows the old keyboard
  '💼 Wallet', '➕ Top Up Wallet',
  '📋 Available Games', '🌐 Language', '/start', '/menu', '/help', '/language',
]);

// Single reusable "❌ Cancel" inline button, attached to every step of the
// wallet top-up flow (amount prompt, payment-method list, receipt prompt)
// so a customer can back out with a tap instead of having to know/type
// /cancel. Routed through the shared 'topup_cancel' callback below.
// Quick-pick amount grid for the wallet top-up flow. Page 1 = 4 rows (2 per
// row): 5,000 / 10,000 / 30,000 / 50,000 / 100,000 / 150,000 / 250,000 + "More".
// Page 2 = 200,000 -> 1,000,000 in 50,000 steps. Typing an amount by hand
// still works at every point (handleTopupAmount validates min/max).
const TOPUP_QUICK_AMOUNTS = [5000, 10000, 30000, 50000, 100000, 150000, 250000];
function topupAmountRows(page) {
  const label = (n) => n.toLocaleString('en-US');
  const btn = (n) => ({ text: label(n), callback_data: `topup_amt:${n}` });
  if (page === 2) {
    const amounts = [];
    for (let n = 200000; n <= 1000000; n += 50000) amounts.push(n);
    const rows = [];
    const cells = [...amounts.map(btn), { text: '🔙 Back', callback_data: 'topup_amt_page:1' }]; // 17 amounts + Back = 18 = 6 even rows of 3
    for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3));
    return rows;
  }
  const rows = [];
  for (let i = 0; i < TOPUP_QUICK_AMOUNTS.length; i += 2) rows.push(TOPUP_QUICK_AMOUNTS.slice(i, i + 2).map(btn));
  rows[rows.length - 1].push({ text: '➕ More', callback_data: 'topup_amt_page:2' });
  return rows;
}

// Row of Telegram-native copy buttons for a payment method's number + account name.
// Empty array when neither is known (callers filter empty rows out).
function paymentCopyRow(number, accountName) {
  const row = [];
  const n = String(number || '').replace(/[\s-]/g, '').slice(0, 256);
  const a = String(accountName || '').slice(0, 256);
  if (n) row.push({ text: '📋 Copy Number', copy_text: { text: n } });
  if (a) row.push({ text: '📋 Copy Name', copy_text: { text: a } });
  return row;
}

function cancelInlineKeyboard(extraRows) {
  return { inline_keyboard: [...(extraRows || []), [{ text: '❌ Cancel', style: 'danger', callback_data: 'topup_cancel' }]] };
}

// ---------------------------------------------------------------------------
// "🎮 Game List" — in-chat Top Up / Voucher browser.
//
// Tap Game List -> pick "Top Up" or "Voucher" -> pick a genre filter chip
// (All / MOBA / Battle Royale / Survival / Fun / Creative — GAME_GENRES
// below, same ids as index.html's GAME_CATEGORIES) -> a paged list of games
// (grouped by name, same grouping rule store.html uses: two uploads that
// share a name are just different servers/regions of the same game) ->
// tapping a single-server game jumps straight to "Open in App"; tapping a
// multi-server one (e.g. "Mobile Legends (9)") shows its 9 servers first.
// The final "Open in App" button is a web_app inline button pointed at
// "<STORE_URL>?game=<id>" — index.html already has deep-link handling for
// that exact query param (tryOpenPendingPackageDeepLink), so the Mini App
// opens straight into that game's product/package card instead of the
// store's home page.
//
// Entirely stateless: every tap re-reads the "games" collection (+
// settings/providerFlags) from Firestore and recomputes the same
// group/sort/filter the storefront itself uses, so the list always
// reflects whatever the admin panel currently has live and nothing needs
// to be cached in telegramBotSessions for this flow.
// ---------------------------------------------------------------------------
const GAME_LIST_CATEGORIES = { topup: '⚡ Top Up', voucher: '🎁 Voucher / Gift Card' };
const GAME_LIST_PAGE_SIZE = 8;

// Game-genre filter chips, shown after Top Up/Voucher is picked — mirrors
// index.html's GAME_CATEGORIES (same ids, so a game tagged there filters
// correctly here too). Telegram has no colored chip UI, so each genre is
// just an emoji-prefixed inline button instead of an icon+color pill.
const GAME_GENRES = [
  { id: 'moba', label: '🎯 MOBA' },
  { id: 'battle_royale', label: '🚀 Battle Royale' },
  { id: 'survival', label: '🧭 Survival' },
  { id: 'fun', label: '😊 Fun' },
  { id: 'creative', label: '🪶 Creative' },
];
function findGenre(id) { return GAME_GENRES.find((g) => g.id === id); }

function openAppInlineKeyboard() {
  return { inline_keyboard: [[{ text: '🚀 Open PCA Store', style: 'primary', web_app: { url: STORE_URL } }]] };
}

async function handleTelegramWebhook(request, env, ctx) {
  // Verify this request actually came from Telegram. Set env.TELEGRAM_WEBHOOK_SECRET
  // (any random string, e.g. `openssl rand -hex 32`) then register it once via:
  //   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<this-worker-url>/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
  // Telegram echoes it back on every update in the X-Telegram-Bot-Api-Secret-Token
  // header; without this check, anyone who finds the webhook URL can POST fake
  // updates (fake /start, fake wallet topups, etc.) straight into the bot.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!timingSafeEqualStr(provided, env.TELEGRAM_WEBHOOK_SECRET)) {
      console.error('telegram-webhook: bad secret token');
      return json({ ok: true }, 200, { 'Content-Type': 'application/json' });
    }
  }

  const update = await safeJson(request);

  // Stop the button spinner immediately — runs in parallel with everything below.
  if (update && update.callback_query) {
    const ackTask = ackCallbackNow(env, update.callback_query);
    if (ctx) ctx.waitUntil(ackTask);
  }

  // Telegram retries a webhook delivery if it doesn't get a fast 200 (cold
  // start, transient error, etc.), which can replay the same update_id —
  // without this, a replayed wallet-topup photo would create a second
  // walletTopups doc for the same payment.
  if (update && update.update_id !== undefined) {
    const isNew = await claimUpdateOnce(env, update.update_id);
    if (!isNew) return json({ ok: true }, 200, { 'Content-Type': 'application/json' });
  }

  try {
    const msg = update && update.message;
    if (msg && msg.text) await routeTelegramMessage(env, msg);
    else if (msg && msg.photo) await routeTelegramPhoto(env, msg, ctx);
    else if (update && update.callback_query) await routeTelegramCallback(env, update.callback_query, ctx);
    else if (update && update.inline_query) await handleInlineQuery(env, update.inline_query);
  } catch (e) {
    console.error('telegram-webhook error:', e);
    if (ctx) ctx.waitUntil(alertAdmin(env, 'telegram-webhook update failed', e));
  }
  // Always 200 — Telegram retries on non-2xx, we never want that for a
  // best-effort bot menu.
  return json({ ok: true }, 200, { 'Content-Type': 'application/json' });
}

// ---------------------------------------------------------------------------
// Bilingual message strings (Burmese default / English opt-in via
// /language). Deliberately scoped to the core menu flow below — /start,
// /help, the main-keyboard replies, cancel/flood/session messages — rather
// than every string in the file (the Game List browser and the in-chat
// wallet top-up walkthrough are unchanged/Burmese-only for now). Add new
// entries here the same way to extend coverage later.
// ---------------------------------------------------------------------------
const MESSAGES = {
  cancelled: { my: 'ပယ်ဖျက်လိုက်ပါပြီ။', en: 'Cancelled.' },
  flooded: {
    my: 'ခဏစောင့်ပေးပါ 🙏 Message အရမ်းများနေလို့ ခဏနားပြီးမှ ပြန်ရိုက်ပါ။',
    en: "Please slow down a bit 🙏 That's a lot of messages — try again shortly.",
  },
  welcomeBack: {
    my: (name) => `မင်္ဂလာပါ ${name} 👋\n\nPCA Store မှာ ဂိမ်း Top Up နဲ့ Voucher ဝန်ဆောင်မှုတွေကို လွယ်ကူစွာ အသုံးပြုနိုင်ပါပြီ။\n\nအောက်က Quick Menu ကနေ လိုအပ်တာကို ရွေးချယ်ပါ။`,
    en: (name) => `Welcome back, ${name} 👋\n\nTop up games and buy vouchers on PCA Store, right from this chat.\n\nPick what you need from the Quick Menu below.`,
  },
  welcomeNew: {
    my: 'မင်္ဂလာပါ 👋\n\nPCA Store ကို အသုံးပြုရန် App ထဲက "Log in with Telegram" ကို အရင်နှိပ်ပြီး account ချိတ်ဆက်ပေးပါ။',
    en: 'Welcome 👋\n\nTo use PCA Store, first tap "Log in with Telegram" inside the app to link your account.',
  },
  help: {
    my: 'PCA Store Help Center\n\n🛍️ Shop — Store App ကို တိုက်ရိုက်ဖွင့်ရန်\n🎮 Game List — Top Up / Voucher ခွဲပြီး ဂိမ်းရွေးရန်\n💼 My Wallet — လက်ကျန်ငွေစစ်ရန်နှင့် Wallet ဖြည့်ရန်\n📦 My Orders — အော်ဒါအခြေအနေကြည့်ရန်\n\nဘာသာစကားပြောင်းရန် /language ကို ရိုက်ပါ။\nမေးမြန်းလိုပါက Help Center ကို အသုံးပြုပါ။',
    en: 'PCA Store Help Center\n\n🛍️ Shop — open the Store app directly\n🎮 Game List — browse Top Up / Voucher by game\n💼 My Wallet — check your balance and add funds\n📦 My Orders — check order status\n\nSend /language to switch languages.\nUse Help Center for anything else.',
  },
  notConnected: {
    my: 'Account မချိတ်ဆက်ရသေးပါ။ App ထဲက Telegram Login ကို အရင်သုံးပြီး /start ကို ပြန်နှိပ်ပါ။',
    en: 'Account not linked yet. Use Telegram Login inside the app first, then send /start again.',
  },
  shopPrompt: {
    my: '🛍️ PCA Store ကို ဖွင့်ပြီး ဂိမ်း၊ Package သို့မဟုတ် Voucher ကို ရွေးချယ်ပါ။',
    en: '🛍️ Open PCA Store and pick a game, package, or voucher.',
  },
  buyAccountComingSoon: {
    my: '🛒 Buy Account\n\n🚧 မကြာမီ လာမည် (Coming Soon)!\n\nဂိမ်း Account ဝယ်ယူခြင်း ဝန်ဆောင်မှုကို ပြင်ဆင်နေဆဲဖြစ်ပါသည်။ အသင့်ဖြစ်သည်နှင့် ဒီ Chat ထဲကို အကြောင်းကြားပေးပါမယ်။',
    en: "🛒 Buy Account\n\n🚧 Coming soon!\n\nThe in-chat game account marketplace is still being built. We'll message you right here as soon as it's ready.",
  },
  wallet: {
    my: (balance) => `💼 My Wallet\n\nလက်ကျန်ငွေ: ${balance} MMK`,
    en: (balance) => `💼 My Wallet\n\nBalance: ${balance} MMK`,
  },
  account: {
    my: (acct) => `👤 My Account\n\nAccount ID: ${acct.guestId}\nName: ${acct.name || '-'}\nWallet: ${Number(acct.walletBalance || 0).toLocaleString()} MMK`,
    en: (acct) => `👤 My Account\n\nAccount ID: ${acct.guestId}\nName: ${acct.name || '-'}\nWallet: ${Number(acct.walletBalance || 0).toLocaleString()} MMK`,
  },
  ordersEmpty: { my: '📦 Order မှတ်တမ်း မရှိသေးပါ။', en: "📦 You don't have any orders yet." },
  ordersHeader: { my: (count) => `📦 My Orders (latest ${count})`, en: (count) => `📦 My Orders (latest ${count})` },
  topupPrompt: {
    my: (min, max) => `➕ Wallet ဖြည့်ရန်\n\nဖြည့်ချင်တဲ့ ပမာဏကို ခလုတ်နှိပ်ရွေးပါ၊ ဒါမှမဟုတ် ကိုယ်တိုင်ရိုက်ထည့်နိုင်ပါတယ် (${min} - ${max} MMK)\n\nရပ်ချင်ရင် /cancel ကို ရိုက်ပါ။`,
    en: (min, max) => `➕ Top Up Wallet\n\nPick an amount below, or type your own (${min} - ${max} MMK)\n\nSend /cancel to stop.`,
  },
  helpCenter: {
    my: '💬 Help Center\n\nအော်ဒါ၊ ငွေပေးချေမှု သို့မဟုတ် account ပြဿနာရှိပါက Support ကို ဆက်သွယ်ပါ။',
    en: '💬 Help Center\n\nContact Support for anything about orders, payments, or your account.',
  },
  fallback: {
    my: 'နားမလည်ပါ 🤔 အောက်က Menu ထဲကနေ ရွေးချယ်ပေးပါ။',
    en: "Sorry, I didn't get that 🤔 Please pick an option from the menu below.",
  },
  languagePrompt: { my: '🌐 ဘာသာစကား ရွေးချယ်ပါ:', en: '🌐 Choose your language:' },
  languageSet: { my: '✅ ဘာသာစကားကို မြန်မာလို ပြောင်းလိုက်ပါပြီ။', en: '✅ Language switched to English.' },
  topupExpired: {
    my: 'Top Up flow ကုန်သွားပါပြီ (သို့) မစသေးပါ။ 💼 My Wallet ထဲက Top Up Wallet ကနေ ပြန်စပေးပါ။',
    en: 'That top-up flow has expired or was never started. Start again from 💼 My Wallet → Top Up Wallet.',
  },
  topupRateLimited: {
    my: (mins) => `Top Up တောင်းဆိုမှု အများကြီး ပို့ထားပါပြီ။ ${mins} မိနစ်အကြာမှ ထပ်ကြိုးစားပေးပါ၊ သို့မဟုတ် Help Center ကို ဆက်သွယ်ပါ။`,
    en: (mins) => `You've sent a lot of top-up requests. Please try again in about ${mins} minute${mins === 1 ? '' : 's'}, or contact Help Center.`,
  },
  receiptProcessing: { my: 'Receipt ကို လက်ခံရရှိပါပြီ၊ စစ်ဆေးနေပါတယ်...', en: 'Receipt received, checking it now...' },
  topupSuccess: {
    my: (amount) => `✅ Top Up Request ပို့ပြီးပါပြီ\n\nပမာဏ: ${amount} MMK\n\nAdmin စစ်ဆေးပြီးရင် Wallet ထဲ ပေါင်းထည့်ပေးပါမယ်။`,
    en: (amount) => `✅ Top-up request sent\n\nAmount: ${amount} MMK\n\nWe'll add it to your wallet once our admin verifies it.`,
  },
  receiptFailed: {
    my: 'Receipt တင်ရာတွင် အမှားရှိပါသည်။ ထပ်မံကြိုးစားပေးပါ။',
    en: 'Something went wrong uploading the receipt. Please try again.',
  },
};

function t(lang, key, ...args) {
  const entry = MESSAGES[key];
  if (!entry) return '';
  const variant = entry[lang] || entry.my;
  return typeof variant === 'function' ? variant(...args) : variant;
}

// Shared by the /language command and the "🌐 Language" keyboard button
// (added so language switching doesn't require knowing the slash command).
async function sendLanguagePicker(env, chatId, telegramId) {
  return sendTelegramMessage(env, chatId, t(await getLanguage(env, telegramId), 'languagePrompt'), {
    inline_keyboard: [[
      { text: '🇲🇲 မြန်မာ', callback_data: 'lang:my' },
      { text: '🇬🇧 English', callback_data: 'lang:en' },
    ]],
  });
}

async function routeTelegramMessage(env, msg) {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const text = (msg.text || '').trim();

  if (text === '/cancel') {
    await clearBotSession(env, telegramId);
    const lang = await getLanguage(env, telegramId);
    return sendTelegramMessage(env, chatId, t(lang, 'cancelled'), MAIN_KEYBOARD);
  }

  // General flood guard — 20 messages/minute per user. Generous enough that
  // no real customer ever notices it; just stops a runaway client/script
  // from hammering Firestore + the Telegram API on every request.
  if (await isRateLimited(env, telegramId, 'message', { maxCount: 20, windowMs: 60 * 1000 })) {
    const lang = await getLanguage(env, telegramId);
    return sendTelegramMessage(env, chatId, t(lang, 'flooded'));
  }

  if (text === '/language' || text === '🌐 Language') {
    return sendLanguagePicker(env, chatId, telegramId);
  }

  // A wallet top-up flow in progress takes priority over every other
  // command/keyboard button — the person is mid-conversation with the bot
  // (typing an amount, or about to pick a payment method), so route them
  // there first instead of falling through to the menu matching below.
  const session = await getBotSession(env, telegramId);
  if (session && session.step === 'awaiting_amount' && text) {
    if (MAIN_MENU_TEXTS.has(text)) {
      await clearBotSession(env, telegramId);
      // fall through to normal command/menu routing below
    } else {
      return handleTopupAmount(env, chatId, telegramId, text);
    }
  }
  if (session && session.step === 'awaiting_order_id' && text) {
    if (MAIN_MENU_TEXTS.has(text)) {
      await clearBotSession(env, telegramId);
      // fall through to normal command/menu routing below
    } else {
      return handleTrackOrderId(env, chatId, telegramId, text);
    }
  }

  const lang = await getLanguage(env, telegramId);

  if (text === '/start' || text === '/menu') {
    await trackBotUser(env, telegramId, chatId, msg.from);
    const acct = await lookupAccountByTelegramId(env, telegramId);
    if (acct) {
      const name = acct.name || acct.telegramUsername || msg.from.first_name || 'Player';
      return sendTelegramMessage(env, chatId, t(lang, 'welcomeBack', name), MAIN_KEYBOARD);
    }
    return sendTelegramMessage(env, chatId, t(lang, 'welcomeNew'), openAppInlineKeyboard());
  }

  if (text === '/help') {
    return sendTelegramMessage(env, chatId, t(lang, 'help'), MAIN_KEYBOARD);
  }

  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) return sendTelegramMessage(env, chatId, t(lang, 'notConnected'));

  if (text === '🛍️ Shop') {
    return sendTelegramMessage(env, chatId, t(lang, 'shopPrompt'), openAppInlineKeyboard());
  }
  if (text === '🎮 Game List') {
    return sendGameListCategoryMenu(env, chatId);
  }
  if (text === '📋 Available Games') {
    return sendAvailableGamesCategoryMenu(env, chatId);
  }
  if (text === '🛒 Buy Account') {
    return sendTelegramMessage(env, chatId, t(lang, 'buyAccountComingSoon'), MAIN_KEYBOARD);
  }
  // "💼 My Wallet" (old keyboards may still send "💼 Wallet"): show the balance,
  // with a "➕ Top Up Wallet" inline button underneath. The top-up flow only
  // starts when that button is tapped (callback 'wallet:topup' below).
  if (text === '💼 My Wallet' || text === '💼 Wallet') {
    return sendTelegramMessage(
      env, chatId,
      t(lang, 'wallet', Number(acct.walletBalance || 0).toLocaleString()),
      { inline_keyboard: [[{ text: '➕ Top Up Wallet', style: 'success', callback_data: 'wallet:topup' }]] }
    );
  }
  if (text === '👤 My Account') {
    return sendTelegramMessage(env, chatId, t(lang, 'account', acct), MAIN_KEYBOARD);
  }
  if (text === '📦 My Orders') {
    return sendMyOrdersList(env, chatId, acct, lang);
  }
  // Legacy keyboard button (removed from MAIN_KEYBOARD) — still honoured for
  // customers whose Telegram has the old keyboard cached.
  if (text === '➕ Top Up Wallet') {
    return startWalletTopup(env, chatId, telegramId, lang);
  }
  if (text === '💬 Help Center') {
    return sendTelegramMessage(env, chatId, t(lang, 'helpCenter'), {
      inline_keyboard: [
        [{ text: '❓ FAQ', callback_data: 'faq:list' }],
        [{ text: '🔍 Track my order', callback_data: 'track:start' }],
        [{ text: '💬 Contact Support', url: 'https://t.me/pca_gamestore' }],
      ],
    });
  }

  // Fallback — connected but text matched none of the menu buttons/commands
  // above (fat-finger, old keyboard, etc.). Re-show the menu instead of
  // going silent.
  return sendTelegramMessage(env, chatId, t(lang, 'fallback'), MAIN_KEYBOARD);
}

// ---------------------------------------------------------------------------
// In-bot Wallet Top Up flow — amount (text) -> payment method (inline
// button) -> receipt (photo). Mirrors store.html's submitWalletTopup(): same
// "walletTopups" doc shape (amount/paymentMethod/receiptUrl/status/userId/
// userName/userPhone) and the same /ping to the order-approval Worker, so
// the existing admin Confirm/Reject flow picks these up with no admin-side
// changes needed. Step is persisted in Firestore's "telegramBotSessions"
// collection (chat_id-keyed) since a Worker has no in-memory state that
// survives across requests/edge locations.
// ---------------------------------------------------------------------------
async function handleTopupAmount(env, chatId, telegramId, text) {
  const amount = Number(String(text).replace(/[^0-9.]/g, ''));
  if (!amount || amount <= 0) {
    return sendTelegramMessage(env, chatId, 'ပမာဏကို ဂဏန်းနဲ့ ရိုက်ထည့်ပါ (ဥပမာ - 10000)။', cancelInlineKeyboard(topupAmountRows(1)));
  }
  if (amount < WALLET_TOPUP_MIN) {
    return sendTelegramMessage(env, chatId, `အနည်းဆုံး ${WALLET_TOPUP_MIN.toLocaleString()} MMK ဖြစ်ရပါမယ်။`, cancelInlineKeyboard(topupAmountRows(1)));
  }
  if (amount > WALLET_TOPUP_MAX) {
    return sendTelegramMessage(env, chatId, `အများဆုံး ${WALLET_TOPUP_MAX.toLocaleString()} MMK ဖြစ်ရပါမယ်။`, cancelInlineKeyboard(topupAmountRows(1)));
  }

  const methods = await listPaymentMethods(env);
  if (!methods.length) {
    await clearBotSession(env, telegramId);
    return sendTelegramMessage(env, chatId, 'Payment method များ ခေတ္တမရနိုင်ပါ။ PCA Store app ထဲက Wallet ကနေ ဖြည့်ကြည့်ပါ။', openAppInlineKeyboard());
  }

  await setBotSession(env, telegramId, { step: 'awaiting_method', amount });
  return sendPaymentMethodPicker(env, chatId, telegramId, amount);
}

// Sends the "pick a payment method" inline list for a given amount. Shared
// by handleTopupAmount() (first time through) and the 'topup_back_method'
// callback (re-shown when a customer backs out of the receipt step to pick
// a different method) so the star-pinning / cancel-button logic only lives
// in one place.
async function sendPaymentMethodPicker(env, chatId, telegramId, amount) {
  const methods = await listPaymentMethods(env);
  if (!methods.length) {
    await clearBotSession(env, telegramId);
    return sendTelegramMessage(env, chatId, 'Payment method များ ခေတ္တမရနိုင်ပါ။ PCA Store app ထဲက Wallet ကနေ ဖြည့်ကြည့်ပါ။', openAppInlineKeyboard());
  }

  const lastMethod = await getLastPaymentMethod(env, telegramId);
  // Pin the last-used method to the top (starred) so a repeat customer
  // doesn't have to re-scan the same list every single top-up. Falls back
  // to the plain list for a first-time user or if their last method no
  // longer exists.
  const sorted = lastMethod
    ? [...methods].sort((a, b) => (a.id === lastMethod.id ? -1 : b.id === lastMethod.id ? 1 : 0))
    : methods;

  return sendTelegramMessage(env, chatId, `ပမာဏ: ${amount.toLocaleString()} MMK\n\nငွေပေးချေမှု နည်းလမ်း ရွေးချယ်ပါ:`, cancelInlineKeyboard(
    sorted.map((m) => [
      { text: lastMethod && m.id === lastMethod.id ? `⭐ ${m.name} (နောက်ဆုံးသုံး)` : m.name, callback_data: `topup_pm:${m.id}` },
    ])
  ));
}

// ---------------------------------------------------------------------------
// "❓ FAQ" — a static, bot-answered FAQ list reachable from Help Center, so
// the most common questions (how to top up, delivery time, refunds, account
// safety) don't need an admin. Tap a question -> its answer, with a "🔙 FAQ
// List" button to go back. Edit FAQ_ITEMS to change the copy; no other code
// needs to change to add/remove a question.
// ---------------------------------------------------------------------------
const FAQ_ITEMS = [
  {
    id: 'topup',
    q: '💰 ငွေသွင်းနည်း',
    a: '💼 My Wallet ကိုနှိပ်ပြီး ➕ Top Up Wallet ခလုတ်ကို နှိပ်ကာ ပမာဏရိုက်ထည့်ပါ → ငွေပေးချေမှု နည်းလမ်း ရွေးပါ → Receipt ဓာတ်ပုံ ပို့ပါ။ Admin စစ်ဆေးပြီးသည်နှင့် Wallet ထဲ ချက်ချင်း ပေါင်းပေးပါလိမ့်မယ်။',
  },
  {
    id: 'delivery',
    q: '⏱️ ပို့ချိန်',
    a: 'ပုံမှန်အားဖြင့် မိနစ် 5-30 အတွင်း ပို့ဆောင်ပေးပါတယ်။ Order Status ကို 📦 My Orders (သို့) 🔍 Track my order ကနေ အချိန်မရွေး စစ်ကြည့်နိုင်ပါတယ်။',
  },
  {
    id: 'refund',
    q: '↩️ Order မအောင်မြင်ရင်',
    a: 'Order Fail ဖြစ်ရင် Wallet ထဲ ငွေပြန်အမ်းပေးပါတယ်။ ကြာချိန်ကြာလွန်းနေရင် (သို့) ပြဿနာရှိရင် 💬 Contact Support ကို ဆက်သွယ်ပေးပါ။',
  },
  {
    id: 'account',
    q: '🔒 Account လုံခြုံရေး',
    a: 'Telegram Account ကို တစ်ကြိမ်တည်း ချိတ်ဆက်ပြီးရင် တခြားသူက ပြန်ချိတ်လို့ မရတော့ပါ။ Wallet ထဲ ငွေရှိပြီးသား Account ကို ပြောင်းချိတ်ဖို့ လိုရင် Admin ကို ဆက်သွယ် verify ပြုလုပ်ရပါမယ်။',
  },
];

function faqListMarkup() {
  return {
    inline_keyboard: [
      ...FAQ_ITEMS.map((it) => [{ text: it.q, callback_data: `faq:${it.id}` }]),
      // Extra shortcut so a customer sitting at the bottom of the FAQ list
      // can jump straight back to Help Center instead of backing out via
      // an answer's "🔙 FAQ List" button first.
      [{ text: '💬 Help Center', callback_data: 'faq:help_center' }],
    ],
  };
}

async function handleFaqCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const telegramId = String(cq.from.id);
  if (!chatId || !messageId) return answerCallbackQuery(env, cq.id);
  await answerCallbackQuery(env, cq.id);

  const id = (cq.data || '').split(':')[1];

  if (id === 'help_center') {
    const lang = await getLanguage(env, telegramId);
    return editTelegramMessage(env, chatId, messageId, t(lang, 'helpCenter'), {
      inline_keyboard: [
        [{ text: '❓ FAQ', callback_data: 'faq:list' }],
        [{ text: '🔍 Track my order', callback_data: 'track:start' }],
        [{ text: '💬 Contact Support', url: 'https://t.me/pca_gamestore' }],
      ],
    });
  }

  const item = FAQ_ITEMS.find((it) => it.id === id);
  if (!item) {
    return editTelegramMessage(env, chatId, messageId, '❓ FAQ — မေးလေ့ရှိသော မေးခွန်းများ\n\nမေးခွန်းတစ်ခု ရွေးချယ်ပါ:', faqListMarkup());
  }
  return editTelegramMessage(env, chatId, messageId, `${item.q}\n\n${item.a}`, {
    inline_keyboard: [[{ text: '🔙 FAQ List', callback_data: 'faq:list' }]],
  });
}

// ---------------------------------------------------------------------------
// "🔍 Track my order" — reachable from Help Center. Unlike 📦 My Orders
// (which only lists the 5 most recent), this looks up ANY order by its
// exact ID, so an older order still shows. Uses the same telegramBotSessions
// step machinery as the wallet top-up flow ("awaiting_order_id"), so typing
// an order ID after tapping the button is picked up in routeTelegramMessage
// above, one-shot (no multi-step wizard needed here).
// ---------------------------------------------------------------------------
async function handleTrackOrderCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const telegramId = String(cq.from.id);
  if (!chatId) return answerCallbackQuery(env, cq.id);
  await answerCallbackQuery(env, cq.id);
  await setBotSession(env, telegramId, { step: 'awaiting_order_id' });
  return sendTelegramMessage(
    env, chatId,
    'Order ID ကို ရိုက်ထည့်ပါ (ဥပမာ — 12345 or #12345)။ /cancel ဖြင့် ရပ်နိုင်ပါတယ်။',
    MAIN_KEYBOARD
  );
}

async function handleTrackOrderId(env, chatId, telegramId, text) {
  await clearBotSession(env, telegramId);
  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) {
    return sendTelegramMessage(env, chatId, 'Account မချိတ်ဆက်ရသေးပါ။ App ထဲက Telegram Login ကို အရင်သုံးပြီး /start ကို ပြန်နှိပ်ပါ။', MAIN_KEYBOARD);
  }
  const orderId = text.trim().replace(/^#/, '');
  const order = await lookupOrderById(env, orderId);
  if (!order || order.userId !== acct.guestId) {
    return sendTelegramMessage(env, chatId, `Order #${orderId} ကို မတွေ့ရှိပါ။ Order ID ကို ပြန်စစ်ပြီး ထပ်ကြိုးစားပေးပါ။`, MAIN_KEYBOARD);
  }
  return sendTelegramMessage(env, chatId, buildOrderDetailText(order), MAIN_KEYBOARD);
}

// ---------------------------------------------------------------------------
// 📦 My Orders — now sends the recent-orders summary with one "🧾 #ID
// အသေးစိတ်" inline button per order (instead of plain text only), so
// tapping an order shows its full detail (game, price, timeline, date, and
// payment method/receipt/note when the "orders" doc happens to carry them)
// without leaving the chat. Shared by the "📦 My Orders" button and the
// "🔙 Back" button inside an order's detail view.
// ---------------------------------------------------------------------------
function buildOrdersListMessage(orders, lang) {
  const blocks = orders.map((o) => {
    const dateLine = formatOrderDate(o.timestamp);
    const timeline = orderTimelineLine(o.status);
    return [
      `#${o.id} — ${o.game || '-'} — ${Number(o.price || 0).toLocaleString()} MMK`,
      dateLine ? `🕐 ${dateLine}` : null,
      timeline || null,
    ].filter(Boolean).join('\n');
  });
  const rows = orders.map((o) => [{ text: `🧾 #${o.id} အသေးစိတ်`, callback_data: `ord:${o.id}` }]);
  return {
    text: `${t(lang, 'ordersHeader', orders.length)}\n\n${blocks.join('\n\n')}`,
    replyMarkup: { inline_keyboard: rows },
  };
}

async function sendMyOrdersList(env, chatId, acct, lang) {
  const orders = await lookupRecentOrders(env, acct.guestId);
  if (!orders.length) return sendTelegramMessage(env, chatId, t(lang, 'ordersEmpty'), MAIN_KEYBOARD);
  const { text, replyMarkup } = buildOrdersListMessage(orders, lang);
  return sendTelegramMessage(env, chatId, text, replyMarkup);
}

function buildOrderDetailText(order) {
  const dateLine = formatOrderDate(order.timestamp);
  const timeline = orderTimelineLine(order.status);
  const lines = [
    `🧾 Order #${order.id}`,
    `🎮 ${order.game || '-'}`,
    `💰 ${Number(order.price || 0).toLocaleString()} MMK`,
    dateLine ? `🕐 ${dateLine}` : null,
    timeline ? `\n${timeline}` : null,
    order.paymentMethod ? `\n💳 ငွေပေးချေမှု: ${order.paymentMethod}` : null,
    order.note ? `\n📝 ${order.note}` : null,
    order.receiptUrl ? `\n🧾 Receipt: ${order.receiptUrl}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

// Order detail as a native rich message (Bot API 10.3): real checkbox timeline, date shown in the
// viewer's own time zone, extra info in a collapsible block. Falls back to the plain-text card.
async function editOrderDetail(env, chatId, messageId, order, replyMarkup) {
  try {
    const ts = order.timestamp instanceof Date && !isNaN(order.timestamp.getTime()) ? order.timestamp : null;
    const status = (order.status || '').trim().toLowerCase();
    const failed = ['fail', 'failed', 'rejected'].includes(status);
    const stages = ['Pending', 'Processing', 'Success'];
    const idx = stages.findIndex((s) => s.toLowerCase() === status);
    const item = (label, checked) => ({ blocks: [{ type: 'paragraph', text: label }], has_checkbox: true, ...(checked ? { is_checked: true } : {}) });
    const items = failed
      ? [item('Pending', true), item('Processing', true), { blocks: [{ type: 'paragraph', text: '❌ Fail' }] }]
      : stages.map((s, i) => item(s, idx !== -1 && i <= idx));
    const blocks = [
      { type: 'heading', size: 3, text: `🧾 Order #${order.id}` },
      { type: 'paragraph', text: `🎮 ${order.game || '-'}` },
      { type: 'paragraph', text: `💰 ${Number(order.price || 0).toLocaleString()} MMK` },
      ts ? { type: 'paragraph', text: ['🕐 ', { type: 'date_time', text: formatOrderDate(ts), unix_time: Math.floor(ts.getTime() / 1000), date_time_format: 'wDT' }] } : null,
      { type: 'list', items },
    ].filter(Boolean);
    const more = [];
    if (order.paymentMethod) more.push({ type: 'paragraph', text: `💳 ငွေပေးချေမှု: ${order.paymentMethod}` });
    if (order.note) more.push({ type: 'paragraph', text: `📝 ${order.note}` });
    if (order.receiptUrl) more.push({ type: 'paragraph', text: ['🧾 ', { type: 'url', text: 'Receipt', url: order.receiptUrl }] });
    if (more.length) blocks.push({ type: 'details', summary: '📋 အသေးစိတ်', is_open: true, blocks: more });
    const payload = { chat_id: chatId, message_id: messageId, rich_message: { blocks } };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (j && j.ok) return;
    if (j && /not modified/i.test(j.description || '')) return;
    console.error('rich order detail failed, using plain text', JSON.stringify(j));
  } catch (e) {
    console.error('editOrderDetail error', e);
  }
  return editTelegramMessage(env, chatId, messageId, buildOrderDetailText(order), replyMarkup);
}

async function handleOrderDetailCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const telegramId = String(cq.from.id);
  const orderId = (cq.data || '').split(':')[1];
  if (!chatId || !messageId || !orderId) return answerCallbackQuery(env, cq.id);

  const lang = await getLanguage(env, telegramId);
  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, t(lang, 'notConnected'), null);
  }

  if (orderId === 'back') {
    await answerCallbackQuery(env, cq.id);
    const orders = await lookupRecentOrders(env, acct.guestId);
    if (!orders.length) return editTelegramMessage(env, chatId, messageId, t(lang, 'ordersEmpty'), null);
    const { text, replyMarkup } = buildOrdersListMessage(orders, lang);
    return editTelegramMessage(env, chatId, messageId, text, replyMarkup);
  }

  const order = await lookupOrderById(env, orderId);
  if (!order || order.userId !== acct.guestId) {
    return answerCallbackQuery(env, cq.id, 'ဤ Order ကို မတွေ့ရှိပါ။');
  }
  await answerCallbackQuery(env, cq.id);
  return editOrderDetail(env, chatId, messageId, order, {
    inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ord:back' }]],
  });
}

async function startWalletTopup(env, chatId, telegramId, lang) {
  await setBotSession(env, telegramId, { step: 'awaiting_amount' });
  return sendTelegramMessage(
    env, chatId,
    t(lang, 'topupPrompt', WALLET_TOPUP_MIN.toLocaleString(), WALLET_TOPUP_MAX.toLocaleString()),
    cancelInlineKeyboard(topupAmountRows(1))
  );
}

async function routeTelegramCallback(env, cq, ctx) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const telegramId = String(cq.from.id);
  const data = cq.data || '';

  // Quick-pick amount buttons (see topupAmountRows).
  if (data.startsWith('topup_amt:')) {
    const session = await getBotSession(env, telegramId);
    if (!session || session.step !== 'awaiting_amount') {
      await answerCallbackQuery(env, cq.id, 'Session ကုန်သွားပါပြီ၊ 💼 My Wallet ထဲက Top Up Wallet ကနေ ပြန်စပါ။');
      return;
    }
    await answerCallbackQuery(env, cq.id);
    return handleTopupAmount(env, chatId, telegramId, data.slice('topup_amt:'.length));
  }
  if (data.startsWith('topup_amt_page:')) {
    const page = data.endsWith(':2') ? 2 : 1;
    const messageId = cq.message && cq.message.message_id;
    const lang = await getLanguage(env, telegramId);
    await answerCallbackQuery(env, cq.id);
    if (!messageId) return;
    return editTelegramMessage(
      env, chatId, messageId,
      t(lang, 'topupPrompt', WALLET_TOPUP_MIN.toLocaleString(), WALLET_TOPUP_MAX.toLocaleString()),
      cancelInlineKeyboard(topupAmountRows(page))
    );
  }

  // "➕ Top Up Wallet" button under the 💼 My Wallet balance message.
  if (data === 'wallet:topup') {
    await answerCallbackQuery(env, cq.id);
    const lang = await getLanguage(env, telegramId);
    const acct = await lookupAccountByTelegramId(env, telegramId);
    if (!acct) return sendTelegramMessage(env, chatId, t(lang, 'notConnected'));
    return startWalletTopup(env, chatId, telegramId, lang);
  }

  if (data.startsWith('gl:')) {
    return handleGameListCallback(env, cq);
  }
  if (data.startsWith('ag:')) {
    return handleAvailableGamesCallback(env, cq);
  }
  if (data.startsWith('faq:')) {
    return handleFaqCallback(env, cq);
  }
  if (data.startsWith('track:')) {
    return handleTrackOrderCallback(env, cq);
  }
  if (data.startsWith('ord:')) {
    return handleOrderDetailCallback(env, cq);
  }
  if (data.startsWith('ordst:')) {
    return handleOrderTrackerCallback(env, cq);
  }

  if (data.startsWith('lang:')) {
    const lang = SUPPORTED_LANGS.includes(data.slice('lang:'.length)) ? data.slice('lang:'.length) : 'my';
    await setLanguage(env, telegramId, lang);
    await answerCallbackQuery(env, cq.id);
    return sendTelegramMessage(env, chatId, t(lang, 'languageSet'), MAIN_KEYBOARD);
  }

  if (data.startsWith('topup_pm:')) {
    const pmId = data.slice('topup_pm:'.length);
    const session = await getBotSession(env, telegramId);
    if (!session || session.step !== 'awaiting_method' || !session.amount) {
      await answerCallbackQuery(env, cq.id, 'Session ကုန်သွားပါပြီ၊ 💼 My Wallet ထဲက Top Up Wallet ကနေ ပြန်စပါ။');
      return;
    }
    const methods = await listPaymentMethods(env);
    const method = methods.find((m) => m.id === pmId);
    if (!method) {
      await answerCallbackQuery(env, cq.id, 'Payment method မတွေ့ပါ။');
      return;
    }
    // Land on a confirm step rather than jumping straight to "send your
    // receipt" — lets a customer catch a wrong amount/method before we ask
    // them for a screenshot, instead of only being able to Cancel and
    // restart from scratch.
    await setBotSession(env, telegramId, {
      step: 'awaiting_confirm',
      amount: session.amount,
      paymentMethodName: method.name,
      paymentMethodNumber: method.number || '',
      paymentMethodAccountName: method.accountName || '',
    });
    await setLastPaymentMethod(env, telegramId, method.id, method.name);
    await answerCallbackQuery(env, cq.id);
    return sendTopupConfirmPrompt(env, chatId, session.amount, method.name);
  }

  // "✅ Confirm" on the amount+method summary — locks the flow in and moves
  // on to actually requesting the receipt photo.
  if (data === 'topup_confirm') {
    const session = await getBotSession(env, telegramId);
    if (!session || session.step !== 'awaiting_confirm' || !session.amount || !session.paymentMethodName) {
      await answerCallbackQuery(env, cq.id, 'Session ကုန်သွားပါပြီ၊ 💼 My Wallet ထဲက Top Up Wallet ကနေ ပြန်စပါ။');
      return;
    }
    await setBotSession(env, telegramId, {
      step: 'awaiting_receipt',
      amount: session.amount,
      paymentMethodName: session.paymentMethodName,
      paymentMethodNumber: session.paymentMethodNumber || '',
      paymentMethodAccountName: session.paymentMethodAccountName || '',
    });
    await answerCallbackQuery(env, cq.id);
    return sendTelegramMessage(
      env, chatId,
      `💳 ${session.paymentMethodName}\n\nအကောင့်: ${session.paymentMethodAccountName || '-'}\nနံပါတ်: ${session.paymentMethodNumber || '-'}\n\n${session.amount.toLocaleString()} MMK လွှဲပြီးရင် Receipt screenshot ကို ဒီမှာ ပို့ပါ။`,
      cancelInlineKeyboard([
        // Native copy buttons (copy_text): one tap copies the payment number / account name.
        paymentCopyRow(session.paymentMethodNumber, session.paymentMethodAccountName),
        [{ text: '🔙 Change Amount', callback_data: 'topup_back_amount' }, { text: '🔙 Change Method', callback_data: 'topup_back_method' }],
      ].filter((r) => r.length))
    );
  }

  // "✏️ Edit" on the confirm summary — offers a choice of what to fix
  // instead of guessing; each option routes to the existing back-to-amount
  // or back-to-method handlers below.
  if (data === 'topup_edit') {
    const session = await getBotSession(env, telegramId);
    if (!session || !session.amount) {
      await answerCallbackQuery(env, cq.id, 'Session ကုန်သွားပါပြီ၊ 💼 My Wallet ထဲက Top Up Wallet ကနေ ပြန်စပါ။');
      return;
    }
    await answerCallbackQuery(env, cq.id);
    return sendTelegramMessage(
      env, chatId,
      'ဘာကို ပြင်ချင်ပါသလဲ?',
      cancelInlineKeyboard([
        [{ text: '🔢 Change Amount', callback_data: 'topup_back_amount' }],
        [{ text: '💳 Change Method', callback_data: 'topup_back_method' }],
      ])
    );
  }

  // Shared "❌ Cancel" button — attached to every step of the wallet
  // top-up flow (amount / method / confirm / receipt), so this fires
  // regardless of which step the customer is currently on.
  if (data === 'topup_cancel') {
    await clearBotSession(env, telegramId);
    const lang = await getLanguage(env, telegramId);
    await answerCallbackQuery(env, cq.id);
    return sendTelegramMessage(env, chatId, t(lang, 'cancelled'), MAIN_KEYBOARD);
  }

  // "🔙 Change Amount" — reachable from the confirm step and from the
  // receipt prompt. Unlike the old behavior (Cancel + restart from
  // scratch), this keeps the flow alive and just re-asks for the amount;
  // the payment method already picked is dropped since a new amount means
  // re-confirming the method anyway.
  if (data === 'topup_back_amount') {
    const session = await getBotSession(env, telegramId);
    if (!session) {
      await answerCallbackQuery(env, cq.id, 'Session ကုန်သွားပါပြီ၊ 💼 My Wallet ထဲက Top Up Wallet ကနေ ပြန်စပါ။');
      return;
    }
    await setBotSession(env, telegramId, { step: 'awaiting_amount' });
    const lang = await getLanguage(env, telegramId);
    await answerCallbackQuery(env, cq.id);
    return sendTelegramMessage(
      env, chatId,
      t(lang, 'topupPrompt', WALLET_TOPUP_MIN.toLocaleString(), WALLET_TOPUP_MAX.toLocaleString()),
      cancelInlineKeyboard(topupAmountRows(1))
    );
  }

  // "🔙 Change Method" — reachable from the confirm step and from the
  // receipt prompt. Steps back to awaiting_method without losing the
  // amount already entered, instead of forcing a full restart via Cancel.
  if (data === 'topup_back_method') {
    const session = await getBotSession(env, telegramId);
    if (!session || !session.amount) {
      await answerCallbackQuery(env, cq.id, 'Session ကုန်သွားပါပြီ၊ 💼 My Wallet ထဲက Top Up Wallet ကနေ ပြန်စပါ။');
      return;
    }
    await setBotSession(env, telegramId, { step: 'awaiting_method', amount: session.amount });
    await answerCallbackQuery(env, cq.id);
    return sendPaymentMethodPicker(env, chatId, telegramId, session.amount);
  }

  // "🔄 ထပ်ကြိုးစားမည်" on a failed receipt upload — re-attempts the same
  // photo (its file_id was stashed on the session when the upload first
  // failed) instead of forcing the customer to re-send the screenshot or
  // restart the whole flow.
  if (data === 'topup_retry_receipt') {
    const session = await getBotSession(env, telegramId);
    if (!session || session.step !== 'awaiting_receipt' || !session.amount || !session.paymentMethodName || !session.lastReceiptFileId) {
      await answerCallbackQuery(env, cq.id, 'Session ကုန်သွားပါပြီ၊ 💼 My Wallet ထဲက Top Up Wallet ကနေ ပြန်စပါ။');
      return;
    }
    const acct = await lookupAccountByTelegramId(env, telegramId);
    if (!acct) {
      const lang = await getLanguage(env, telegramId);
      await answerCallbackQuery(env, cq.id);
      await clearBotSession(env, telegramId);
      return sendTelegramMessage(env, chatId, t(lang, 'notConnected'));
    }
    await answerCallbackQuery(env, cq.id);
    await sendTelegramMessage(env, chatId, t(await getLanguage(env, telegramId), 'receiptProcessing'));
    return submitTopupReceipt(env, ctx, chatId, telegramId, session.lastReceiptFileId, session, acct, acct.name || acct.telegramUsername || acct.guestId);
  }
}

// Shown right before the receipt is requested — a last chance to catch a
// wrong amount or payment method (see FAQ_ITEMS-adjacent comment above:
// previously the only way back was Cancel + starting the whole flow over).
function sendTopupConfirmPrompt(env, chatId, amount, methodName) {
  return sendTelegramMessage(
    env, chatId,
    `ပမာဏ: ${amount.toLocaleString()} MMK\n${methodName} ဖြင့် လွှဲမှာ မှန်ပါသလား?`,
    cancelInlineKeyboard([
      [{ text: '✅ Confirm', callback_data: 'topup_confirm' }, { text: '✏️ Edit', callback_data: 'topup_edit' }],
    ])
  );
}

async function routeTelegramPhoto(env, msg, ctx) {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from.id);
  const lang = await getLanguage(env, telegramId);
  const session = await getBotSession(env, telegramId);
  if (!session || session.step !== 'awaiting_receipt' || !session.amount || !session.paymentMethodName) {
    // Not silent anymore — an unexplained missing reply here reads as a
    // stuck/broken bot, especially right after a timeout auto-cleared the
    // flow.
    return sendTelegramMessage(env, chatId, t(lang, 'topupExpired'), MAIN_KEYBOARD);
  }

  const acct = await lookupAccountByTelegramId(env, telegramId);
  if (!acct) {
    await clearBotSession(env, telegramId);
    return sendTelegramMessage(env, chatId, t(lang, 'notConnected'));
  }

  // Tighter limit specifically on topup submissions — each one uploads a
  // photo, writes a walletTopups doc, and pings the admin worker, so this
  // guards against spammed/duplicate receipts far more than the general
  // message flood guard does.
  const topupLimit = await checkRateLimit(env, telegramId, 'topup_submit', { maxCount: 5, windowMs: 60 * 60 * 1000 });
  if (topupLimit.limited) {
    await clearBotSession(env, telegramId);
    const waitMins = Math.max(1, Math.ceil(topupLimit.retryAfterMs / 60000));
    return sendTelegramMessage(env, chatId, t(lang, 'topupRateLimited', waitMins), MAIN_KEYBOARD);
  }

  const photos = msg.photo; // smallest -> largest; take the largest
  const fileId = photos[photos.length - 1].file_id;
  const displayName = acct.name || acct.telegramUsername || msg.from.first_name || acct.guestId;
  await sendTelegramMessage(env, chatId, t(lang, 'receiptProcessing'));
  return submitTopupReceipt(env, ctx, chatId, telegramId, fileId, session, acct, displayName);
}

// Uploads a receipt photo + writes the walletTopups doc. Shared by
// routeTelegramPhoto() (first attempt, right after the photo arrives) and
// the "🔄 ထပ်ကြိုးစားမည်" retry callback (re-attempts the same file_id,
// stashed on the session below when an attempt fails) — so a flaky image
// upload no longer forces the customer to re-send the screenshot or
// restart the whole top-up flow from scratch.
async function submitTopupReceipt(env, ctx, chatId, telegramId, fileId, session, acct, displayName) {
  const lang = await getLanguage(env, telegramId);
  try {
    const receiptUrl = await uploadTelegramPhotoToD1(env, fileId);

    const topupId = await fsCreateDoc(env, 'walletTopups', {
      amount: session.amount,
      paymentMethod: session.paymentMethodName,
      receiptUrl,
      status: 'Pending',
      timestamp: new Date(),
      userId: acct.guestId,
      userName: displayName,
      userPhone: '',
    });
    await clearBotSession(env, telegramId);
    pingCouponWorker('topup', topupId).catch(() => {});
    return sendTelegramMessage(env, chatId, t(lang, 'topupSuccess', session.amount.toLocaleString()), MAIN_KEYBOARD);
  } catch (e) {
    console.error('submitTopupReceipt failed:', e);
    // Keep the flow alive (don't clear the session) and remember this
    // file_id so a tap on "🔄 Retry" can re-attempt the exact same photo
    // instead of asking the customer to find and re-send it.
    await setBotSession(env, telegramId, {
      step: 'awaiting_receipt',
      amount: session.amount,
      paymentMethodName: session.paymentMethodName,
      paymentMethodNumber: session.paymentMethodNumber || '',
      paymentMethodAccountName: session.paymentMethodAccountName || '',
      lastReceiptFileId: fileId,
    });
    // Money-critical: a customer believes they just paid and the receipt
    // failed to save. Worth an immediate admin ping, unlike most other
    // best-effort failures in this file.
    if (ctx) ctx.waitUntil(alertAdmin(env, `Wallet topup receipt failed for telegramId ${telegramId}`, e));
    return sendTelegramMessage(env, chatId, t(lang, 'receiptFailed'), {
      inline_keyboard: [
        [{ text: '🔄 ထပ်ကြိုးစားမည်', callback_data: 'topup_retry_receipt' }],
        [{ text: '❌ Cancel', style: 'danger', callback_data: 'topup_cancel' }],
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Game List flow — category menu, paged group list, server picker, and the
// final "Open in App" hand-off. See the comment above GAME_LIST_CATEGORIES.
// ---------------------------------------------------------------------------
async function sendGameListCategoryMenu(env, chatId) {
  return sendTelegramMessage(
    env, chatId,
    '🎮 Game List\n\nဝန်ဆောင်မှု အမျိုးအစား ရွေးချယ်ပါ:',
    gameListCategoryMenuMarkup()
  );
}

// ---------------------------------------------------------------------------
// "📋 Available Games" — first asks Top Up or Voucher (same split as Game
// List), then sends a single flat message listing every game in just that
// category, one per line in monospace. Telegram renders <code>...</code> as
// tap-to-copy, so a customer can tap a name to copy it, then paste it after
// "@pcagamestore_bot" to jump straight to it via inline search — no
// page-flipping through the Game List genre/page flow needed.
// Split into multiple messages if the list is long enough to risk
// Telegram's 4096-char single-message limit.
// ---------------------------------------------------------------------------
const TELEGRAM_MESSAGE_LIMIT = 4096;

async function sendAvailableGamesCategoryMenu(env, chatId) {
  return sendTelegramMessage(
    env, chatId,
    '📋 Available Games\n\nဘယ် Category ကြည့်ချင်ပါသလဲ?',
    {
      inline_keyboard: [
        [
          { text: GAME_LIST_CATEGORIES.topup, callback_data: 'ag:topup' },
          { text: GAME_LIST_CATEGORIES.voucher, callback_data: 'ag:voucher' },
        ],
        [{ text: '🔙 Back', callback_data: 'ag:back' }],
      ],
    }
  );
}

async function handleAvailableGamesCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const telegramId = String(cq.from.id);
  const cat = (cq.data || '').split(':')[1];
  if (!chatId) return answerCallbackQuery(env, cq.id);

  if (cat === 'back') {
    await answerCallbackQuery(env, cq.id);
    if (messageId) await editTelegramMessage(env, chatId, messageId, '📋 Available Games', null);
    const lang = await getLanguage(env, telegramId);
    return sendTelegramMessage(
      env, chatId,
      lang === 'en' ? '📋 Pick an option from the menu below 👇' : '📋 အောက်က Menu ထဲက ရွေးချယ်ပါ 👇',
      MAIN_KEYBOARD
    );
  }

  if (cat !== 'topup' && cat !== 'voucher') {
    return answerCallbackQuery(env, cq.id);
  }
  await answerCallbackQuery(env, cq.id);
  // Drop the inline picker's buttons so a double-tap can't re-trigger this,
  // then send the actual list as a fresh message (it may span several
  // messages, so it can't just be an edit of the picker).
  if (messageId) {
    await editTelegramMessage(env, chatId, messageId, `📋 Available Games — ${GAME_LIST_CATEGORIES[cat]}`, null);
  }
  return sendAvailableGamesList(env, chatId, cat);
}

async function sendAvailableGamesList(env, chatId, cat) {
  const [games, flags] = await Promise.all([listGamesRaw(env), getProviderFlags(env)]);
  const groups = buildGameGroupsForCategory(games, flags, cat, 'all');
  const names = groups.map((g) => (g.name || '').trim()).filter(Boolean);
  names.sort((a, b) => a.localeCompare(b));

  const catLabel = GAME_LIST_CATEGORIES[cat];
  if (!names.length) {
    return sendTelegramMessage(env, chatId, `${catLabel} အတွက် ဂိမ်းစာရင်း ခေတ္တမရနိုင်ပါ။`, MAIN_KEYBOARD);
  }

  const header = `📋 ${catLabel} — Available Games (${names.length})\n\nဂိမ်းအမည်ကို နှိပ်ပြီး Copy ယူပါ — ပြီးရင် @pcagamestore_bot ရဲ့ search box ထဲ Paste လုပ်ပြီး တိုက်ရိုက်ရှာနိုင်ပါတယ်:\n\n`;
  const lines = names.map((n) => `<code>${escapeHtml(n)}</code>`);
  const chunks = chunkLinesToMessages(lines, TELEGRAM_MESSAGE_LIMIT - header.length);

  for (let i = 0; i < chunks.length; i++) {
    const text = i === 0 ? header + chunks[i] : chunks[i];
    const isLast = i === chunks.length - 1;
    await sendTelegramMessage(env, chatId, text, isLast ? MAIN_KEYBOARD : null, 'HTML');
  }
}

// Packs `lines` into as few chunks as possible without any chunk exceeding
// maxLen (accounting for the '\n' joiners), so a very long game list still
// sends as valid Telegram messages instead of one oversized request that
// the Bot API would reject outright.
function chunkLinesToMessages(lines, maxLen) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function gameListCategoryMenuMarkup() {
  return {
    inline_keyboard: [[
      { text: GAME_LIST_CATEGORIES.topup, callback_data: 'gl:genre:topup' },
      { text: GAME_LIST_CATEGORIES.voucher, callback_data: 'gl:genre:voucher' },
    ]],
  };
}

// Genre filter-chip menu shown after Top Up/Voucher is picked: "All" plus
// one button per GAME_GENRES entry, 2 per row, with a back button to the
// Top Up/Voucher chooser.
function buildGenreMenuMarkup(cat) {
  // All + 5 genres = 6 chips -> three even rows of 2.
  const cells = [{ text: '🗂️ All', callback_data: `gl:c:${cat}:all:0` }]
    .concat(GAME_GENRES.map((g) => ({ text: g.label, callback_data: `gl:c:${cat}:${g.id}:0` })));
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
  rows.push([{ text: '🔙 Type', callback_data: 'gl:catmenu' }]);
  return { inline_keyboard: rows };
}

// One inline button per game group, one group per row (names can run long),
// a Prev/Next nav row when there's more than a page's worth, and a Category
// button back to the Top Up / Voucher chooser.
function buildGroupListPage(cat, genre, groups, page) {
  const start = page * GAME_LIST_PAGE_SIZE;
  const pageGroups = groups.slice(start, start + GAME_LIST_PAGE_SIZE);
  const rows = pageGroups.map((g, i) => [{
    text: g.ids.length > 1 ? `${g.name} (${g.ids.length})` : g.name,
    callback_data: `gl:g:${cat}:${genre}:${page}:${start + i}`,
  }]);
  const navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ Prev', callback_data: `gl:c:${cat}:${genre}:${page - 1}` });
  if (start + GAME_LIST_PAGE_SIZE < groups.length) navRow.push({ text: 'Next ➡️', callback_data: `gl:c:${cat}:${genre}:${page + 1}` });
  if (navRow.length) rows.push(navRow);
  rows.push([{ text: '🔙 Genre', callback_data: `gl:genre:${cat}` }]);
  return { inline_keyboard: rows };
}

async function sendOpenAppMessage(env, chatId, messageId, label, gameId, backButton) {
  const url = `${STORE_URL}?game=${encodeURIComponent(gameId)}`;
  return editTelegramMessage(
    env, chatId, messageId,
    `🎮 ${label}\n\nအောက်က ခလုတ်ကို နှိပ်ပြီး Store App ထဲမှာ ဖွင့်ပါ:`,
    { inline_keyboard: [[{ text: `🚀 ${label} ဖွင့်မည်`, web_app: { url } }], [backButton]] }
  );
}

async function handleGameListCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  if (!chatId || !messageId) {
    return answerCallbackQuery(env, cq.id);
  }
  const parts = (cq.data || '').split(':'); // ['gl', kind, ...]
  const kind = parts[1];

  if (kind === 'catmenu') {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, '🎮 Game List\n\nဝန်ဆောင်မှု အမျိုးအစား ရွေးချယ်ပါ:', gameListCategoryMenuMarkup());
  }

  // 'genre' and 'c'/'g'/'s' all need the freshly-recomputed group list for
  // this category — nothing about this flow is cached in Firestore session
  // state, so every tap re-derives it from the live "games" collection.
  const cat = parts[2];
  if (cat !== 'topup' && cat !== 'voucher') {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, '🎮 Game List\n\nဝန်ဆောင်မှု အမျိုးအစား ရွေးချယ်ပါ:', gameListCategoryMenuMarkup());
  }
  const catLabel = GAME_LIST_CATEGORIES[cat];

  if (kind === 'genre') {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, `${catLabel}\n\nဂိမ်း Category ရွေးချယ်ပါ:`, buildGenreMenuMarkup(cat));
  }

  // 'c', 'g' and 's' all carry the selected genre ('all' or a GAME_GENRES
  // id) as their next segment, right after cat.
  const genre = parts[3];
  const genreLabel = genre === 'all' ? null : findGenre(genre);
  // An unrecognized genre (stale message from before this filter existed,
  // or a tampered callback_data) falls back to the genre picker rather than
  // silently showing an unfiltered list.
  if (genre !== 'all' && !genreLabel) {
    await answerCallbackQuery(env, cq.id);
    return editTelegramMessage(env, chatId, messageId, `${catLabel}\n\nဂိမ်း Category ရွေးချယ်ပါ:`, buildGenreMenuMarkup(cat));
  }
  const headerLabel = genreLabel ? `${catLabel} · ${genreLabel.label}` : catLabel;

  if (kind === 'c') {
    const page = parseInt(parts[4], 10) || 0;
    await answerCallbackQuery(env, cq.id);
    const [games, flags] = await Promise.all([listGamesRaw(env), getProviderFlags(env)]);
    const groups = buildGameGroupsForCategory(games, flags, cat, genre);
    if (!groups.length) {
      return editTelegramMessage(env, chatId, messageId, `${headerLabel}\n\nဂိမ်းစာရင်း မရှိသေးပါ။`, {
        inline_keyboard: [[{ text: '🔙 Genre', callback_data: `gl:genre:${cat}` }]],
      });
    }
    return editTelegramMessage(
      env, chatId, messageId,
      `${headerLabel}\n\nဂိမ်းတစ်ခု ရွေးချယ်ပါ: (${groups.length})`,
      buildGroupListPage(cat, genre, groups, page)
    );
  }

  if (kind === 'g') {
    const page = parseInt(parts[4], 10) || 0;
    const idx = parseInt(parts[5], 10);
    await answerCallbackQuery(env, cq.id);
    const [games, flags] = await Promise.all([listGamesRaw(env), getProviderFlags(env)]);
    const groups = buildGameGroupsForCategory(games, flags, cat, genre);
    const group = groups[idx];
    if (!group) {
      return editTelegramMessage(env, chatId, messageId, 'ဤဂိမ်းကို မတွေ့ရှိပါ (list ပြောင်းသွားနိုင်ပါသည်)။ ပြန်ကြိုးစားပေးပါ။', {
        inline_keyboard: [[{ text: '🔙 Genre', callback_data: `gl:genre:${cat}` }]],
      });
    }
    if (group.ids.length <= 1) {
      return sendOpenAppMessage(env, chatId, messageId, group.name, group.ids[0], { text: '🔙 Back', callback_data: `gl:c:${cat}:${genre}:${page}` });
    }
    // Multi-server game (e.g. "Mobile Legends (9)") — list every
    // server/region variant so the person can pick the exact one before
    // the Mini App opens straight into it.
    const rows = group.servers.map((s, i) => [{ text: s, callback_data: `gl:s:${cat}:${genre}:${page}:${idx}:${i}` }]);
    rows.push([{ text: '🔙 Back', callback_data: `gl:c:${cat}:${genre}:${page}` }]);
    return editTelegramMessage(env, chatId, messageId, `${group.name}\n\nServer / Region ရွေးချယ်ပါ:`, { inline_keyboard: rows });
  }

  if (kind === 's') {
    const page = parseInt(parts[4], 10) || 0;
    const idx = parseInt(parts[5], 10);
    const sIdx = parseInt(parts[6], 10);
    await answerCallbackQuery(env, cq.id);
    const [games, flags] = await Promise.all([listGamesRaw(env), getProviderFlags(env)]);
    const groups = buildGameGroupsForCategory(games, flags, cat, genre);
    const group = groups[idx];
    const gameId = group && group.ids[sIdx];
    if (!group || !gameId) {
      return editTelegramMessage(env, chatId, messageId, 'ဤ Server ကို မတွေ့ရှိပါ (list ပြောင်းသွားနိုင်ပါသည်)။ ပြန်ကြိုးစားပေးပါ။', {
        inline_keyboard: [[{ text: '🔙 Genre', callback_data: `gl:genre:${cat}` }]],
      });
    }
    const label = group.servers[sIdx] || group.name;
    return sendOpenAppMessage(env, chatId, messageId, label, gameId, { text: '🔙 Back', callback_data: `gl:g:${cat}:${genre}:${page}:${idx}` });
  }

  return answerCallbackQuery(env, cq.id);
}

// Reads all "games" docs, keeping only the fields this flow needs (mirrors
// store.html's GAMES/RAW_GAMES shape, minus images/packages/etc.).
async function listGamesRaw(env) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/games`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    const docs = data.documents || [];
    return docs.map((d) => {
      const f = d.fields;
      return {
        id: d.name.split('/').pop(),
        name: fsField(f, 'name') || '',
        serverName: fsField(f, 'serverName') || '',
        order: fsField(f, 'order'),
        fulfillProvider: fsField(f, 'fulfillProvider') || '',
        category: fsField(f, 'category') || '',
      };
    });
  } catch (e) {
    console.error('listGamesRaw failed:', e);
    return [];
  }
}

// Mirrors store.html's settings/providerFlags read: missing doc or any
// field other than an explicit `false` means that source is enabled.
async function getProviderFlags(env) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/settings/providerFlags`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return {};
    const doc = await res.json();
    if (!doc.fields) return {};
    const flags = {};
    ['g2bulk', 'fazercard', 'aluu', 'jcplays'].forEach((p) => {
      flags[p] = fsField(doc.fields, p) !== false;
    });
    return flags;
  } catch (e) {
    console.error('getProviderFlags failed:', e);
    return {};
  }
}

// Reads settings/adminBroadcast.secret from Firestore instead of requiring
// a `wrangler secret put ADMIN_BROADCAST_SECRET` — lets the admin set/rotate
// this straight from admin.html's Settings page (Admin Broadcast Secret
// card), no CLI/dashboard step needed. Falls back to the env var if the
// Firestore doc is missing/empty, so an existing wrangler-set secret keeps
// working during migration.
//
// Cached 5 min per warm isolate (this value changes rarely — an admin
// manually rotating it — so there's no need to re-read on every request the
// way a fast-changing value would). A rotated secret takes effect on this
// Worker within 5 min at worst. An in-flight promise is also cached (not
// just the resolved value) so a burst of concurrent requests hitting a cold
// isolate at the same moment all await the same single Firestore read
// instead of each firing their own.
let cachedBroadcastSecret = null;
let cachedBroadcastSecretAt = 0;
let broadcastSecretFetchPromise = null;
async function getAdminBroadcastSecret(env) {
  const now = Date.now();
  if (cachedBroadcastSecret !== null && now - cachedBroadcastSecretAt < 300000) {
    return cachedBroadcastSecret;
  }
  if (broadcastSecretFetchPromise) return broadcastSecretFetchPromise;

  broadcastSecretFetchPromise = (async () => {
    try {
      const token = await getFirestoreAccessToken(env);
      const projectId = firestoreProjectId(env);
      const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
      const res = await fetch(`${base}/settings/adminBroadcast`, { headers: { Authorization: `Bearer ${token}` } });
      const doc = res.ok ? await res.json() : null;
      const fromFirestore = doc && doc.fields ? fsField(doc.fields, 'secret') : '';
      cachedBroadcastSecret = fromFirestore || env.ADMIN_BROADCAST_SECRET || '';
    } catch (e) {
      console.error('getAdminBroadcastSecret failed:', e);
      cachedBroadcastSecret = env.ADMIN_BROADCAST_SECRET || '';
    }
    cachedBroadcastSecretAt = Date.now();
    broadcastSecretFetchPromise = null;
    return cachedBroadcastSecret;
  })();

  return broadcastSecretFetchPromise;
}

// Same fulfillProvider -> source-family mapping as store.html's
// gameProviderFamily(), so a source the admin has toggled off in
// settings/providerFlags disappears from the bot's list too.
function gameProviderFamily(fulfillProvider) {
  if (fulfillProvider === 'g2bulk' || fulfillProvider === 'g2bulk_voucher') return 'g2bulk';
  if (fulfillProvider === 'fazercard' || fulfillProvider === 'fazercard_giftcard') return 'fazercard';
  if (fulfillProvider === 'aluu') return 'aluu';
  if (fulfillProvider === 'jcplays') return 'jcplays';
  return null;
}

// Filters to the requested category (voucher/giftcard providers vs every
// other, direct top-up provider — same split as store.html's Home vs
// Voucher tab), sorts by the admin's `order` field then name, and groups
// same-named uploads together (store.html's groupGamesByName) so a game
// uploaded once per server/region collapses into one "Name (N)" entry
// whose servers list drives the picker in the 's' step above.
function buildGameGroupsForCategory(games, flags, cat, genre) {
  const wantVoucher = cat === 'voucher';
  const wantGenre = genre && genre !== 'all' ? genre : null;
  const filtered = games.filter((g) => {
    const family = gameProviderFamily(g.fulfillProvider);
    if (family && flags[family] === false) return false;
    const isVoucher = g.fulfillProvider === 'g2bulk_voucher' || g.fulfillProvider === 'fazercard_giftcard';
    if (isVoucher !== wantVoucher) return false;
    if (wantGenre && g.category !== wantGenre) return false;
    return true;
  });
  filtered.sort((a, b) => {
    const oa = typeof a.order === 'number' ? a.order : Infinity;
    const ob = typeof b.order === 'number' ? b.order : Infinity;
    if (oa !== ob) return oa - ob;
    return (a.name || '').localeCompare(b.name || '');
  });
  const order = [];
  const map = {};
  filtered.forEach((g) => {
    const key = (g.name || '').trim().toLowerCase();
    if (!map[key]) {
      map[key] = { name: g.name, ids: [], servers: [] };
      order.push(key);
    }
    map[key].ids.push(g.id);
    map[key].servers.push(g.serverName || g.name);
  });
  return order.map((key) => map[key]);
}

// ---------------------------------------------------------------------------
// Inline mode — @pcagamestore_bot <text> typed in any chat. Requires
// /setinline to have been enabled for the bot via BotFather (done
// separately, outside this file). Reuses buildGameGroupsForCategory's
// same filter/group rules as Game List/Available Games, merged across
// Top Up + Voucher, then substring-matched (name-startsWith ranked first)
// against the typed query. Each result's tap sends a message with an
// "Open PCA Store" link — inline-result buttons only support `url` (not
// `web_app`, which Telegram restricts to a normal chat with the bot), so
// this opens the deep link in a browser rather than as a Mini App; from
// inside the bot chat itself, Game List/Available Games still give the
// full in-app web_app experience.
// ---------------------------------------------------------------------------
async function handleInlineQuery(env, inlineQuery) {
  const query = (inlineQuery.query || '').trim();
  if (!query) return answerInlineQuery(env, inlineQuery.id, []);

  const [games, flags] = await Promise.all([listGamesRaw(env), getProviderFlags(env)]);
  const topup = buildGameGroupsForCategory(games, flags, 'topup', 'all').map((g) => ({ ...g, cat: 'topup' }));
  const voucher = buildGameGroupsForCategory(games, flags, 'voucher', 'all').map((g) => ({ ...g, cat: 'voucher' }));

  const seen = new Set();
  const merged = [];
  [...topup, ...voucher].forEach((g) => {
    const key = (g.name || '').trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(g);
    }
  });

  const q = query.toLowerCase();
  const matches = merged
    .filter((g) => (g.name || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 20); // Telegram inline results are capped at 50; 20 is plenty for a search box

  const results = matches.map((g, i) => {
    const gameId = g.ids[0];
    const url = `${STORE_URL}?game=${gameId}`;
    const serverNote = g.ids.length > 1 ? ` · ${g.ids.length} servers` : '';
    return {
      type: 'article',
      id: `${gameId}-${i}`,
      title: g.name,
      description: `${GAME_LIST_CATEGORIES[g.cat]}${serverNote}`,
      input_message_content: { message_text: `🎮 ${g.name}\n\nဖွင့်ကြည့်ရန်: ${url}` },
      reply_markup: { inline_keyboard: [[{ text: '🚀 Open PCA Store', url }]] },
    };
  });

  return answerInlineQuery(env, inlineQuery.id, results);
}

async function answerInlineQuery(env, inlineQueryId, results) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerInlineQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inline_query_id: inlineQueryId, results, cache_time: 30, is_personal: true }),
    });
  } catch (e) {
    console.error('answerInlineQuery failed:', e);
  }
}

async function editTelegramMessage(env, chatId, messageId, text, replyMarkup) {
  try {
    const payload = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Most common cause: "message is not modified" (double-tap on the same
    // button) or the message aged past Telegram's edit window — neither is
    // worth surfacing as an error to the user, the keyboard still works.
    console.error('editTelegramMessage failed:', e);
  }
}

// Callback taps are acknowledged INSTANTLY (before any Firestore work) so the
// button's loading spinner stops right away — see ackCallbackNow() below. Once a
// callback has been acked, a later answerCallbackQuery(..., text) can no longer
// show a toast, so the text is sent as a normal chat message instead.
const ackedCallbacks = new Map(); // callback id -> chat id

async function ackCallbackNow(env, cq) {
  if (!cq || !cq.id) return;
  if (ackedCallbacks.size > 500) ackedCallbacks.clear();
  ackedCallbacks.set(cq.id, cq.message && cq.message.chat && cq.message.chat.id);
  const text = (cq.data || '').startsWith('ordst:') ? '🔄 Updating…' : '';
  await answerCallbackQueryRaw(env, cq.id, text);
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  if (ackedCallbacks.has(callbackQueryId)) {
    const chat = ackedCallbacks.get(callbackQueryId);
    if (text && chat) await sendTelegramMessage(env, chat, text);
    return;
  }
  return answerCallbackQueryRaw(env, callbackQueryId, text);
}

async function answerCallbackQueryRaw(env, callbackQueryId, text) {
  try {
    const payload = { callback_query_id: callbackQueryId };
    if (text) payload.text = text;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('answerCallbackQuery failed:', e);
  }
}

// Downloads a Telegram-hosted photo (getFile -> file bytes) and uploads it
// into Cloudflare D1, so admin.html displays bot-submitted receipts
// identically to site-submitted ones (same "receiptUrl" shape).
//
// Receipts are now stored in Cloudflare D1 (no imgbb). Needs on THIS Worker:
//   - D1 binding named DB (the same "pca-images" database the image worker uses)
//   - optional variable IMAGE_BASE_URL (default below) = the image worker's URL
const IMAGE_BASE_URL_DEFAULT = 'https://imgbb-functions.pca-game-store.workers.dev';
const RECEIPT_MAX_BYTES = 1400 * 1024;
async function uploadTelegramPhotoToD1(env, fileId) {
  if (!env.DB) throw new Error('D1 binding "DB" is not set on this Worker');

  const fileInfoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();
  if (!fileInfo.ok) throw new Error('getFile failed');
  const filePath = fileInfo.result.file_path;

  const fileRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!fileRes.ok) throw new Error(`Telegram file download failed (HTTP ${fileRes.status})`);
  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  if (bytes.length > RECEIPT_MAX_BYTES) throw new Error('Receipt image too large (max ~1.4 MB)');

  let mime = 'image/jpeg', ext = 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) { mime = 'image/png'; ext = 'png'; }
  else if (bytes[0] === 0x52 && bytes[1] === 0x49) { mime = 'image/webp'; ext = 'webp'; }

  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));

  await env.DB.prepare('CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)').run();
  const id = crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare('INSERT INTO images (id, mime, size, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, mime, bytes.length, btoa(bin), Date.now()).run();

  const base = String(env.IMAGE_BASE_URL || IMAGE_BASE_URL_DEFAULT).replace(/\/$/, '');
  return `${base}/i/${id}.${ext}`;
}

// Same "wake the order-approval Worker up now" ping store.html sends after
// saving a walletTopups doc — lets the admin bot notify + Confirm/Reject
// this bot-submitted top-up instantly instead of waiting for its next cron.
const COUPON_WORKER_URL = 'https://telegram-order.pca-game-store.workers.dev';
function pingCouponWorker(type, id) {
  return fetch(`${COUPON_WORKER_URL}/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ type, id }),
  });
}

// ---------------------------------------------------------------------------
// Bot conversation state ("telegramBotSessions/{telegramId}") + a live read
// of the store's "paymentMethods" collection, both via the same Firestore
// REST + service-account token already used above.
// ---------------------------------------------------------------------------
async function getBotSession(env, telegramId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramBotSessions/${telegramId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc.fields) return null;

    const updatedAt = fsField(doc.fields, 'updatedAt');
    if (updatedAt instanceof Date && Date.now() - updatedAt.getTime() > SESSION_TIMEOUT_MS) {
      await clearBotSession(env, telegramId); // abandoned flow — clean up so it doesn't linger
      return null;
    }

    return {
      step: fsField(doc.fields, 'step'),
      amount: fsField(doc.fields, 'amount'),
      paymentMethodName: fsField(doc.fields, 'paymentMethodName'),
      paymentMethodNumber: fsField(doc.fields, 'paymentMethodNumber'),
      paymentMethodAccountName: fsField(doc.fields, 'paymentMethodAccountName'),
      lastReceiptFileId: fsField(doc.fields, 'lastReceiptFileId'),
      warned: fsField(doc.fields, 'warned'),
    };
  } catch (e) {
    console.error('getBotSession failed:', e);
    return null;
  }
}

async function setBotSession(env, telegramId, data) {
  try {
    await fsSetDoc(env, `telegramBotSessions/${telegramId}`, { ...data, updatedAt: new Date() });
  } catch (e) {
    console.error('setBotSession failed:', e);
  }
}

async function clearBotSession(env, telegramId) {
  try {
    await fsDeleteDoc(env, `telegramBotSessions/${telegramId}`);
  } catch (e) {
    console.error('clearBotSession failed:', e);
  }
}

// How far ahead of SESSION_TIMEOUT_MS to warn a customer mid-flow (2
// minutes), and the warning text itself. Kept separate from MESSAGES since
// this is sent from a scheduled sweep rather than a reply to something the
// customer just did.
const SESSION_WARNING_LEAD_MS = 2 * 60 * 1000;
const SESSION_WARNING_TEXT = {
  my: '⏰ 2 မိနစ်အတွင်း Top Up flow ကုန်တော့မယ်။ ဆက်လုပ်ချင်ရင် အမြန်ဆက်လုပ်ပါ၊ မဟုတ်ရင် flow ပျက်သွားပြီး 💼 My Wallet ထဲက Top Up Wallet ကနေ ပြန်စရပါမယ်။',
  en: "⏰ Your top-up flow will expire in 2 minutes. Keep going now, or it'll reset and you'll need to start again from 💼 My Wallet → Top Up Wallet.",
};

// Every telegramBotSessions doc, straight (paginated, like Firestore's
// default 300-doc page) — same GET-the-collection pattern as
// listPaymentMethods(), since this is a small, short-lived collection
// (only customers currently mid-topup have a doc here at all).
async function listBotSessionDocs(env) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(`${base}/telegramBotSessions`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  const docs = data.documents || [];
  return docs.map((d) => ({
    telegramId: d.name.split('/').pop(),
    step: fsField(d.fields, 'step'),
    updatedAt: fsField(d.fields, 'updatedAt'),
    warned: fsField(d.fields, 'warned'),
  }));
}

// Cron sweep (see the `scheduled` export above): finds wallet-topup
// sessions that are within SESSION_WARNING_LEAD_MS of the 20-minute
// SESSION_TIMEOUT_MS and haven't already been warned, DMs each one a
// "⏰ 2 minutes left" heads-up, then marks the session `warned: true` so
// the same session doesn't get warned twice. Already-expired sessions are
// left alone here — they're cleaned up lazily the next time getBotSession()
// is called for that user (see the SESSION_TIMEOUT_MS check up there).
async function warnExpiringTopupSessions(env, ctx) {
  try {
    const sessions = await listBotSessionDocs(env);
    const now = Date.now();
    for (const s of sessions) {
      if (!s.step || s.warned || !(s.updatedAt instanceof Date)) continue;
      const ageMs = now - s.updatedAt.getTime();
      const msLeft = SESSION_TIMEOUT_MS - ageMs;
      if (msLeft <= 0 || msLeft > SESSION_WARNING_LEAD_MS) continue; // not expired, but not in the warning window either

      try {
        const lang = await getLanguage(env, s.telegramId);
        // For a 1:1 bot chat, chat_id === the user's own Telegram id — same
        // assumption already used by /notify-order-status elsewhere in this
        // file, so no extra chatId lookup is needed here.
        await sendTelegramMessage(env, s.telegramId, SESSION_WARNING_TEXT[lang] || SESSION_WARNING_TEXT.my);
        await fsMergeDoc(env, `telegramBotSessions/${s.telegramId}`, { warned: true });
      } catch (e) {
        // One customer's failed warning shouldn't stop the rest of the sweep.
        console.error(`warnExpiringTopupSessions: failed for ${s.telegramId}:`, e);
      }
    }
  } catch (e) {
    console.error('warnExpiringTopupSessions failed:', e);
    if (ctx) ctx.waitUntil(alertAdmin(env, 'warnExpiringTopupSessions sweep failed', e));
  }
}

// Per-user bot preferences ("telegramBotPrefs/{telegramId}") — kept separate
// from telegramBotSessions (short-lived flow state) and telegramBotUsers
// (broadcast audience, rewritten wholesale on every /start) so remembering a
// payment method doesn't interact with either of those.
async function getLastPaymentMethod(env, telegramId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramBotPrefs/${telegramId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc.fields) return null;
    const id = fsField(doc.fields, 'lastPaymentMethodId');
    const name = fsField(doc.fields, 'lastPaymentMethodName');
    return id ? { id, name } : null;
  } catch (e) {
    console.error('getLastPaymentMethod failed:', e);
    return null;
  }
}

async function setLastPaymentMethod(env, telegramId, methodId, methodName) {
  try {
    await fsMergeDoc(env, `telegramBotPrefs/${telegramId}`, {
      lastPaymentMethodId: methodId,
      lastPaymentMethodName: methodName,
      updatedAt: new Date(),
    });
  } catch (e) {
    console.error('setLastPaymentMethod failed:', e);
  }
}

// Language preference, stored on the same telegramBotPrefs doc as the
// last-used payment method (via fsMergeDoc, so the two never clobber each
// other). Defaults to Burmese — this bot's original/primary audience —
// for anyone who hasn't explicitly picked English with /language.
const SUPPORTED_LANGS = ['my', 'en'];
async function getLanguage(env, telegramId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/telegramBotPrefs/${telegramId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return 'my';
    const doc = await res.json();
    const lang = doc.fields && fsField(doc.fields, 'language');
    return SUPPORTED_LANGS.includes(lang) ? lang : 'my';
  } catch (e) {
    console.error('getLanguage failed:', e);
    return 'my';
  }
}

async function setLanguage(env, telegramId, lang) {
  try {
    await fsMergeDoc(env, `telegramBotPrefs/${telegramId}`, { language: lang, updatedAt: new Date() });
  } catch (e) {
    console.error('setLanguage failed:', e);
  }
}

// Simple fixed-window rate limiter, stored per (telegramId, action) in
// "telegramRateLimits/{telegramId}_{action}". Not perfectly atomic (a
// read-then-write race under heavy concurrency could let a couple of extra
// requests slip through), which is fine here — this is an abuse guard, not
// a billing meter. Fails OPEN on any Firestore error: a real user should
// never get blocked because a rate-limit check itself broke.
// Returns { limited, retryAfterMs } instead of a plain boolean so a caller
// can tell the customer a concrete wait time ("try again in ~N minutes")
// instead of a vague "please wait". retryAfterMs is only meaningful when
// limited is true (time left until this fixed window resets).
async function checkRateLimit(env, telegramId, action, { maxCount, windowMs }) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const docId = `${telegramId}_${action}`;
    const res = await fetch(`${base}/telegramRateLimits/${docId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const now = Date.now();
    let windowStart = now;
    let count = 0;
    if (res.ok) {
      const doc = await res.json();
      if (doc.fields) {
        const ws = fsField(doc.fields, 'windowStart');
        if (ws instanceof Date && now - ws.getTime() < windowMs) {
          windowStart = ws.getTime();
          count = fsField(doc.fields, 'count') || 0;
        }
      }
    }
    count += 1;
    await fsSetDoc(env, `telegramRateLimits/${docId}`, { windowStart: new Date(windowStart), count });
    const limited = count > maxCount;
    return { limited, retryAfterMs: limited ? Math.max(0, windowStart + windowMs - now) : 0 };
  } catch (e) {
    console.error('checkRateLimit failed:', e);
    // Fails OPEN on any Firestore error: a real user should never get
    // blocked because a rate-limit check itself broke.
    return { limited: false, retryAfterMs: 0 };
  }
}

// Thin boolean wrapper over checkRateLimit() for the one caller (the
// general message flood guard) that doesn't need the wait time.
async function isRateLimited(env, telegramId, action, opts) {
  const { limited } = await checkRateLimit(env, telegramId, action, opts);
  return limited;
}

async function listPaymentMethods(env) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/paymentMethods`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    const docs = data.documents || [];
    return docs
      .map((d) => {
        const f = d.fields;
        return {
          id: d.name.split('/').pop(),
          name: fsField(f, 'name'),
          number: fsField(f, 'number'),
          accountName: fsField(f, 'accountName'),
          order: fsField(f, 'order'),
        };
      })
      .filter((m) => m.name)
      .sort((a, b) => {
        if (typeof a.order === 'number' && typeof b.order === 'number') return a.order - b.order;
        if (typeof a.order === 'number') return -1;
        if (typeof b.order === 'number') return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
  } catch (e) {
    console.error('listPaymentMethods failed:', e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Minimal Firestore REST write helpers (the rest of this file only ever
// read Firestore before now). Values -> Firestore's typed-field wire format.
// ---------------------------------------------------------------------------
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { stringValue: String(v) };
}

function toFsFields(data) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFsValue(v)]));
}

async function fsCreateDoc(env, collectionPath, data) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(`${base}/${collectionPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  const doc = await res.json();
  if (!res.ok) throw new Error((doc.error && doc.error.message) || 'Firestore create failed');
  return doc.name.split('/').pop();
}

// Atomically "claims" an update_id by creating a doc with that exact ID.
// Firestore's createDocument?documentId=<id> is atomic — if the doc already
// exists it returns 409 ALREADY_EXISTS instead of overwriting. That gives
// idempotency without a read-then-write race (two retried deliveries hitting
// this at the same instant can't both "win").
// Returns true the first time an update_id is seen, false on any repeat.
// `expireAt` is set 2 days out for an optional Firestore TTL policy on that
// field (Console > Firestore > TTL) so this collection doesn't grow forever;
// harmless to leave unset if no TTL policy is configured.
async function claimUpdateOnce(env, updateId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const expireAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const res = await fetch(
      `${base}/telegramProcessedUpdates?documentId=${encodeURIComponent(String(updateId))}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields: toFsFields({ processedAt: new Date(), expireAt }) }),
      }
    );
    if (res.status === 409) return false; // already processed
    return res.ok;
  } catch (e) {
    // If Firestore is unreachable, fail open (process the update) rather
    // than silently dropping real messages — a duplicate is far less bad
    // than a lost one.
    console.error('claimUpdateOnce failed:', e);
    return true;
  }
}

async function fsSetDoc(env, docPath, data) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(`${base}/${docPath}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  if (!res.ok) throw new Error('Firestore set failed');
}

// Partial update: unlike fsSetDoc (which replaces the whole document with
// just the given fields), this only touches the listed fields via Firestore's
// updateMask, leaving any other fields on the doc untouched. Needed for
// telegramBotPrefs, which now holds both lastPaymentMethod* and language —
// writing one with a full-document fsSetDoc would silently erase the other.
async function fsMergeDoc(env, docPath, data) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${base}/${docPath}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  if (!res.ok) throw new Error('Firestore merge failed');
}

async function fsDeleteDoc(env, docPath) {
  const token = await getFirestoreAccessToken(env);
  const projectId = firestoreProjectId(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  await fetch(`${base}/${docPath}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
}

async function sendTelegramMessage(env, chatId, text, replyMarkup, parseMode) {
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (parseMode) payload.parse_mode = parseMode;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      console.error('sendMessage rejected:', res.status, j && j.description);
    }
  } catch (e) {
    console.error('sendTelegramMessage failed:', e);
  }
}

// Like sendTelegramMessage() but reports the outcome, so push endpoints can
// tell their caller "not delivered" (the caller then retries / skips its
// "already sent" flag) instead of always answering ok:true.
async function sendTelegramMessageChecked(env, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, messageId: data && data.result && data.result.message_id };
    console.error('sendTelegramMessageChecked failed:', res.status, data && data.description);
    return { ok: false, blocked: data.error_code === 403, status: res.status };
  } catch (e) {
    console.error('sendTelegramMessageChecked threw:', e);
    return { ok: false, blocked: false, status: 0 };
  }
}

// Checked edit: { ok } (a "message is not modified" reply counts as ok), so
// the order tracker can fall back to sending a fresh message when the old one
// was deleted or is too old to edit.
async function editTelegramMessageChecked(env, chatId, messageId, text, replyMarkup) {
  try {
    const payload = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    if (/not modified/i.test(data.description || '')) return { ok: true, notModified: true };
    console.error('editTelegramMessageChecked failed:', res.status, data.description);
    return { ok: false };
  } catch (e) {
    console.error('editTelegramMessageChecked threw:', e);
    return { ok: false };
  }
}

// Sends a DM to the admin's own Telegram chat when something that actually
// matters breaks (an unhandled request error, or a wallet-topup receipt that
// failed to save) — the previous behavior was console.error only, which
// nobody sees until they go looking in the Cloudflare dashboard logs. Most
// of the ~20 other console.error calls in this file are deliberately left
// alone: best-effort side actions (a failed sendMessage, a failed session
// write) that shouldn't page anyone every time a Telegram/Firestore call
// hiccups. env.ADMIN_TELEGRAM_CHAT_ID is optional — if unset this is a
// silent no-op, so nothing breaks for anyone who hasn't configured it yet.
// (For a 1:1 bot chat, chat_id === that admin's own Telegram user id.)
async function alertAdmin(env, label, err) {
  if (!env.ADMIN_TELEGRAM_CHAT_ID) return;
  const detail = err instanceof Error ? err.message : String(err || '');
  const text = `🚨 PCA Store bot error\n\n${label}\n\n${detail}`.slice(0, 1000);

  // Unlike sendTelegramMessage() (best-effort, swallows failures — fine for
  // routine customer replies), an admin alert is itself the thing telling
  // us something broke, so a Telegram API hiccup or transient rate-limit
  // shouldn't just silently drop it. Retry a few times with backoff before
  // giving up.
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.ADMIN_TELEGRAM_CHAT_ID, text }),
      });
      if (res.ok) return;
      // Telegram's 429 responses include a retry_after (seconds) — honor it
      // instead of guessing a backoff.
      let retryAfterMs = 500 * (i + 1);
      if (res.status === 429) {
        const body = await res.json().catch(() => null);
        const retryAfterSec = body && body.parameters && body.parameters.retry_after;
        if (retryAfterSec) retryAfterMs = retryAfterSec * 1000 + 200;
      }
      console.error(`alertAdmin: sendMessage failed (attempt ${i + 1}/${attempts}), status ${res.status}`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, retryAfterMs));
    } catch (e) {
      console.error(`alertAdmin: sendMessage threw (attempt ${i + 1}/${attempts}):`, e);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  console.error('alertAdmin: giving up after all retries — admin alert was lost:', label);
}

// ---------------------------------------------------------------------------
// Firestore access via a Google OAuth2 service-account token (JWT bearer
// flow) — separate from the Firebase custom-token minting above, but reuses
// the same private key / client email and the same importPrivateKey().
//
// Cached at module scope: Cloudflare keeps a Worker's top-level state alive
// across requests on the same warm isolate, so a token minted for one
// button tap is reused by the next one instead of re-minting (and making an
// extra oauth2.googleapis.com round trip) on every single Firestore call.
// Google tokens are valid 1h; refreshed 2 min before expiry.
// ---------------------------------------------------------------------------
let cachedFirestoreToken = null;
let cachedFirestoreTokenExpiry = 0;

function firestoreProjectId(env) {
  // Service account emails look like name@PROJECT_ID.iam.gserviceaccount.com
  const m = env.FIREBASE_CLIENT_EMAIL.match(/@([^.]+)\.iam\.gserviceaccount\.com/);
  return m ? m[1] : '';
}

async function getFirestoreAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFirestoreToken && now < cachedFirestoreTokenExpiry - 120) {
    return cachedFirestoreToken;
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const unsigned = `${encHeader}.${encPayload}`;
  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, strToBuf(unsigned));
  const jwt = `${unsigned}.${base64urlFromBuf(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const data = await res.json();
  cachedFirestoreToken = data.access_token;
  cachedFirestoreTokenExpiry = now + (Number(data.expires_in) || 3600);
  return cachedFirestoreToken;
}

function fsField(fields, key) {
  const f = fields && fields[key];
  if (!f) return undefined;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('timestampValue' in f) return new Date(f.timestampValue);
  return undefined;
}

async function lookupAccountByTelegramId(env, telegramId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

    const linkRes = await fetch(`${base}/telegramAccounts/tg_${telegramId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!linkRes.ok) return null;
    const linkDoc = await linkRes.json();
    const guestId = fsField(linkDoc.fields, 'guestId');
    if (!guestId) return null;

    const userRes = await fetch(`${base}/users/${guestId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return null;
    const userDoc = await userRes.json();
    const f = userDoc.fields;
    return {
      guestId,
      name: fsField(f, 'name'),
      telegramUsername: fsField(f, 'telegramUsername'),
      walletBalance: fsField(f, 'walletBalance') || 0,
    };
  } catch (e) {
    console.error('lookupAccountByTelegramId failed:', e);
    return null;
  }
}

// Looks up a single order by its exact document ID (unlike
// lookupRecentOrders, which only returns the 5 most recent) — used by both
// "🔍 Track my order" and the "🧾 details" button under 📦 My Orders.
// Callers MUST check the returned order's `userId` against the requesting
// account's guestId before showing it — this function itself does no
// ownership check, so a raw call here would let anyone view any order by
// guessing its ID.
async function lookupOrderById(env, orderId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const res = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc.fields) return null;
    const f = doc.fields;
    return {
      id: orderId,
      userId: fsField(f, 'userId'),
      game: fsField(f, 'game'),
      price: fsField(f, 'price') || 0,
      status: fsField(f, 'status'),
      timestamp: fsField(f, 'timestamp'),
      // Optional — only present if the "orders" doc happens to carry them;
      // buildOrderDetailText() drops whichever of these come back undefined.
      paymentMethod: fsField(f, 'paymentMethod'),
      note: fsField(f, 'note'),
      receiptUrl: fsField(f, 'receiptUrl'),
      // Live order tracker (see handleOrderStatusNotify) + card details.
      tgMsgId: fsField(f, 'tgMsgId'),
      playerId: fsField(f, 'playerId'),
      serverId: fsField(f, 'serverId'),
      itemAmount: fsField(f, 'itemAmount'),
    };
  } catch (e) {
    console.error('lookupOrderById failed:', e);
    return null;
  }
}

async function lookupRecentOrders(env, guestId) {
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'orders' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'userId' },
            op: 'EQUAL',
            value: { stringValue: guestId },
          },
        },
        orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }],
        limit: 5,
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return rows
      .filter((r) => r.document)
      .map((r) => {
        const f = r.document.fields;
        return {
          id: r.document.name.split('/').pop(),
          game: fsField(f, 'game'),
          price: fsField(f, 'price') || 0,
          status: fsField(f, 'status'),
          timestamp: fsField(f, 'timestamp'),
        };
      });
  } catch (e) {
    console.error('lookupRecentOrders failed:', e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Connected-status push — tells the user (via the same bot) that their
// Telegram login is now linked, with User ID / Name / Balance / Connected
// Time. Called from index.html right after a first-time link succeeds.
// Body: { telegramId, guestId, name, balance }
// Best-effort: a Telegram API failure here must never block the sign-in
// flow that calls it, so this always returns 200 unless the payload itself
// is invalid.
// ---------------------------------------------------------------------------
async function handleNotifyConnected(request, env, corsHeaders) {
  const body = await safeJson(request);
  const telegramId = body && body.telegramId;
  if (!telegramId) return json({ error: 'Missing telegramId' }, 400, corsHeaders);

  const guestId = body.guestId ? String(body.guestId) : '-';
  const name = body.name ? String(body.name) : '-';
  const balance = Number(body.balance || 0);

  const connectedTime = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Yangon',
    hour12: false,
  }) + ' (Yangon)';

  const text =
    `✅ Telegram Connected\n\n` +
    `User ID: ${guestId}\n` +
    `Name: ${name}\n` +
    `Balance: ${balance.toLocaleString()} MMK\n` +
    `Connected Time: ${connectedTime}`;

  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text }),
    });
  } catch (e) {
    console.error('notify-connected send failed:', e);
  }

  return json({ ok: true }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// telegramBotUsers — every telegramId that has ever pressed /start or /menu,
// upserted (chatId/name/lastSeen) so /admin/broadcast below has a full
// audience list. Deliberately NOT the same as "telegramAccounts" (which only
// covers people who went on to link their PCA Store account) — a broadcast
// like "Account buying is live now" should reach anyone who's ever opened
// the bot, linked or not.
// ---------------------------------------------------------------------------
async function trackBotUser(env, telegramId, chatId, from) {
  try {
    await fsSetDoc(env, `telegramBotUsers/${telegramId}`, {
      chatId: String(chatId),
      firstName: (from && from.first_name) || '',
      username: (from && from.username) || '',
      lastSeen: new Date(),
    });
  } catch (e) {
    console.error('trackBotUser failed:', e);
  }
}

async function listBotUserChatIds(env) {
  const chatIds = [];
  try {
    const token = await getFirestoreAccessToken(env);
    const projectId = firestoreProjectId(env);
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    let pageToken;
    do {
      const qs = new URLSearchParams({ pageSize: '300' });
      if (pageToken) qs.set('pageToken', pageToken);
      const res = await fetch(`${base}/telegramBotUsers?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;
      const data = await res.json();
      (data.documents || []).forEach((d) => {
        const chatId = fsField(d.fields, 'chatId') || d.name.split('/').pop();
        if (chatId) chatIds.push({ telegramId: d.name.split('/').pop(), chatId });
      });
      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.error('listBotUserChatIds failed:', e);
  }
  return chatIds;
}

// ---------------------------------------------------------------------------
// POST /admin/broadcast — see the header comment for the full contract.
// Validates + kicks the actual send off via ctx.waitUntil so the caller
// (admin.html) doesn't sit there waiting on a few hundred sequential
// Telegram API calls; it just gets an immediate "accepted" back.
// ---------------------------------------------------------------------------
async function handleAdminBroadcast(request, env, ctx, corsHeaders) {
  const configuredSecret = await getAdminBroadcastSecret(env);
  if (!configuredSecret) {
    return json({ error: 'Broadcast not configured' }, 500, corsHeaders);
  }
  const body = await safeJson(request);
  if (!body || body.secret !== configuredSecret) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: 'Missing text' }, 400, corsHeaders);

  let replyMarkup;
  if (body.buttonText && body.buttonUrl) {
    replyMarkup = { inline_keyboard: [[{ text: String(body.buttonText), web_app: { url: String(body.buttonUrl) } }]] };
  }

  const recipients = await listBotUserChatIds(env);
  const task = broadcastToUsers(env, recipients, text, replyMarkup);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task);
  } else {
    // Local/dev fallback with no waitUntil available — just await inline.
    await task;
  }
  return json({ ok: true, accepted: true, recipients: recipients.length }, 200, corsHeaders);
}

// Sends `text` (+ optional single inline button) to every recipient, in
// small concurrent batches with a pause between them so this stays well
// under Telegram's ~30 messages/second bot-wide rate limit even for a
// large user list. A 403 back from Telegram means that user has blocked
// the bot (or deleted their account) — those are pruned from
// telegramBotUsers so future broadcasts don't keep paying for them.
async function broadcastToUsers(env, recipients, text, replyMarkup) {
  const BATCH_SIZE = 20;
  const BATCH_DELAY_MS = 1100;
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((r) => sendBroadcastMessage(env, r.chatId, text, replyMarkup))
    );
    for (let j = 0; j < results.length; j++) {
      const res = results[j];
      if (res.status === 'fulfilled' && res.value.ok) {
        sent++;
      } else {
        failed++;
        if (res.status === 'fulfilled' && res.value.blocked) {
          clearBotUser(env, batch[j].telegramId).catch(() => {});
        }
      }
    }
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
  console.log(`broadcastToUsers: sent=${sent} failed=${failed} total=${recipients.length}`);
}

async function sendBroadcastMessage(env, chatId, text, replyMarkup) {
  try {
    const payload = { chat_id: chatId, text };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    // error_code 403 = "bot was blocked by the user" / user deactivated.
    return { ok: false, blocked: data.error_code === 403 };
  } catch (e) {
    return { ok: false, blocked: false };
  }
}

async function clearBotUser(env, telegramId) {
  try {
    await fsDeleteDoc(env, `telegramBotUsers/${telegramId}`);
  } catch (e) {
    console.error('clearBotUser failed:', e);
  }
}

// ---------------------------------------------------------------------------
// POST /notify-order-status — admin.html calls this right after an order's
// status changes (Pending -> Processing -> Success/Fail), so the customer
// gets a DM through pcagamestore_bot instead of only finding out next time
// they reopen the Store app.
//
// { secret, telegramId, orderId, status, game?, price?, note? } — `secret`
// must match ADMIN_BROADCAST_SECRET (same shared secret /admin/broadcast
// uses; this is just another admin-triggered push, to one person instead of
// everyone). `telegramId` is the value written to users/{uid}.telegramId
// when that customer linked Telegram — for a one-on-one Telegram chat,
// chat_id === that same id, so no telegramBotUsers lookup is needed here
// (unlike /admin/broadcast, which needs a chatId per recipient).
// ---------------------------------------------------------------------------
async function handleOrderStatusNotify(request, env, corsHeaders) {
  const configuredSecret = await getAdminBroadcastSecret(env);
  if (!configuredSecret) {
    return json({ error: 'Not configured' }, 500, corsHeaders);
  }
  const body = await safeJson(request);
  if (!body || body.secret !== configuredSecret) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  const telegramId = body.telegramId ? String(body.telegramId) : '';
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!telegramId || !status) {
    return json({ error: 'Missing telegramId or status' }, 400, corsHeaders);
  }
  const orderId = body.orderId ? String(body.orderId) : '';
  const game = body.game ? String(body.game) : '';
  const price = Number(body.price || 0);
  const note = body.note ? String(body.note) : '';
  const details = {
    inGameId: body.inGameId ? String(body.inGameId) : '',
    serverId: body.serverId ? String(body.serverId) : '',
    packageName: body.packageName ? String(body.packageName) : '',
  };

  const norm = status.toLowerCase();
  const isFinal = ['success', 'completed', 'delivered', 'fail', 'failed', 'rejected'].includes(norm);

  // --- Live order tracker -------------------------------------------------
  // ONE message per order that shows the status as buttons
  // (✅ Pending → 🟡 Processing → ⚪ Success) and is EDITED in place on every
  // status change (no new push per step). Its message id is saved on
  // orders/{id}.tgMsgId. The status shown is always read live from Firestore,
  // so a late/out-of-order push can never roll the tracker back.
  const orderRec = orderId ? await lookupOrderById(env, orderId) : null;
  const liveStatus = (orderRec && orderRec.status) || status;
  const trackerInfo = {
    game: game || (orderRec && orderRec.game) || '',
    price: price || (orderRec && Number(orderRec.price)) || 0,
    inGameId: details.inGameId || (orderRec && orderRec.playerId) || '',
    serverId: details.serverId || (orderRec && orderRec.serverId) || '',
    packageName: details.packageName || (orderRec && orderRec.itemAmount) || '',
  };
  const trackerText = orderTrackerText(liveStatus, orderId, trackerInfo);
  const trackerMarkup = orderTrackerKeyboard(orderId, liveStatus);

  let trackerUpdated = false;
  if (orderRec && orderRec.tgMsgId) {
    const ed = await editTelegramMessageChecked(env, telegramId, Number(orderRec.tgMsgId), trackerText, trackerMarkup);
    trackerUpdated = ed.ok;
  }
  if (!trackerUpdated) {
    const sent = await sendTelegramMessageChecked(env, telegramId, trackerText, trackerMarkup);
    // Tell the caller when Telegram refused the DM (user blocked the bot, bad
    // id, API down) — the order Worker only records "DM sent" on a 2xx.
    if (!sent.ok) {
      return json({ ok: false, delivered: false, blocked: !!sent.blocked }, sent.blocked ? 200 : 502, corsHeaders);
    }
    if (orderId && sent.messageId) {
      try { await fsMergeDoc(env, `orders/${orderId}`, { tgMsgId: String(sent.messageId) }); }
      catch (e) { console.error('save tgMsgId failed:', e); }
    }
  }

  // Success / Fail also get their own full-details message, so the customer's
  // phone actually buzzes (an edit alone makes no notification sound).
  if (isFinal) {
    const text = orderStatusMessageText(status, orderId, game, price, note, details);
    const sent = await sendTelegramMessageChecked(env, telegramId, text, openAppInlineKeyboard());
    if (!sent.ok) {
      return json({ ok: false, delivered: false, blocked: !!sent.blocked }, sent.blocked ? 200 : 502, corsHeaders);
    }
    await maybeSendLowBalanceAlert(env, telegramId);
  }
  return json({ ok: true, delivered: true }, 200, corsHeaders);
}

const STATUS_LABEL_MY = {
  pending: '🟡 စောင့်ဆိုင်းနေပါသည်',
  processing: '🟡 လုပ်ဆောင်နေပါသည်',
  success: '✅ ပြီးစီးပါပြီ',
  fail: '❌ မအောင်မြင်ပါ',
};
function normalizeOrderStatus(status) {
  const n = (status || '').trim().toLowerCase();
  if (n === 'completed' || n === 'delivered') return 'success';
  if (n === 'failed' || n === 'rejected') return 'fail';
  return n;
}

// Compact "live" order card: details + current status + last-refresh time.
function orderTrackerText(status, orderId, info) {
  const i = info || {};
  const key = normalizeOrderStatus(status);
  const lines = [
    `📦 Order #${orderId || '-'}${i.game ? ` — ${i.game}` : ''}`,
    i.packageName ? `Package: ${i.packageName}` : '',
    i.inGameId ? `Game ID: ${i.inGameId}${i.serverId ? ` (${i.serverId})` : ''}` : '',
    Number(i.price) > 0 ? `ဈေးနှုန်း: ${Number(i.price).toLocaleString()} MMK` : '',
    '',
    `အခြေအနေ: ${STATUS_LABEL_MY[key] || status}`,
    `🕐 ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Yangon', hour12: false })} (Yangon) — 🔄 နှိပ်ပြီး နောက်ဆုံးအခြေအနေကြည့်ပါ`,
  ];
  return lines.filter((l, idx) => l !== '' || idx === 4).join('\n');
}

// Keyboard layout (all rows even):
//   [ current status badge — full width ]
//   [ 🔄 Refresh ][ 🚀 Open Store ]
//   [ 💬 Contact Support ]            (Fail only)
// The badge shows ONLY the order's real current status; tapping it (or Refresh)
// re-reads the order from Firestore and edits the message.
const STATUS_BADGE = {
  pending: '🟡 Pending — စောင့်ဆိုင်းနေသည်',
  processing: '🔵 Processing — လုပ်ဆောင်နေသည်',
  success: '✅ Success — ပြီးစီးပါပြီ',
  fail: '❌ Failed — မအောင်မြင်ပါ',
};
function orderTrackerKeyboard(orderId, status) {
  const key = normalizeOrderStatus(status);
  const cb = `ordst:${orderId}`;
  const rows = [
    [{ text: STATUS_BADGE[key] || `🔔 ${status || '-'}`, callback_data: cb }],
    [{ text: '🔄 Refresh', callback_data: cb }, { text: '🚀 Open Store', web_app: { url: STORE_URL } }],
  ];
  if (key === 'fail') rows.push([{ text: '💬 Contact Support', url: 'https://t.me/pca_gamestore' }]);
  return { inline_keyboard: rows };
}

async function handleOrderTrackerCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const telegramId = String(cq.from.id);
  const orderId = (cq.data || '').split(':')[1];
  if (!chatId || !messageId || !orderId) return answerCallbackQuery(env, cq.id);
  const [acct, order] = await Promise.all([
    lookupAccountByTelegramId(env, telegramId),
    lookupOrderById(env, orderId),
  ]);
  if (!acct || !order || order.userId !== acct.guestId) {
    return answerCallbackQuery(env, cq.id, 'ဤ Order ကို မတွေ့ရှိပါ။');
  }
  await editTelegramMessageChecked(
    env, chatId, messageId,
    orderTrackerText(order.status, order.id, {
      game: order.game, price: order.price, inGameId: order.playerId,
      serverId: order.serverId, packageName: order.itemAmount,
    }),
    orderTrackerKeyboard(order.id, order.status)
  );
}

// ---------------------------------------------------------------------------
// POST /notify-topup-status — { secret, telegramId, amount, status }
// Called by the order Worker (notifyTopupCustomer) once an admin confirms or
// rejects a wallet top-up. Same shared secret as /notify-order-status.
// ---------------------------------------------------------------------------
async function handleTopupStatusNotify(request, env, corsHeaders) {
  const configuredSecret = await getAdminBroadcastSecret(env);
  if (!configuredSecret) return json({ error: 'Not configured' }, 500, corsHeaders);
  const body = await safeJson(request);
  if (!body || body.secret !== configuredSecret) return json({ error: 'Unauthorized' }, 401, corsHeaders);
  const telegramId = body.telegramId ? String(body.telegramId) : '';
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!telegramId || !status) return json({ error: 'Missing telegramId or status' }, 400, corsHeaders);
  const amount = Number(body.amount || 0);
  const amountText = amount > 0 ? `${amount.toLocaleString()} MMK` : '-';
  const norm = status.toLowerCase();

  let text;
  let markup = openAppInlineKeyboard();
  if (norm === 'completed' || norm === 'success' || norm === 'approved') {
    const acct = await lookupAccountByTelegramId(env, telegramId);
    const balLine = acct ? `\nလက်ကျန်ငွေ: ${Number(acct.walletBalance || 0).toLocaleString()} MMK` : '';
    text = `✅ Top Up အောင်မြင်ပါပြီ\n\nပမာဏ: ${amountText}${balLine}\n\nWallet ထဲ ပေါင်းထည့်ပြီးပါပြီ။ ကျေးဇူးတင်ပါတယ်!`;
  } else if (norm === 'rejected' || norm === 'fail' || norm === 'failed') {
    text = `❌ Top Up မအောင်မြင်ပါ\n\nပမာဏ: ${amountText}\n\nReceipt (သို့) ငွေလွှဲမှု မှန်ကန်မှုမရှိသဖြင့် ပယ်ချလိုက်ပါသည်။ အသေးစိတ်သိရှိလိုပါက Help Center သို့ ဆက်သွယ်ပါ။`;
    markup = { inline_keyboard: [[{ text: '💬 Contact Support', url: 'https://t.me/pca_gamestore' }]] };
  } else {
    text = `🔔 Top Up Update\n\nပမာဏ: ${amountText}\nအခြေအနေ: ${status}`;
  }
  const sent = await sendTelegramMessageChecked(env, telegramId, text, markup);
  if (!sent.ok) return json({ ok: false, delivered: false, blocked: !!sent.blocked }, sent.blocked ? 200 : 502, corsHeaders);
  return json({ ok: true, delivered: true }, 200, corsHeaders);
}

const LOW_BALANCE_THRESHOLD = 5000; // MMK — matches WALLET_TOPUP_MIN, the smallest top-up worth making

// Best-effort nudge: right after an order-status push (the point a purchase
// most recently touched this customer's balance), checks their current
// wallet balance and, if it's run low, sends a separate "top up before your
// next order fails" DM. NOT a realtime wallet watcher — this Worker has no
// other hook into wallet writes (those happen in admin.html/store.html,
// outside this file) — so a balance drop with no order attached (e.g. a
// manual admin adjustment) won't trigger this. Fires on every low-balance
// order-status push with no de-dupe/cooldown yet; add a "lastWarnedAt" flag
// on the user doc later if repeat alerts across several small orders in a
// row turn out to be too chatty.
async function maybeSendLowBalanceAlert(env, telegramId) {
  try {
    const acct = await lookupAccountByTelegramId(env, telegramId);
    if (!acct) return;
    const balance = Number(acct.walletBalance || 0);
    if (balance > 0 && balance < LOW_BALANCE_THRESHOLD) {
      await sendTelegramMessage(
        env, telegramId,
        `⚠️ Wallet လက်ကျန် နည်းနေပါပြီ (${balance.toLocaleString()} MMK)။\n\nနောက် Order တင်ရင် ငွေမလုံလောက်ဘဲ ပျက်မသွားအောင် အခုပဲ Top Up လုပ်ထားပါ။`,
        { inline_keyboard: [[{ text: '➕ Top Up Wallet', url: STORE_URL }]] }
      );
    }
  } catch (e) {
    console.error('maybeSendLowBalanceAlert failed:', e);
  }
}

// Friendly Burmese wording per order status. admin.html's "orders" collection
// only ever uses Pending/Processing/Success/Fail, but this also recognizes a
// few synonyms (Completed/Delivered/Rejected) in case that ever changes, and
// falls back to a generic "status changed to X" line for anything else -
// so a new status added in admin.html doesn't also need a matching Worker
// deploy just to keep notifying.
// Small text-based progress track for an order's status — Telegram has no
// real progress-bar widget, so a "🟢 Pending → 🟡 Processing → ⚪ Success"
// line stands in for one. Recognizes the same status set + synonyms as
// orderStatusMessageText below, and degrades to just the raw status text for
// anything unrecognized instead of guessing.
function orderTimelineLine(status) {
  const stages = ['Pending', 'Processing', 'Success'];
  const norm = (status || '').trim().toLowerCase();
  if (norm === 'fail' || norm === 'failed' || norm === 'rejected') {
    return '🟢 Pending → 🟢 Processing → ❌ Fail';
  }
  const idx = stages.findIndex((s) => s.toLowerCase() === norm);
  if (idx === -1) return status ? `🔔 ${status}` : '';
  return stages.map((s, i) => `${i < idx ? '🟢' : i === idx ? (idx === stages.length - 1 ? '🟢' : '🟡') : '⚪'} ${s}`).join(' → ');
}

function formatOrderDate(ts) {
  if (!(ts instanceof Date) || isNaN(ts.getTime())) return '';
  // en-GB gives DD/MM/YYYY, HH:MM — reads unambiguously either way round for
  // a Myanmar audience, unlike MM/DD/YYYY.
  return ts.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function orderStatusMessageText(status, orderId, game, price, note, details) {
  const d = details || {};
  const orderLine = `Order #${orderId || '-'}${game ? ` — ${game}` : ''}`;
  const detailLines = [
    d.packageName ? `Package: ${d.packageName}` : '',
    d.inGameId ? `Game ID: ${d.inGameId}${d.serverId ? ` (${d.serverId})` : ''}` : '',
  ].filter(Boolean);
  const priceLine = (detailLines.length ? '\n' + detailLines.join('\n') : '') + (price > 0 ? `\nဈေးနှုန်း: ${price.toLocaleString()} MMK` : '');
  const noteLine = note ? `\n\n${note}` : '';
  const timeline = orderTimelineLine(status);
  const timelineLine = timeline ? `\n\n${timeline}` : '';
  const norm = status.toLowerCase();
  if (norm === 'success' || norm === 'completed' || norm === 'delivered') {
    return `✅ Order ပြီးစီးပါပြီ!\n\n${orderLine}${priceLine}\n\nအော်ဒါ ပို့ဆောင်ပြီးပါပြီ။ ကျေးဇူးတင်ပါတယ်!${timelineLine}${noteLine}`;
  }
  if (norm === 'fail' || norm === 'failed' || norm === 'rejected') {
    return `❌ Order မအောင်မြင်ပါ\n\n${orderLine}${priceLine}\n\nပြဿနာတစ်ခုခု ဖြစ်ပွားခဲ့ပါသည်။ အသေးစိတ် သိရှိလိုပါက Help Center သို့ ဆက်သွယ်ပါ။${timelineLine}${noteLine}`;
  }
  if (norm === 'processing') {
    return `⏳ Order စီစဉ်နေပါသည်\n\n${orderLine}${priceLine}\n\nခဏစောင့်ပေးပါ၊ လုပ်ဆောင်နေပါသည်။${timelineLine}${noteLine}`;
  }
  return `🔔 Order Update\n\n${orderLine}${priceLine}\n\nအခြေအနေ: ${status}${timelineLine}${noteLine}`;
}


async function mintFirebaseToken(env, tgUser) {
  const uid = `tg_${tgUser.id}`;
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: FIREBASE_AUD,
    iat: now,
    exp: now + 3600,
    uid,
    claims: {
      telegram_id: tgUser.id,
      telegram_username: tgUser.username || null,
    },
  };

  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const unsigned = `${encHeader}.${encPayload}`;

  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    strToBuf(unsigned)
  );

  return `${unsigned}.${base64urlFromBuf(signature)}`;
}

async function importPrivateKey(pem) {
  const normalized = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  const pemBody = normalized
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// ---------------------------------------------------------------------------
// Crypto / encoding helpers
// ---------------------------------------------------------------------------
function strToBuf(str) {
  return new TextEncoder().encode(str);
}

async function sha256Raw(buf) {
  return crypto.subtle.digest('SHA-256', buf);
}

async function hmacSha256Raw(keyBuf, msgBuf) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, msgBuf);
}

async function hmacSha256Hex(keyBuf, msgBuf) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, msgBuf);
  return bufToHex(sig);
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Same constant-time comparison, but for arbitrary strings (e.g. the
// Telegram webhook secret token) rather than hex digests specifically.
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function buildDataCheckString(params) {
  const keys = [...params.keys()].sort();
  return keys.map((k) => `${k}=${params.get(k)}`).join('\n');
}

function base64url(str) {
  return base64urlFromBuf(strToBuf(str).buffer);
}

function base64urlFromBuf(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function buildCorsHeaders(origin, env) {
  const list = originList(env);
  const allow = list.includes(origin) ? origin : list[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}
