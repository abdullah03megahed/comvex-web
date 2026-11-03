/**
 * auth.js – browser port of auth_manager.py (PBKDF2-HMAC-SHA256 via WebCrypto).
 * NOTE: this is a static site, so accounts live in this browser only.
 */
const KEY = "comvex.auth.v1";
const SESSION = "comvex.session";
const REMEMBER = "comvex.remember";
const ITER = 260_000;

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

export async function changePassword(username, cur, next) {
  const u = users[username.toLowerCase()];
  if (!u) return [false, "User not found."];
  const [h] = await hash(cur, u.salt);
  if (h !== u.password_hash) return [false, "Current password is incorrect."];
  if (next.length < 8) return [false, "Password must be at least 8 characters."];
  if (!/[A-Z]/.test(next)) return [false, "Password needs at least 1 uppercase letter."];
  if (!/[a-z]/.test(next)) return [false, "Password needs at least 1 lowercase letter."];
  if (!/\d/.test(next)) return [false, "Password needs at least 1 number."];
  if (!/[^A-Za-z0-9]/.test(next)) return [false, "Password needs at least 1 special character."];
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
