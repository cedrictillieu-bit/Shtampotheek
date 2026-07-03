// Supabase Edge Function: send-push
//
// Sends a Web Push notification to every subscribed device.
// Called in two ways:
//   1. A Database Webhook on INSERT into `parties`  -> payload is Supabase's
//      webhook shape: { type, table, record, old_record }
//   2. A pg_cron job (daily, for "party is today" reminders) -> payload is
//      whatever we build ourselves: { title, body, url }
//
// Deploy via the Supabase Dashboard (Edge Functions -> Deploy a new function,
// paste this file in). Set these secrets first (Edge Functions -> Manage secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Turn OFF "Enforce JWT verification" for this function (it's called by
// server-side triggers, not by logged-in users).

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails("mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req) => {
  const payload = await req.json();

  let title, body, url;
  if (payload.record) {
    // Triggered by the "new party created" database webhook.
    const party = payload.record;
    title = "New party added 🎉";
    body = party.name + (party.date ? ` — ${party.date}` : "") + (party.location ? ` @ ${party.location}` : "");
    url = "/";
  } else {
    // Triggered directly (e.g. by the daily cron reminder).
    title = payload.title || "Shtamp";
    body = payload.body || "";
    url = payload.url || "/";
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: subs, error } = await supabase.from("push_subscriptions").select("*");
  if (error) return new Response(JSON.stringify({ error }), { status: 500 });

  const message = JSON.stringify({ title, body, url });

  const results = await Promise.allSettled(
    (subs || []).map((s) =>
      webpush
        .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, message)
        .catch(async (err) => {
          // 404/410 means the browser unsubscribed or the subscription expired — clean it up.
          if (err.statusCode === 404 || err.statusCode === 410) {
            await supabase.from("push_subscriptions").delete().eq("id", s.id);
          }
        })
    )
  );

  return new Response(JSON.stringify({ notified: results.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
