# 2ndNumber Contacts — Chrome Extension

Lightweight contact manager + caller-ID overlay for [2ndnumber.tel](https://www.2ndnumber.tel/).
When a call comes in on `app/index.php`, the extension looks the number up in
your local contacts and replaces the displayed digits with the contact's name.
If the call is **Accepted** and the number isn't saved yet, the toolbar icon
gets a green **NEW** badge so you can quickly save the caller.

All data lives in `chrome.storage.local` on this device — nothing is sent
anywhere.

## Features

- Full CRUD for contacts with: phone, name, role (Recruiter / Hiring Manager),
  company, client name, step (HR / Tech / Final) and round (1–7).
- Incoming-call modal hook: replaces the phone number with the matched
  contact name (original number preserved in the tooltip).
- "Save incoming call" card in the popup, pre-filled when you accept a call
  from an unknown number.
- Call history (last 500) with accept/reject status and contact matching.
- Search/filter contacts.
- Import / Export JSON and CSV from the full-page manager.
- Dark mode follows your OS.

## Install (developer mode)

1. Visit `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder.
3. Open https://www.2ndnumber.tel/app/index.php and sign in normally.

## Verify quickly

1. Click the toolbar icon → **+ New** → add a contact for the number you want
   to test (any format works — digits are normalized).
2. In DevTools on `app/index.php`, paste the modal HTML you have on file (or
   wait for a real call) — the option text should switch to the contact name.
3. Click **Accept Call** in the modal: the toolbar gets a green **NEW** badge
   if the number isn't known yet; opening the popup shows the prefilled save
   card.

## Project layout

- `manifest.json` — MV3 manifest.
- `background.js` — storage CRUD, message router, badge.
- `content.js` — modal observer and number-to-name replacement.
- `utils.js` — shared helpers (phone normalize, validation, formatting).
- `popup/` — toolbar popup UI.
- `options/` — full-page contact manager + import/export.
- `icons/` — SVG source and rendered PNGs. Re-render with
  `powershell -ExecutionPolicy Bypass -File icons/build-icons.ps1`.

## Notes

- Number matching strips non-digits and drops a single leading `1` on 11-digit
  numbers, so `+1 (254) 840-0056`, `12548400056`, and `2548400056` all match.
- Replacement only touches `#ListIncomingCall option` text — the rest of the
  page is left alone.
- Permissions used: `storage`, `activeTab`, and host access to
  `https://www.2ndnumber.tel/*`.
