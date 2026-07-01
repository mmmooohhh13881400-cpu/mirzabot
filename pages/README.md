# Mirzabot Cloudflare integration

این شاخه `worker-integration` شامل فایل‌های لازم برای اجرای وب‌هوک تلگرام و داشبورد سادهٔ مدیریت روی Cloudflare Workers + Pages است. هدف: حذف نیاز به VPS و ارسال سفارش‌ها به صورت pending تا ادمین دستی تایید کند.

فایل‌های اضافه شده:
- worker/index.js  — کد Worker برای webhook، notify_payment و API‌های admin
- pages/admin/index.html — داشبورد ساده برای راه‌اندازی و مدیریت سفارش‌ها
- payment/worker_notify_helper.php — نمونه helper برای ارسال POST به Worker (در ادامه)

پیش‌نیازها (Cloudflare)
1. یک KV namespace بساز و آن را bind کن با نام ORDERS.
   - با wrangler: `wrangler kv:namespace create "ORDERS" --binding ORDERS`
2. در Worker settings یک secret به نام `SETUP_SECRET` اضافه کن (یک مقدار تصادفی که فقط تو می‌دونی).
3. پابلیش Worker (با wrangler یا از داشبورد) و Pages را برای دایرکتوری `pages/` تنظیم کن (یا می‌تونی صفحهٔ admin را در یک هاست جداگانه میزبانی کنی).

راه‌اندازی اولیه
1. به آدرس صفحهٔ admin برو (مثلاً https://your-pages-domain/admin)
2. مقدار SETUP_SECRET را که در Cloudflare ست کردی وارد کن و سپس توکن ربات، admin_chat_id (گروه)، payment_secret و admin_pass را وارد کن. این مقادیر در KV ذخیره می‌شوند.
3. پس از ثبت، کاربرانی که خرید انجام می‌دهند، payment callback در PHP باید یک POST با header `x-payment-secret` برابر value که در مرحلهٔ setup وارد کردی، به `https://<your-worker-domain>/notify_payment` ارسال کنند.

تنظیم Webhook تلگرام
- وقتی TELEGRAM_TOKEN را در KV ذخیره کردی، از دستور زیر (در لوکال یا سرور) webhook را ست کن:

curl -F "url=https://<your-worker-domain>/telegram_webhook" https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook

نمونه helper PHP برای ارسال notify (payment/worker_notify_helper.php)
````php
<?php
function notify_worker($worker_url, $payment_secret, $payload){
  $ch = curl_init($worker_url . '/notify_payment');
  curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
  curl_setopt($ch, CURLOPT_POST, true);
  curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json', 'x-payment-secret: ' . $payment_secret]);
  curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
  $res = curl_exec($ch);
  curl_close($ch);
  return $res;
}

// استفاده مثال در payment/zarinpal.php پس از تایید پرداخت:
// $payload = [ 'user_id' => $telegram_user_id, 'username'=> $username, 'amount'=>$amount, 'product_type'=>'sub', 'product_value'=>$link_or_cred, 'product_name'=>$product_name ];
// notify_worker('https://example.workers.dev', 'PAYMENT_SECRET_VALUE', $payload);
````

نکات امنیتی
- توکن ربات و payment secret را در SETUP فقط از طریق رابط امن (SETUP_SECRET) وارد کن.
- پس از راه‌اندازی اولیه، اگر می‌خواهی امنیت را افزایش دهی، از Cloudflare Access یا secret binding (wrangler secret put TELEGRAM_TOKEN) به جای ذخیره‌سازی در KV استفاده کن.

نحوهٔ تست
1. راه‌اندازی اولیه با فرم admin
2. اجرای یک POST شبیه پرداخت به /notify_payment با header x-payment-secret و payload مناسب
3. مشاهدهٔ پیام در گروه ادمین و تایید از طریق دکمه
4. پس از تایید، کاربر باید پیام حاوی ساب یا یوزرنیم/پسورد را دریافت کند

اگر می‌خواهی من تغییرات فایل‌های payment/* را خودکار اعمال کنم تا از helper استفاده کنند، بگو تا آن‌ها را هم اصلاح کنم (من با placeholder و بدون توکن واقعی تغییر می‌دهم). همچنین اگر می‌خواهی من PR بسازم و تغییرات را مستقیم در شاخه worker-integration قرار دهم، بگو ادامه بدم.