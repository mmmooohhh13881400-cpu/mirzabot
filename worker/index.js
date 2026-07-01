// name=worker/index.js
// Cloudflare Worker script for mirzabot integration
// Bindings required (set in Cloudflare):
// - ORDERS (KV namespace)
// - SETUP_SECRET (secret string) [used only for initial setup via admin UI]
// Note: TELEGRAM_TOKEN, PAYMENT_SECRET, ADMIN_CHAT_ID, ADMIN_PASS will be stored into KV via the /setup endpoint.

const TELEGRAM_TOKEN_KEY = 'secret:TELEGRAM_TOKEN';
const PAYMENT_SECRET_KEY = 'secret:PAYMENT_SECRET';
const ADMIN_CHAT_ID_KEY = 'secret:ADMIN_CHAT_ID';
const ADMIN_PASS_KEY = 'secret:ADMIN_PASS';

async function telegramRequest(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function genId() {
  return crypto.randomUUID();
}

async function saveOrder(env, orderId, order) {
  await env.ORDERS.put(`order:${orderId}`, JSON.stringify(order));
}
async function getOrder(env, orderId) {
  const v = await env.ORDERS.get(`order:${orderId}`);
  return v ? JSON.parse(v) : null;
}
async function listOrders(env) {
  const list = [];
  // KV list with prefix order:
  let cursor = undefined;
  do {
    const res = await env.ORDERS.list({ prefix: 'order:', cursor });
    for (const key of res.keys) {
      const v = await env.ORDERS.get(key.name);
      try {
        list.push(JSON.parse(v));
      } catch (e) {}
    }
    cursor = res.cursor;
  } while (cursor);
  // sort by created_at desc
  list.sort((a,b)=> (b.created_at||0)-(a.created_at||0));
  return list;
}

async function notifyAdmin(env, order) {
  const token = await env.ORDERS.get(TELEGRAM_TOKEN_KEY);
  const adminChat = await env.ORDERS.get(ADMIN_CHAT_ID_KEY);
  if (!token || !adminChat) return;
  const orderId = order.id;
  const text = `🔔 سفارش جدید\n#${orderId}\nکاربر: ${order.username || '—'} (${order.user_id})\nمحصول: ${order.product_name}\nمبلغ: ${order.amount}\nنوع: ${order.product_type}`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ تایید', callback_data: `approve:${orderId}` },
        { text: '❌ رد', callback_data: `reject:${orderId}` }
      ]
    ]
  };
  await telegramRequest(token, 'sendMessage', {
    chat_id: adminChat,
    text,
    reply_markup: keyboard,
    parse_mode: 'HTML'
  });
}

async function deliverProduct(env, order) {
  const token = await env.ORDERS.get(TELEGRAM_TOKEN_KEY);
  const uid = order.user_id;
  if (!token) return;
  if (order.product_type === 'sub') {
    try {
      const r = await fetch(order.product_value);
      const body = await r.text();
      const text = body.replace(/<[^>]+>/g, '').trim().slice(0, 3500);
      await telegramRequest(token, 'sendMessage', { chat_id: uid, text: `📩 لینک ساب شما:\n\n${text}` });
    } catch (e) {
      await telegramRequest(token, 'sendMessage', { chat_id: uid, text: `خطا در واکشی لینک ساب: ${e.message}\nلینک: ${order.product_value}` });
    }
  } else if (order.product_type === 'cred') {
    let txt;
    if (typeof order.product_value === 'object') {
      txt = `یوزرنیم: ${order.product_value.username}\nپسورد: ${order.product_value.password}`;
    } else {
      txt = String(order.product_value);
    }
    await telegramRequest(token, 'sendMessage', { chat_id: uid, text: `📩 اطلاعات ورود:\n\n${txt}` });
  } else {
    await telegramRequest(token, 'sendMessage', { chat_id: uid, text: `📩 محصول شما:\n${order.product_value}` });
  }
  order.status = 'delivered';
  order.delivered_at = Date.now();
  await saveOrder(env, order.id, order);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Setup endpoint: store TELEGRAM_TOKEN, PAYMENT_SECRET, ADMIN_CHAT_ID, ADMIN_PASS into KV
    if (path === '/setup' && request.method === 'POST') {
      const setupSecret = env.SETUP_SECRET; // must be set in Worker env
      const h = request.headers.get('x-setup-secret');
      if (!setupSecret || !h || h !== setupSecret) return new Response('forbidden', { status: 403 });
      const payload = await request.json();
      if (payload.telegram_token) await env.ORDERS.put(TELEGRAM_TOKEN_KEY, payload.telegram_token);
      if (payload.payment_secret) await env.ORDERS.put(PAYMENT_SECRET_KEY, payload.payment_secret);
      if (payload.admin_chat_id) await env.ORDERS.put(ADMIN_CHAT_ID_KEY, String(payload.admin_chat_id));
      if (payload.admin_pass) await env.ORDERS.put(ADMIN_PASS_KEY, payload.admin_pass);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Public webhook for Telegram
    if (path === '/telegram_webhook' && request.method === 'POST') {
      const body = await request.json().catch(()=>null);
      if (!body) return new Response('ok');
      // handle callback_query (approve/reject)
      if (body.callback_query) {
        const data = body.callback_query.data || '';
        const from = body.callback_query.from || {};
        const token = await env.ORDERS.get(TELEGRAM_TOKEN_KEY);
        const adminChat = await env.ORDERS.get(ADMIN_CHAT_ID_KEY);
        const parts = data.split(':');
        const action = parts[0];
        const orderId = parts[1];
        const order = await getOrder(env, orderId);
        if (!order) {
          // answer callback
          if (token) await telegramRequest(token, 'answerCallbackQuery', { callback_query_id: body.callback_query.id, text: 'سفارش پیدا نشد.' });
          return new Response('ok');
        }
        // check that the user pressing is admin (either same chat id or user id equals admin_pass? we'll trust admin chat membership)
        // For safety: only allow if callback_query.message.chat.id == adminChat
        const callbackChatId = body.callback_query.message?.chat?.id;
        if (String(callbackChatId) !== String(adminChat)) {
          if (token) await telegramRequest(token, 'answerCallbackQuery', { callback_query_id: body.callback_query.id, text: 'دست��سی ندارید.' });
          return new Response('ok');
        }
        if (action === 'approve') {
          order.status = 'approved';
          order.approved_by = from.id;
          order.approved_at = Date.now();
          await saveOrder(env, orderId, order);
          // deliver product
          await deliverProduct(env, order);
          if (token) await telegramRequest(token, 'answerCallbackQuery', { callback_query_id: body.callback_query.id, text: 'سفارش تایید و ارسال شد.' });
        } else if (action === 'reject') {
          order.status = 'rejected';
          order.rejected_by = from.id;
          order.rejected_at = Date.now();
          await saveOrder(env, orderId, order);
          if (token) {
            await telegramRequest(token, 'answerCallbackQuery', { callback_query_id: body.callback_query.id, text: 'سفارش رد شد.' });
            await telegramRequest(token, 'sendMessage', { chat_id: order.user_id, text: 'سفارش شما رد شد. لطفا با پشتیبانی تماس بگیرید.' });
          }
        }
        return new Response('ok');
      }
      // ignore other updates for now
      return new Response('ok');
    }

    // Payment notification endpoint (called by PHP payment callbacks)
    if (path === '/notify_payment' && request.method === 'POST') {
      const paymentSecret = await env.ORDERS.get(PAYMENT_SECRET_KEY);
      const headerSecret = request.headers.get('x-payment-secret');
      if (!paymentSecret || headerSecret !== paymentSecret) {
        return new Response('forbidden', { status: 403 });
      }
      const payload = await request.json().catch(()=>null);
      if (!payload) return new Response('bad request', { status: 400 });
      const orderId = genId();
      const order = {
        id: orderId,
        user_id: payload.user_id,
        username: payload.username || null,
        amount: payload.amount || 0,
        product_type: payload.product_type || 'cred',
        product_value: payload.product_value || payload.product_value_raw || '',
        product_name: payload.product_name || '',
        status: 'pending',
        created_at: Date.now()
      };
      await saveOrder(env, orderId, order);
      await notifyAdmin(env, order);
      return new Response(JSON.stringify({ ok: true, orderId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Admin API: create order (manual)
    if (path === '/api/create' && request.method === 'POST') {
      const body = await request.json().catch(()=>null);
      const pass = request.headers.get('x-admin-pass') || (body && body.admin_pass);
      const adminPass = await env.ORDERS.get(ADMIN_PASS_KEY);
      if (!adminPass || pass !== adminPass) return new Response('forbidden', { status: 403 });
      if (!body) return new Response('bad request', { status: 400 });
      const orderId = genId();
      const order = {
        id: orderId,
        user_id: body.user_id,
        username: body.username || null,
        amount: body.amount || 0,
        product_type: body.product_type || 'cred',
        product_value: body.product_value || '',
        product_name: body.product_name || '',
        status: 'pending',
        created_at: Date.now(),
        created_by: 'admin-web'
      };
      await saveOrder(env, orderId, order);
      await notifyAdmin(env, order);
      return new Response(JSON.stringify({ ok: true, orderId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Admin API: list orders
    if (path === '/api/orders' && request.method === 'GET') {
      // simple auth via query param ?admin_pass=...
      const urlp = new URL(request.url);
      const pass = urlp.searchParams.get('admin_pass') || request.headers.get('x-admin-pass');
      const adminPass = await env.ORDERS.get(ADMIN_PASS_KEY);
      if (!adminPass || pass !== adminPass) return new Response('forbidden', { status: 403 });
      const list = await listOrders(env);
      return new Response(JSON.stringify({ ok: true, orders: list }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Admin API: approve order (POST { orderId })
    if (path === '/api/approve' && request.method === 'POST') {
      const body = await request.json().catch(()=>null);
      const pass = request.headers.get('x-admin-pass') || (body && body.admin_pass);
      const adminPass = await env.ORDERS.get(ADMIN_PASS_KEY);
      if (!adminPass || pass !== adminPass) return new Response('forbidden', { status: 403 });
      const orderId = body.orderId;
      const order = await getOrder(env, orderId);
      if (!order) return new Response('not found', { status: 404 });
      order.status = 'approved';
      order.approved_by = 'admin-web';
      order.approved_at = Date.now();
      await saveOrder(env, orderId, order);
      await deliverProduct(env, order);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Admin API: reject order
    if (path === '/api/reject' && request.method === 'POST') {
      const body = await request.json().catch(()=>null);
      const pass = request.headers.get('x-admin-pass') || (body && body.admin_pass);
      const adminPass = await env.ORDERS.get(ADMIN_PASS_KEY);
      if (!adminPass || pass !== adminPass) return new Response('forbidden', { status: 403 });
      const orderId = body.orderId;
      const order = await getOrder(env, orderId);
      if (!order) return new Response('not found', { status: 404 });
      order.status = 'rejected';
      order.rejected_by = 'admin-web';
      order.rejected_at = Date.now();
      await saveOrder(env, orderId, order);
      const token = await env.ORDERS.get(TELEGRAM_TOKEN_KEY);
      if (token) await telegramRequest(token, 'sendMessage', { chat_id: order.user_id, text: 'سفارش شما رد شد. لطفا با پشتیبانی تماس بگیرید.' });
      await saveOrder(env, orderId, order);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Serve the admin static page if Pages is set up to route here (for manual testing)
    if (path === '/' && request.method === 'GET') {
      return new Response('mirzabot worker running', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  }
};
