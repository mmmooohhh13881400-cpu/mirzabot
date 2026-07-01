<?php
// worker_notify_helper.php
// A small helper to call the Worker notify endpoint after successful payment
function mirza_notify_worker($worker_url, $payment_secret, $user_id, $username, $amount, $product_type, $product_value, $product_name){
  $payload = [
    'user_id' => $user_id,
    'username' => $username,
    'amount' => $amount,
    'product_type' => $product_type,
    'product_value' => $product_value,
    'product_name' => $product_name
  ];
  $ch = curl_init(rtrim($worker_url, '/') . '/notify_payment');
  curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
  curl_setopt($ch, CURLOPT_POST, true);
  curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json', 'x-payment-secret: ' . $payment_secret]);
  curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
  $res = curl_exec($ch);
  curl_close($ch);
  return $res;
}

// Usage example in a payment callback (after verifying transaction):
// require 'worker_notify_helper.php';
// $worker_url = 'https://example.workers.dev';
// $payment_secret = 'your_payment_secret_used_in_setup';
// $res = mirza_notify_worker($worker_url, $payment_secret, $telegram_user_id, $username, $amount, 'sub', $link_or_cred, $product_name);
