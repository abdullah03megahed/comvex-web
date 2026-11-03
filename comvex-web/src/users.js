/**
 * /api/users – the only place that uses the Supabase service-role key.
 * The browser sends its own login token; this function checks who is calling
 * and what they are allowed to do before creating / changing / deleting accounts.
 *
 * Vercel env vars used (the Supabase integration adds the first two for you):
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from "@supabase/supabase-js";

const PERMS = [
  "view_dashboard", "view_products", "view_lists", "generate", "edit_product", "remove_product",
  "add_list", "edit_list", "delete_list", "export", "import", "manage_users",
];
const ROLES = ["Administrator", "Manager", "Warehouse Employee", "Data Entry Employee", "Viewer"];
const MAIL = "@comvex.local";
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;

function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(pw)) return "Password needs at least 1 uppercase letter.";
  if (!/[a-z]/.test(pw)) return "Password needs at least 1 lowercase letter.";
  if (!/\d/.test(pw)) return "Password needs at least 1 number.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password needs at least 1 special character.";
  return "";
}

export default async function handler(req, res) {
  const reply = (status, ok, message) => res.status(status).json({ ok, message });

  if (req.method !== "POST") return reply(405, false, "Method not allowed.");

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return reply(500, false, "Server is missing SUPABASE_SERVICE_ROLE_KEY (add it in Vercel → Settings → Environment Variables, then redeploy).");

  const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });

  // ── who is calling? ──
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, false, "Please sign in again.");
  const { data: auth, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !auth?.user) return reply(401, false, "Session expired. Please sign in again.");
  const { data: caller } = await admin.from("profiles").select("*").eq("id", auth.user.id).maybeSingle();
  if (!caller) return reply(403, false, "Your account has no access.");

  const callerIsAdmin = caller.role === "Administrator";
  const callerPerms = callerIsAdmin ? PERMS : (caller.perms || []);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const action = body.action;
  const username = String(body.username || "").trim().toLowerCase();

  const adminCount = async () => {
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "Administrator");
    return count || 0;
  };
  const cleanPerms = (role, perms) => {
    if (role === "Administrator") return PERMS;
    const list = [...new Set(Array.isArray(perms) ? perms : [])].filter((p) => PERMS.includes(p));
    return callerIsAdmin ? list : list.filter((p) => callerPerms.includes(p)); // can't grant what you don't have
  };

  try {
    // ── change my own username ──
    if (action === "rename") {
      if (!USERNAME_RE.test(username)) return reply(400, false, "Username: 3-30 characters, letters, numbers, . _ - only.");
      if (username === caller.username) return reply(400, false, "New username is the same as current.");
      const { data: taken } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
      if (taken) return reply(409, false, "Username already taken.");
      const { error: e1 } = await admin.auth.admin.updateUserById(caller.id, { email: username + MAIL, email_confirm: true });
      if (e1) return reply(400, false, e1.message);
      const { error: e2 } = await admin.from("profiles").update({ username }).eq("id", caller.id);
      if (e2) {
        await admin.auth.admin.updateUserById(caller.id, { email: caller.username + MAIL, email_confirm: true });
        return reply(409, false, "Username already taken.");
      }
      return reply(200, true, "Username changed.");
    }

    // everything below needs the "manage users" permission
    if (!callerPerms.includes("manage_users")) return reply(403, false, "You don't have permission to manage users.");
    if (!["create", "update", "delete"].includes(action)) return reply(400, false, "Unknown action.");
    if (!USERNAME_RE.test(username)) return reply(400, false, "Invalid username.");

    // ── create ──
    if (action === "create") {
      const role = body.role;
      if (!ROLES.includes(role)) return reply(400, false, "Invalid role.");
      if (role === "Administrator" && !callerIsAdmin) return reply(403, false, "Only an Administrator can create Administrators.");
      const bad = passwordProblem(body.password);
      if (bad) return reply(400, false, bad);
      const { data: taken } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
      if (taken) return reply(409, false, "Username already taken.");

      const { data: created, error } = await admin.auth.admin.createUser({ email: username + MAIL, password: body.password, email_confirm: true });
      if (error) return reply(400, false, /already|registered|exists/i.test(error.message) ? "Username already taken." : error.message);
      const { error: pErr } = await admin.from("profiles").upsert({ id: created.user.id, username, role, perms: cleanPerms(role, body.perms) });
      if (pErr) { await admin.auth.admin.deleteUser(created.user.id); return reply(500, false, pErr.message); }
      return reply(200, true, `User '${username}' created.`);
    }

    // ── update / delete need an existing target ──
    const { data: target } = await admin.from("profiles").select("*").eq("username", username).maybeSingle();
    if (!target) return reply(404, false, "User not found.");
    if (target.role === "Administrator" && !callerIsAdmin) return reply(403, false, "Only an Administrator can change an Administrator.");

    if (action === "update") {
      const role = body.role;
      if (!ROLES.includes(role)) return reply(400, false, "Invalid role.");
      if (role === "Administrator" && !callerIsAdmin) return reply(403, false, "Only an Administrator can create Administrators.");
      if (target.role === "Administrator" && role !== "Administrator" && (await adminCount()) < 2) {
        return reply(400, false, "At least one Administrator is required.");
      }
      if (body.password) {
        const bad = passwordProblem(body.password);
        if (bad) return reply(400, false, bad);
        const { error } = await admin.auth.admin.updateUserById(target.id, { password: body.password });
        if (error) return reply(400, false, error.message);
      }
      const { error } = await admin.from("profiles").update({ role, perms: cleanPerms(role, body.perms) }).eq("id", target.id);
      if (error) return reply(500, false, error.message);
      return reply(200, true, `User '${target.username}' updated.`);
    }

    // delete
    if (target.id === caller.id) return reply(400, false, "You can't delete your own account.");
    if (target.role === "Administrator" && (await adminCount()) < 2) return reply(400, false, "At least one Administrator is required.");
    const { error } = await admin.auth.admin.deleteUser(target.id); // profile row is removed by cascade
    if (error) return reply(500, false, error.message);
    return reply(200, true, `User '${target.username}' deleted.`);
  } catch (e) {
    return reply(500, false, e?.message || "Server error.");
  }
}
