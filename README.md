# Stella Sound v1.0.0

An offline music app for phones, tablets and computers. It has two areas:

- **Create:** tap touch pads to play 14 instruments and 4 drum kits, always in key. Record loops with a count-in, layer takes, then save them as your own loops.
- **Produce:** a song studio with 160 preset loops in 10 genres plus *My Loops*. Drag loops onto 6 tracks and press Play. Includes WAV export and full-screen **DJ Pads** (a 5 × 4 clip launcher).

It's plain HTML/CSS/JavaScript with no frameworks, no CDN and no tracking. After the first visit it works with no internet connection, and it can be installed to the home screen.

## Run it on your computer
```bash
cd stella-sound-v5
python3 -m http.server 8080        # or: npx serve .
# open http://localhost:8080
```
It has to be served over http(s), not opened as a `file://`, for offline mode and installing to work.

## Publish it (free)
The app is a static folder, so any static host works. **It must be served over HTTPS** (all hosts below do this) so that phones can install it and use it offline.

### Netlify (easiest)
1. Go to <https://app.netlify.com/drop>.
2. Drag the **stella-sound-v5 folder** onto the page.
3. You get a URL like `https://your-name.netlify.app`. Rename it under *Site settings → Change site name*.

### GitHub Pages
1. Create a new public repository, e.g. `stella-sound`.
2. Upload the *contents* of this folder (index.html at the top level), or:
   ```bash
   git init && git add . && git commit -m "Stella Sound 1.0.0"
   git branch -M main && git remote add origin https://github.com/<you>/stella-sound.git && git push -u origin main
   ```
3. Go to *Settings → Pages → Build and deployment → Deploy from a branch → main / (root)*.
4. After about a minute the app is live at `https://<you>.github.io/stella-sound/`. Relative paths are used everywhere, so a sub-folder works.

Other hosts such as Cloudflare Pages, Vercel or Firebase Hosting work the same way: upload the folder with no build step.

## Install on a device
- **Android (Chrome):** open the URL, then tap *Install app*, or use ⋮ → *Add to Home screen*.
- **iPhone / iPad (Safari):** tap Share, then *Add to Home Screen*. On iOS 16.4 or newer it plays even when the Silent switch is on. On older iOS, turn the Silent switch off if there's no sound.
- **Windows / Mac (Chrome, Edge):** click the install icon in the address bar.

## Releasing an update
1. Make your changes.
2. Bump the version in **three places**:
   - `APP_VERSION` near the end of `js/app.js`
   - `VERSION` **and** `CACHE` in `sw.js` (for example `stella-sound-v6`)
   - `id="appVer"` text in `index.html`
3. Upload the folder again. Open copies of the app will show **"New version available – Reload"**.

## Your data
Songs and *My Loops* are saved on the device (IndexedDB). The app asks the browser to keep this storage permanently. To move to a new device, or just to be safe, use **Song → Back up everything**, then **Song → Restore from backup file** on the other device.

## Keyboard shortcuts (PC)
| Where | Keys |
|---|---|
| Create | pads on Z–M, A–K, Q–I, 1–8 · Space play/stop · Enter record · ← → octave · Esc leaves full screen |
| Produce | Space play/stop · Ctrl/⌘+Z undo · Ctrl/⌘+D duplicate clip · Delete removes clip · D opens DJ Pads |
| DJ Pads | pads on 1–5, Q–T, A–G, Z–B · Space stop all · Esc close |

## Files
`index.html` (layout) · `styles.css` · `js/dsp.js` (sound synthesis) · `js/presets.js` (160 loops) · `js/engine.js` (audio engine) · `js/app.js` (the app) · `sw.js` (offline) · `manifest.json` · `icons/`.
