import { defineConfig } from "vite";

// NEXT_PUBLIC_* lets the app read the variables that Vercel's Supabase
// integration adds automatically (no renaming needed).
export default defineConfig({
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
});
