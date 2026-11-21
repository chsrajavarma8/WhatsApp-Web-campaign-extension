# Personalized Campaign Sender for WhatsApp Web

A Chrome extension (Manifest V3) that sends **personalized** messages to **consenting** contacts from a CSV file, using your own logged-in WhatsApp Web session. You review every contact and message before anything is sent. Messages go out one at a time, at a pace you control, and all data stays in your browser.

> **Use responsibly.** Only message people who have agreed to receive messages from you. Automated messaging must comply with WhatsApp's Terms of Service and Business/Commerce policies. Unsolicited messages get reported and can get your number restricted or banned. This extension does **not** bypass rate limits, account restrictions or spam detection, and never will. For high-volume or marketing traffic, use the official [WhatsApp Business Platform](https://business.whatsapp.com/products/business-platform).

---

## Features

| Area | What you get |
|---|---|
| **CSV upload** | Drag & drop or browse; auto-detects `Name` / `Phone` columns (any case, common variants such as *Full Name*, *Mobile*, *WhatsApp Number*); comma, semicolon, tab or pipe delimiters; UTF-8 and Windows-1252; quoted fields with commas and line breaks. |
| **Validation** | Flags invalid numbers, missing numbers, missing names, duplicate numbers and empty rows. Invalid rows are skipped automatically; you can include or exclude any valid row with its checkbox. |
| **Composer** | Large editor, clickable placeholder chips from your CSV columns, `{Column\|fallback}` defaults, warnings for unknown or empty placeholders, live chat-bubble preview for any contact. |
| **Sending** | Sequential: open chat → verify → insert message → wait → send → confirm → next contact. Configurable delays, chat-load timeout and a max-messages-per-session limit. |
| **Controls** | Start, Pause, Resume, Stop, Send Test Message, Reset Campaign, Retry Failed. |
| **Sending pace** | One click: 1 message every 30 sec, 1, 2, 5, 10, 15, 30 min or 1 hour, or a custom value (seconds / minutes / hours, 10 s – 2 h). Measured start-to-start, applies live while running, survives pauses and worker restarts. "Send next now" ends a wait early. |
| **Dashboard** | Live status card with countdown ring, pace and estimated finish time; Total / Sent / Pending / Failed / Invalid / Skipped cards; segmented progress bar; current/next contact; setup checklist; recent activity; updates in real time. |
| **Logs & export** | Per-contact log with time, status and error details. Export **results** (`Name, Phone, Message, Status, Note, Timestamp, Error`; the **Note** column says e.g. *Number not on WhatsApp* or *Phone number missing in CSV*) and the **activity log** as CSV. |
| **Templates** | Create, edit, delete, preview and load reusable messages (three examples are pre-installed). |
| **Drafts** | Save the whole campaign (contacts, message, settings, statuses) and restore it later. |
| **Test mode** | Send one message to a chosen contact, or to your own number, after confirming recipient and text. Does not start the campaign. |
| **Privacy** | Permissions are `storage`, `alarms` (wakes the extension after long pacing waits) plus access to `web.whatsapp.com` only. No analytics, no tracking, no external servers, no remote code. |

---

## Installation (Developer Mode)

1. Build the extension: `npm run build` (needs Node 18+; runs the tests, then creates `dist/` and `release/wa-campaign-sender-<version>.zip`).
2. Open **`chrome://extensions`** in Chrome (or Edge / Brave, Chromium 116+).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the **`dist`** folder.
5. Pin the extension: puzzle-piece icon → pin **Campaign Sender**.
6. Open **https://web.whatsapp.com** and log in with the QR code.
   *If WhatsApp Web was already open before you installed the extension, reload that tab once.*

`dist/` contains only the files Chrome needs (no tests or dev scripts). The project root also loads as-is if you prefer. To publish, upload the zip from `release/` to the Chrome Web Store Developer Dashboard. After changing code, run `npm run build` again and click ↻ on the extension.

---

## Usage

1. **Open WhatsApp Web** and log in.
2. Click the extension icon → **Open Dashboard**.
3. **Contacts** → drop your CSV. Check the column mapping and set a **default country code** if your numbers don't include one.
4. Review the preview table. Use the chips to filter problem rows, and untick anyone you don't want to message.
5. **Message** → write your text and click placeholders to insert them. Use ‹ › to preview other contacts.
6. **Settings** → pick a **sending pace** (e.g. 1 message every 1, 15 or 30 minutes), then delays and the per-session limit. For long paces keep Chrome open and the computer awake.
7. **Test Mode** → send a test to your own number (recommended).
8. Click **Start Sending**, confirm consent, and watch progress in **Overview** or the popup.
9. **Pause / Resume / Stop** at any time. When the campaign finishes, **Export results CSV**.

Keep the WhatsApp Web tab open while the campaign runs. Open the dashboard in a **separate window** if you want to watch both side by side.

---

## CSV format

```csv
Name,Phone,City,OrderID,Date
Rahul,919876543210,Hyderabad,A-1001,12 Dec
Priya,918765432109,Bangalore,A-1002,13 Dec
```

- **Header row required.** Column names are case-insensitive.
  - Name: `Name`, `Full Name`, `Contact Name`, `Customer Name`, `First Name`, …
  - Phone: `Phone`, `Mobile`, `Number`, `WhatsApp Number`, `Phone Number`, `Cell`, …
  - You can always change the mapping manually in the dashboard.
- **Phone numbers** should include the **country code**: `919876543210`, `+91 98765 43210`, `0091-98765-43210` all work. Spaces, dashes, brackets and a leading `+`/`00` are removed automatically. Numbers must be 8–15 digits. Without a country code, set **Default country code** (e.g. `91`); a leading trunk `0` is dropped.
- **Excel tip:** Excel can turn long numbers into `9.19877E+11`, which loses digits. Format the phone column as **Text** before typing, then **File → Save As → CSV UTF-8**.
- **Every other column becomes a placeholder**: `City` → `{City}`, `Order ID` → `{Order ID}` (also matches `{OrderID}` and `{order_id}`).
- A sample file is in `sample-contacts.csv`, and the dashboard has a **Download sample CSV** button.

### Placeholders

| Syntax | Result |
|---|---|
| `{Name}` | Value from the name column (even if it is called "Full Name") |
| `{First Name}` | First word of the name |
| `{Phone}` | Phone column value |
| `{City}`, `{Order ID}`, … | Any CSV column, case- and space-insensitive |
| `{City\|your city}` | Fallback text if the value is empty for that contact |

If a value is empty and has no fallback, the placeholder is removed and stray spaces are tidied (`Hello {Name}, …` → `Hello, …`). **Unknown** placeholders (typos) are left visible and flagged in the composer.

---

## How it works

```
popup / dashboard ──commands──▶ background.js (service worker, single owner of state)
        ▲                               │   campaign-manager.js  (sequential runner)
        │ chrome.storage.onChanged       │   whatsapp-tab.js      (tab driver)
        └──────── campaign state ◀──────┤
                                        ▼
                     web.whatsapp.com/send?phone=…&text=…   (WhatsApp's public click-to-chat link)
                                        │
                     content.js + wa-dom.js + wa-selectors.js
                     wait for chat → verify text → click Send → confirm
```

- **Fast mode (default):** each chat is opened *inside the already-loaded WhatsApp page*, with no reload, by closing the current chat and clicking a `wa.me/<number>` link, the same as clicking a number link in a message. If WhatsApp does not handle it, that contact automatically falls back to **reload mode**: WhatsApp's own click-to-chat URL (`/send?phone=…`), which reloads the page. After 2 consecutive misses, the rest of the run uses reload. Choose between the two in **Settings → How to open each chat**; the Activity Log says which method opened each chat. No unofficial WhatsApp APIs are used.
- The background worker saves state after every step. If Chrome stops the worker, it picks up where it left off. After a full browser restart, a running campaign is **paused** (never resumed silently).
- Errors that aren't the contact's fault (not logged in, tab closed, offline, WhatsApp not loading) **pause** the campaign and keep the contact Pending. Three consecutive "WhatsApp unresponsive" errors also pause it.

### Project structure

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest; minimal permissions |
| `background.js` | Service worker: message router, startup recovery |
| `campaign-manager.js` | Campaign model, statistics, sequential runner (pause / resume / stop / retry / test) |
| `whatsapp-tab.js` | Finds the WhatsApp tab, navigates to chats, talks to the content script |
| `content.js` | In-page steps: prepare chat, send, confirm |
| `wa-selectors.js` | **All WhatsApp DOM selectors and popup text hints (update here if WhatsApp changes)** |
| `wa-dom.js` | DOM helpers: waiting, text insertion, send button, popups |
| `csv-parser.js` | RFC 4180 CSV parser, delimiter detection, file reading |
| `contacts.js` | Column detection, phone normalization, validation, duplicates |
| `message-template.js` | Placeholder parsing and rendering |
| `storage.js` | `chrome.storage.local` wrapper (campaign, templates, drafts) |
| `constants.js` | Statuses, message types, error codes, default settings |
| `popup.html/.css/.js` | Compact status and controls |
| `dashboard.html/.css/.js` | Full dashboard shell and routing |
| `ui/` | Shared UI: `api.js`, `dom.js`, `controls.js`, `export.js`, `base.css`, `views/*.js` |
| `tests/` | Node tests (CSV, placeholders, phones, campaign engine) |
| `scripts/generate-icons.mjs` | Regenerates `icons/*.png` (no dependencies) |

---

## Testing

```bash
npm test          # or: node --test tests/
```

34 tests cover:

- CSV parsing: quotes, embedded commas and newlines, BOM, `;`/tab delimiters, empty rows, duplicate headers, malformed files.
- Column detection for many header variants, including guessing the phone column from its values.
- Phone normalization: formats, country codes, scientific notation, invalid lengths.
- Placeholders: case/space-insensitive matching, missing values, fallbacks, unknown placeholders, special characters (`$&`, `{}`), Unicode names (Hindi, Chinese, Cyrillic, emoji), extra columns.
- Campaign engine: sequential sending (never concurrent), per-contact errors, fatal errors that pause, pause during the pre-send delay, stop/start, session limit, retry failed, reset, test mode, and **state that survives a simulated service-worker restart, then resumes without messaging anyone twice**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Reload the WhatsApp tab to connect the extension" | The tab was open before the extension was installed or updated. Reload it. |
| "WhatsApp Web is not open" | Open https://web.whatsapp.com in a normal tab (not incognito, unless you allowed the extension there). |
| "Not logged in" | Scan the QR code in WhatsApp Web, then press **Resume**. |
| Every contact fails with "Chat did not open" | Raise **Chat load timeout** in Settings and keep **Bring the WhatsApp tab to the front** enabled (background tabs are slowed down by Chrome). Check your connection. |
| Note says "Number not on WhatsApp" | The number isn't registered on WhatsApp, or is missing its country code. Fix it in the CSV and re-upload, or set a default country code. |
| Numbers show as `9.19E+11` | Excel converted them. Format the column as Text and export again as CSV UTF-8. |
| Accented or Indian-language names look garbled | Save the file as **CSV UTF-8**. The extension also tries Windows-1252 automatically. |
| Message box stays filled / "Send was clicked but…" | WhatsApp may have changed its layout. Update the selectors in `wa-selectors.js` (see below), then reload the extension. |
| Campaign paused after a browser restart | Intended: press **Resume** to continue. |
| "Browser storage is full" | Delete old drafts or clear the activity log. |

### Updating selectors when WhatsApp Web changes

1. Open WhatsApp Web, right-click the element (message box, send button, …) → **Inspect**.
2. Find a stable attribute (`aria-label`, `data-icon`, `data-tab`, `role`, an `id`).
3. Add it **at the top** of the matching list in `wa-selectors.js` (keep the old ones as fallbacks).
4. For WhatsApp in another language, add the "invalid number" popup wording to `WA_TEXT_HINTS.invalidNumber`.
5. On `chrome://extensions`, click ↻ on the extension, then reload the WhatsApp tab.

---

## Privacy

- Contact lists, messages, templates and logs are stored only in `chrome.storage.local` on your computer.
- The extension makes **no network requests of its own**: no analytics, no telemetry, no remote scripts or fonts.
- Exports are generated locally and downloaded straight to your computer.
- The content script only looks at the chat it opened, to confirm the message was sent.
