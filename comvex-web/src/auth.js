/**
 * auth.js – Supabase Auth version of auth_manager.py.
 * A login name "ahmed" is stored in Supabase Auth as ahmed@comvex.local, so users
 * still sign in with a plain username. Roles/permissions live in public.profiles.
 * Creating / editing / deleting users goes through the server (/api/users),
 * which is the only place that holds the service-role key.
 */
import { supabase, STAY } from "./supabase.js";

const REMEMBER = "comvex.remember";
const MAIL = "@comvex.local";

// ── permissions (same list as before) ──────────────────────────
export const PERMS = [
  ["view_dashboard", "View Dashboard & search"],
  ["view_products", "View Products & barcodes"],
  ["view_lists", "View Factories / Categories / Colors / Sizes"],
  ["generate", "Generate barcodes"],
  ["edit_product", "Edit ASIN / Noon SKU"],
  ["remove_product", "Remove barcodes"],
  ["add_list", "Add list items"],
  ["edit_list", "Edit list items"],
  ["delete_list", "Delete list items"],
  ["export", "Export (Excel / PNG)"],
  ["import", "Import / replace database"],
  ["manage_users", "Manage users"],
];
const ALL = PERMS.map((p) => p[0]);
export const ROLE_PRESETS = {
  Administrator: ALL,
  Manager: ALL.filter((p) => !["import", "manage_users"].includes(p)),
  "Warehouse Employee": ["view_dashboard", "view_products", "generate", "export"],
  "Data Entry Employee": ["view_dashboard", "view_products", "view_lists", "generate", "edit_product", "add_list", "edit_list"],
  Viewer: ["view_dashboard", "view_products", "view_lists"],
};
export const ROLES = Object.keys(ROLE_PRESETS);

const permsOf = (p) => (p.role === "Administrator" ? ALL : (p.perms || []).filter((x) => ALL.includes(x)));
const emailOf = (u) => `${String(u).trim().toLowerCase()}${MAIL}`;
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;

function checkPassword(pw) {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(pw)) return "Password needs at least 1 uppercase letter.";
  if (!/[a-z]/.test(pw)) return "Password needs at least 1 lowercase letter.";
  if (!/\d/.test(pw)) return "Password needs at least 1 number.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password needs at least 1 special character.";
  return "";
}

// ── current user (cached profile) ──────────────────────────────
let me = null;

async function loadMe() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { me = null; return null; }
  const { data, error } = await supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) throw error;
  me = data ? { id: data.id, username: data.username, role: data.role, perms: permsOf(data) } : null;
  return me;
}
export const refreshMe = loadMe;
export const currentUser = () => me?.username || "";
export const getRole = () => me?.role || "";
export const exists = (name) => !!me && me.username === String(name).toLowerCase();
export const can = (_name, perm) => !!me && me.perms.includes(perm);

/** Called once at startup: returns the signed-in username, or "" if nobody is. */
export async function restore() {
  try {
    const p = await loadMe();
    if (p && p.perms.length) return p.username;
    const { data: { session } } = await supabase.auth.getSession();
    if (session) await supabase.auth.signOut(); // session exists but account was removed / has no access
  } catch { /* offline or server error: show the login page, keep the session */ }
  return "";
}

export function onSignedOut(cb) {
  supabase.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_OUT") { me = null; cb(); } });
}

export async function login(username, password, stay) {
  try { stay ? localStorage.setItem(STAY, "1") : localStorage.removeItem(STAY); } catch { /* ignore */ }
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: emailOf(username), password });
    if (error) return [false, /fetch|network/i.test(error.message) ? "Can't reach the server. Check your connection." : "Invalid username or password."];
    const p = await loadMe();
    if (!p || !p.perms.length) {
      await supabase.auth.signOut();
      return [false, "This account has no access yet. Ask an administrator."];
    }
    await supabase.rpc("touch_login");
    return [true, "OK"];
  } catch {
    return [false, "Can't reach the server. Check your connection."];
  }
}

export async function logout() {
  me = null;
  try { await supabase.auth.signOut(); } catch { /* ignore */ }
}

// ── server calls (user management) ─────────────────────────────
async function api(body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return [false, "Session expired. Please sign in again."];
  try {
    const r = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return [r.ok && !!j.ok, j.message || (r.ok ? "Done." : `Request failed (${r.status}).`)];
  } catch {
    return [false, "Can't reach the server."];
  }
}

export async function listUsers() {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at");
  if (error) throw error;
  return data.map((u) => ({ username: u.username, role: u.role, perms: permsOf(u), created: u.created_at, last_login: u.last_login }));
}

export async function createUser(username, password, role, perms) {
  username = username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return [false, "Username: 3-30 characters, letters, numbers, . _ - only."];
  const bad = checkPassword(password);
  if (bad) return [false, bad];
  return api({ action: "create", username, password, role, perms });
}

export async function updateUser(username, { role, perms, password }) {
  if (password) { const bad = checkPassword(password); if (bad) return [false, bad]; }
  const res = await api({ action: "update", username, role, perms, password: password || undefined });
  if (res[0] && me && username.toLowerCase() === me.username) await loadMe().catch(() => {});
  return res;
}

export async function deleteUser(username, currentUser) {
  if (username.toLowerCase() === String(currentUser).toLowerCase()) return [false, "You can't delete your own account."];
  return api({ action: "delete", username });
}

export async function changePassword(username, cur, next) {
  const { error } = await supabase.auth.signInWithPassword({ email: emailOf(username), password: cur });
  if (error) return [false, "Current password is incorrect."];
  const bad = checkPassword(next);
  if (bad) return [false, bad];
  const { error: e2 } = await supabase.auth.updateUser({ password: next });
  if (e2) return [false, e2.message];
  return [true, "Password changed successfully."];
}

export async function changeUsername(_old, newName) {
  newName = newName.trim().toLowerCase();
  if (!newName) return [false, "Username cannot be empty."];
  if (!USERNAME_RE.test(newName)) return [false, "Username: 3-30 characters, letters, numbers, . _ - only."];
  const res = await api({ action: "rename", username: newName });
  if (res[0]) { await supabase.auth.refreshSession().catch(() => {}); await loadMe().catch(() => {}); }
  return res;
}

// "remember me" = prefill username on the login page
export const getRemembered = () => { try { return localStorage.getItem(REMEMBER) || ""; } catch { return ""; } };
export const setRemembered = (n) => { try { n ? localStorage.setItem(REMEMBER, n) : localStorage.removeItem(REMEMBER); } catch { /* ignore */ } };
