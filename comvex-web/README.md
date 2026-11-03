# COMVEX Barcode System — Web

Web version of the PyQt6 desktop app (same screens, same barcode formula, real Code 128 barcodes).
Static site (Vite) — no server needed.

## Deploy on Vercel
**Dashboard:** push this folder to GitHub → Vercel → *Add New Project* → import it. Defaults are detected
(Framework: Vite, Build: `npm run build`, Output: `dist`). Press Deploy.

**CLI:** `npm i -g vercel && vercel --prod`

## Run locally
`npm install && npm run dev`

## Login
`admin` / `P@ssw0rd` — change it from *Profile & Security* after the first login.

## Data
Stored in each browser (IndexedDB). Use *Profile & Security → Data* to export/import `Database.xlsx`
(same format as the desktop app: Factories, Categories, Colors, Sizes, Products). First run is seeded
with the sample data from the desktop app's Database.xlsx.
