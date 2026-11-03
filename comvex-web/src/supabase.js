/**
 * supabase.js – one shared Supabase client.
 * Reads the URL / public key from Vercel env vars (VITE_* or the NEXT_PUBLIC_*
 * ones the Vercel ↔ Supabase integration creates). The public key is safe in the
 * browser: row-level security in the database decides what each user may do.
 */
import { createClient } from "@supabase/supabase-js";

const env = import.meta.env;
const URL = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const KEY =
  env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const configured = !!(URL && KEY);
export const STAY = "comvex.stay"; // "1" = keep me signed in (localStorage), else this tab only

const tryDo = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const storage = {
  getItem: (k) => tryDo(() => sessionStorage.getItem(k)) ?? tryDo(() => localStorage.getItem(k)),
  setItem: (k, v) => {
    const stay = tryDo(() => localStorage.getItem(STAY)) === "1";
    tryDo(() => (stay ? localStorage : sessionStorage).setItem(k, v));
    tryDo(() => (stay ? sessionStorage : localStorage).removeItem(k));
  },
  removeItem: (k) => { tryDo(() => sessionStorage.removeItem(k)); tryDo(() => localStorage.removeItem(k)); },
};

export const supabase = configured
  ? createClient(URL, KEY, { auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
  : null;
