# Liquidation Lead Scanner (Chrome extension)

Watches the Amazon Bulk Liquidations pages and alerts you the moment a new lot appears or drops in price.

## Install (once, Mac)

1. Open **Terminal** and paste:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/larrypro1234/liquidation-scanner/main/install-mac.sh | bash
   ```
   This puts the scanner in `~/liquidation-scanner` and turns on automatic updates.
2. In Chrome open `chrome://extensions` and turn on **Developer mode** (top right). Leave it on: Chrome needs it for the scanner to restart itself after an update.
3. Click **Load unpacked** and pick the `liquidation-scanner` folder in your home folder.
4. Pin the orange radar icon in the toolbar. Clicking it opens the dashboard.

## Use

1. Click the icon, then **Start scanning**.
2. The 20 pages open as empty tabs next to the dashboard, grouped under an orange **Scanner** tab group. The scanner then loads **one Amazon page at a time**, about every 3 seconds by default (randomised ±20%, adjustable with the speed knob), visiting the pages in a shuffled order each round. Every 4th turn goes to the manifest tab instead, and a brand-new lot gets the very next turn so its manifest shows up within seconds. With 20 pages, each one is checked roughly every minute.
3. The first load of each page is the baseline. After that, anything that shows up for the first time is a **NEW** lead. Anything priced below the lowest price seen for it is a **PRICE DROP**.
4. Every listing has an **Open ↗** button and a **Copy link** button (paste the link into whichever browser you buy from). Leads appear at the top of the dashboard. A new lot also sounds a loud ~3 s siren (even with the dashboard closed) and shows a notification that stays on screen until clicked; **Settings → Test alarm** tries it out. Click a notification to open the item.
5. **All listings** shows every lot currently on the pages. You can sort by biggest % off retail, lowest price, price per unit, or newest.
6. **Stop scanning** closes the scan tabs.

For the notification to be noticeable on a Mac: System Settings → Notifications → Google Chrome → Allow notifications, style **Alerts**, **Play sound for notifications** on.

## Settings

- **Pages to scan**: one URL per line. The default is pages 1–20 of the Bulk Liquidations list (`/s?i=specialty-aps&srs=23511005011&s=popularity-rank&fs=true&page=N`).
- **Speed knob** (top of the dashboard): seconds between page loads, across all pages together, from 2 (faster) to 10 (gentler); default 3. Changes apply on the next page. `performance.minGapMs` in config.json is the hard floor.
- **Max price / Min % off / keywords**: only items that pass these filters count as leads.
- **Auto-open new leads**: opens each new lead in a background tab so you can buy fast.

## CAPTCHA

Amazon may answer heavy traffic with its "SORRY, something went wrong" dog page, which blocks the whole connection for a while. On the dog page the scanner stops every request for 10 minutes (20, 40, up to 60 if it keeps happening), tests a single page, and only then restarts, one speed step slower. Starting again during a rest waits it out. On a "not a robot" CAPTCHA the scanner:

- stops every reload immediately,
- brings the CAPTCHA tab to the front and notifies you,
- resumes on its own once you solve it.

If CAPTCHAs keep coming, raise the interval to 5–10 s or scan fewer pages (page 1 is where new drops usually land).

## Updates

Nothing to do. Two things keep the scanner current:

- **Page list and Amazon reading rules:** every 5 minutes the scanner downloads `config.json` from this repo and uses it right away, even mid-scan.
- **New code:** a background job on the Mac (installed by `install-mac.sh`) downloads `dist/liquidation-scanner.zip` every 5 minutes. When it contains a newer version, the job swaps the files in. The scanner notices, restarts itself, reopens the dashboard, and resumes the scan.

If a new version still hasn't arrived after 20 minutes (e.g. the installer was never run), the dashboard shows manual update steps.

### Releasing a new version (maintainer)

1. Bump `version` in `manifest.json` (every release needs a new number, or Macs won't pick it up).
2. Rebuild `dist/liquidation-scanner.zip` (zip of the extension files inside a `liquidation-scanner/` folder, without `dist/` and `.git/`).
3. Set `latestExtensionVersion` in `config.json` to the same version and push.
