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
2. All 20 pages open as tabs next to the dashboard, grouped under an orange **Scanner** tab group (Settings can put them in a separate window instead). Each page is re-loaded every 3 seconds and read as soon as its HTML arrives.
3. The first load of each page is the baseline. After that, anything that shows up for the first time is a **NEW** lead. Anything priced below the lowest price seen for it is a **PRICE DROP**.
4. Leads appear at the top of the dashboard, with a desktop notification and a chime. Click a notification to open the item.
5. **All listings** shows every lot currently on the pages. You can sort by biggest % off retail, lowest price, price per unit, or newest.
6. **Stop scanning** closes the scan tabs.

Keep the dashboard tab open if you want the sound alerts.

## Settings

- **Pages to scan**: one URL per line. The default is pages 1–20 of the Bulk Liquidations list (`/s?i=specialty-aps&srs=23511005011&s=popularity-rank&fs=true&page=N`).
- **Refresh every**: seconds between reloads of each page (default 5).
- **Max price / Min % off / keywords**: only items that pass these filters count as leads.
- **Auto-open new leads**: opens each new lead in a background tab so you can buy fast.

## CAPTCHA

Twenty pages every 3 seconds is about 400 page loads a minute. Amazon will sometimes answer with a "not a robot" CAPTCHA. When that happens the scanner:

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
