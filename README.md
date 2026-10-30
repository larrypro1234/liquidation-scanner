# Liquidation Lead Scanner (Chrome extension)

Watches the Amazon Bulk Liquidations pages and alerts you the moment a new lot appears or drops in price.

## Install (once)

1. Download [liquidation-scanner.zip](https://github.com/larrypro1234/liquidation-scanner/releases/latest/download/liquidation-scanner.zip) and unzip it somewhere permanent (e.g. `Documents/liquidation-scanner`).
2. In Chrome open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped `liquidation-scanner` folder.
5. Pin the orange radar icon in the toolbar. Clicking it opens the dashboard.

## Use

1. Click the icon, then **Start scanning**.
2. A new Chrome window opens with all 20 pages. Each page is re-loaded every 3 seconds and read as soon as its HTML arrives.
3. The first load of each page is the baseline. After that, anything that shows up for the first time is a **NEW** lead. Anything priced below the lowest price seen for it is a **PRICE DROP**.
4. Leads appear at the top of the dashboard, with a desktop notification and a chime. Click a notification to open the item.
5. **All listings** shows every lot currently on the pages. You can sort by biggest % off retail, lowest price, price per unit, or newest.
6. **Stop scanning** closes the scan window.

Keep the dashboard tab open if you want the sound alerts.

## Settings

- **Pages to scan**: one URL per line. The default is pages 1–20 of the Bulk Liquidations list (`/s?i=specialty-aps&srs=23511005011&s=popularity-rank&fs=true&page=N`).
- **Refresh every**: seconds between reloads of each page (default 3).
- **Max price / Min % off / keywords**: only items that pass these filters count as leads.
- **Auto-open new leads**: opens each new lead in a background tab so you can buy fast.

## CAPTCHA

Twenty pages every 3 seconds is about 400 page loads a minute. Amazon will sometimes answer with a "not a robot" CAPTCHA. When that happens the scanner:

- stops every reload immediately,
- brings the CAPTCHA tab to the front and notifies you,
- resumes on its own once you solve it.

If CAPTCHAs keep coming, raise the interval to 5–10 s or scan fewer pages (page 1 is where new drops usually land).

## Updates

- **Automatic:** every 5 minutes the scanner downloads `config.json` from this repo. It holds the page list and the rules for reading Amazon's pages. Changes to it reach your scanner by themselves, even mid-scan, with nothing to reinstall.
- **New features:** when `latestExtensionVersion` in `config.json` is newer than your copy, the dashboard shows an update banner and you get a notification. Download the zip, replace your folder, and click **Reload scanner**. Your settings and leads are kept.

### Releasing a new version (maintainer)

1. Bump `version` in `manifest.json`.
2. Zip the `liquidation-scanner` folder and attach it to a new GitHub release as `liquidation-scanner.zip`.
3. Set `latestExtensionVersion` in `config.json` to the same version and push.
