/**
 * auth.js – browser port of auth_manager.py (PBKDF2-HMAC-SHA256 via WebCrypto).
 * NOTE: this is a static site, so accounts live in this browser only.
 */
const KEY = "comvex.auth.v1";
const SESSION = "comvex.session";
const REMEMBER = "comvex.remember";
const ITER = 260_000;

// ── permissions ────────────────────────────────────────────────
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

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hash(password, salt) {
  if (!salt) salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: ITER }, base, 256);
  return [toHex(bits), salt];
}

let users = {};
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(users)); } catch { /* unavailable */ } };

export async function initAuth() {
  try { users = JSON.parse(localStorage.getItem(KEY) || "null") || {}; } catch { users = {}; }
  if (!users.admin && !Object.keys(users).length) {
    const [h, s] = await hash("P@ssw0rd");
    users = { admin: { username: "admin", password_hash: h, salt: s, role: "Administrator", created: new Date().toISOString(), last_login: null } };
    save();
  }
}

export async function login(username, password) {
  const u = users[String(username).trim().toLowerCase()];
  const bad = [false, "Invalid username or password."];
  if (!u) return bad;
  const [h] = await hash(password, u.salt);
  if (h !== u.password_hash) return bad;
  u.last_login = new Date().toISOString();
  save();
  return [true, "OK"];
}

function checkPassword(pw) {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(pw)) return "Password needs at least 1 uppercase letter.";
  if (!/[a-z]/.test(pw)) return "Password needs at least 1 lowercase letter.";
  if (!/\d/.test(pw)) return "Password needs at least 1 number.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password needs at least 1 special character.";
  return "";
}

const permsOf = (u) => (u.role === "Administrator" ? ALL : u.perms ?? ROLE_PRESETS[u.role] ?? []);
export const exists = (name) => !!users[String(name).toLowerCase()];
export function can(name, perm) {
  const u = users[String(name).toLowerCase()];
  return !!u && permsOf(u).includes(perm);
}
const adminCount = () => Object.values(users).filter((u) => u.role === "Administrator").length;

export const listUsers = () => Object.values(users).map((u) => ({
  username: u.username, role: u.role, perms: permsOf(u), created: u.created, last_login: u.last_login,
}));

export async function createUser(username, password, role, perms) {
  username = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return [false, "Username: 3-30 characters, letters, numbers, . _ - only."];
  if (users[username]) return [false, "Username already taken."];
  const bad = checkPassword(password);
  if (bad) return [false, bad];
  const [h, s] = await hash(password);
  users[username] = { username, password_hash: h, salt: s, role, perms: role === "Administrator" ? ALL : perms, created: new Date().toISOString(), last_login: null };
  save();
  return [true, `User '${username}' created.`];
}

export async function updateUser(username, { role, perms, password }) {
  const u = users[username.toLowerCase()];
  if (!u) return [false, "User not found."];
  if (u.role === "Administrator" && role !== "Administrator" && adminCount() < 2) return [false, "At least one Administrator is required."];
  if (password) {
    const bad = checkPassword(password);
    if (bad) return [false, bad];
    [u.password_hash, u.salt] = await hash(password);
  }
  u.role = role;
  u.perms = role === "Administrator" ? ALL : perms;
  save();
  return [true, `User '${u.username}' updated.`];
}

export function deleteUser(username, currentUser) {
  const key = username.toLowerCase();
  const u = users[key];
  if (!u) return [false, "User not found."];
  if (key === currentUser.toLowerCase()) return [false, "You can't delete your own account."];
  if (u.role === "Administrator" && adminCount() < 2) return [false, "At least one Administrator is required."];
  delete users[key];
  save();
  return [true, `User '${username}' deleted.`];
}

export async function changePassword(username, cur, next) {
  const u = users[username.toLowerCase()];
  if (!u) return [false, "User not found."];
  const [h] = await hash(cur, u.salt);
  if (h !== u.password_hash) return [false, "Current password is incorrect."];
  const bad = checkPassword(next);
  if (bad) return [false, bad];
  const [nh, ns] = await hash(next);
  u.password_hash = nh; u.salt = ns;
  save();
  return [true, "Password changed successfully."];
}

export function changeUsername(oldName, newName) {
  newName = newName.trim().toLowerCase();
  if (!newName) return [false, "Username cannot be empty."];
  if (users[newName]) return [false, "Username already taken."];
  const u = users[oldName.toLowerCase()];
  if (!u) return [false, "User not found."];
  delete users[oldName.toLowerCase()];
  u.username = newName;
  users[newName] = u;
  save();
  setSession(newName);
  return [true, "Username changed."];
}

export const getRole = (name) => users[name.toLowerCase()]?.role || "Administrator";

// session (per tab) + "remember me" (username only, like the desktop app)
export const getSession = () => { try { return sessionStorage.getItem(SESSION) || ""; } catch { return ""; } };
export const setSession = (n) => { try { n ? sessionStorage.setItem(SESSION, n) : sessionStorage.removeItem(SESSION); } catch { /* ignore */ } };
export const getRemembered = () => { try { return localStorage.getItem(REMEMBER) || ""; } catch { return ""; } };
export const setRemembered = (n) => { try { n ? localStorage.setItem(REMEMBER, n) : localStorage.removeItem(REMEMBER); } catch { /* ignore */ } };
