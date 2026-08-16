// Supabase Edge Function: splitwise
//
// Relays requests to the Splitwise API using a single stored API key, so the
// key never reaches the browser.
//
// Two actions:
//   { action: "groups" }   -> lists your Splitwise groups (id + name).
//                             Also doubles as a "is my setup working?" check.
//   { action: "expense", description, cost, groupId, details, shares: [...] }
//                          -> creates one expense with custom per-person shares.
//                             Each share: { email, firstName, lastName, paid, owed }
//
// Setup (Supabase Dashboard -> Edge Functions):
//   1. Deploy this as a function named `splitwise`
//   2. Manage secrets -> add SPLITWISE_API_KEY (from splitwise.com/apps)
//   3. Turn OFF "Enforce JWT verification"
//
// Note: Splitwise returns HTTP 200 even when it rejects the request — success
// is only true when the `errors` object comes back empty. We surface that.

const SPLITWISE_API_KEY = Deno.env.get("SPLITWISE_API_KEY")!;
// Optional: the Splitwise group all expenses land in. Find the number in the
// group's URL (splitwise.com/groups/12345678). Leave unset for non-group expenses.
const SPLITWISE_GROUP_ID = Deno.env.get("SPLITWISE_GROUP_ID") || "0";
const API = "https://secure.splitwise.com/api/v3.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

async function splitwiseGet(path: string) {
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${SPLITWISE_API_KEY}` },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (!SPLITWISE_API_KEY) {
    return json({ ok: false, error: "SPLITWISE_API_KEY secret is not set on this function." }, 500);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  // ---- List groups (also used as a connection test) ----
  if (payload.action === "groups") {
    const { status, body } = await splitwiseGet("/get_groups");
    if (status !== 200 || !body?.groups) {
      return json({ ok: false, error: `Splitwise returned ${status}. Check the API key.`, raw: body }, 502);
    }
    return json({
      ok: true,
      groups: body.groups.map((g: any) => ({ id: g.id, name: g.name, members: (g.members || []).length })),
    });
  }

  // ---- Create or update an expense ----
  // "expense" creates a new one; "update" overwrites an existing one in place
  // (Splitwise replaces ALL shares when any users__ field is supplied).
  if (payload.action === "expense" || payload.action === "update") {
    const { description, cost, groupId, details, shares, expenseId } = payload;
    if (!description || !cost || !Array.isArray(shares) || shares.length === 0) {
      return json({ ok: false, error: "description, cost and shares are required." }, 400);
    }
    if (payload.action === "update" && !expenseId) {
      return json({ ok: false, error: "expenseId is required to update." }, 400);
    }

    // Splitwise wants flattened form fields: users__0__email, users__0__paid_share, ...
    const form = new URLSearchParams();
    form.set("cost", String(cost));
    form.set("description", description);
    form.set("group_id", String(groupId ?? SPLITWISE_GROUP_ID));
    if (details) form.set("details", details);
    form.set("currency_code", "EUR");

    shares.forEach((s: any, i: number) => {
      if (s.userId) {
        form.set(`users__${i}__user_id`, String(s.userId));
      } else {
        form.set(`users__${i}__email`, s.email);
        form.set(`users__${i}__first_name`, s.firstName || s.email);
        if (s.lastName) form.set(`users__${i}__last_name`, s.lastName);
      }
      form.set(`users__${i}__paid_share`, String(s.paid));
      form.set(`users__${i}__owed_share`, String(s.owed));
    });

    const path = payload.action === "update" ? `/update_expense/${expenseId}` : "/create_expense";
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SPLITWISE_API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const body = await r.json().catch(() => null);

    // 200 alone does NOT mean success — `errors` must be empty.
    const errs = body?.errors;
    const hasErrors = errs && (Array.isArray(errs) ? errs.length > 0 : Object.keys(errs).length > 0);
    if (r.status !== 200 || hasErrors || !body?.expenses?.length) {
      return json({ ok: false, error: "Splitwise rejected the expense.", details: errs, raw: body }, 502);
    }

    return json({ ok: true, expenseId: body.expenses[0].id });
  }

  // ---- Delete an expense (soft-delete; recoverable in Splitwise) ----
  if (payload.action === "delete") {
    const { expenseId } = payload;
    if (!expenseId) return json({ ok: false, error: "expenseId is required." }, 400);
    const r = await fetch(`${API}/delete_expense/${expenseId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SPLITWISE_API_KEY}` },
    });
    const body = await r.json().catch(() => null);
    if (r.status !== 200 || body?.success === false) {
      return json({ ok: false, error: "Splitwise wouldn't delete it.", details: body?.errors, raw: body }, 502);
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: `Unknown action: ${payload.action}` }, 400);
});
