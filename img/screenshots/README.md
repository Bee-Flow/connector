# App Store screenshots

The Nextcloud App Store listing for Bee Flow renders the images in this
folder, in the order they're listed in `appinfo/info.xml` `<screenshot>`
elements. The logo (`../bee-flow-logo.png`) stays first: it doubles as the
listing's hero image.

## The shots (1920×1080 PNG, all taken inside Nextcloud)

Every shot shows Nextcloud's own top bar with Bee Flow open in it. This is a
Nextcloud listing, so the reader should see the app where they will use it.

1. **`01-chat.png`**: a chat that works on Nextcloud files. The question
   ("Summarise the latest invoice in /Invoices-Test…"), the tool calls
   (Nextcloud List Files, Nextcloud Read File) and the full answer are all on
   screen. The chat sidebar is collapsed to the rail.
2. **`02-automation.png`**: the automation canvas with *Invoice intake*: a new
   PDF in `/Invoices` is read, the details extracted, anything over €1,000
   goes to Finance for approval, then a row in the invoice register and a
   Talk message. Presenter mode on, *Wrap to fit*, then *Fit*; the legend
   closed.
3. **`03-form.png`**: a Studio app with a form (*Request form*) in Preview,
   filled in with sample data, the AI builder panel hidden.

## How they were made

On the local sandbox (`scripts/local-sandbox.sh`, HaRP mode, Nextcloud on
`:8081`, signed in as `admin`), with Playwright: a 1440×810 viewport at device
scale 4/3, which gives 1920×1080 with text large enough to read in the
listing's carousel. Things that will trip up the next person:

- **Navigate inside the app, not by URL.** A hard load of
  `/exapps/bee_flow/app/...` reaches the connector's API proxy and answers
  "Cannot GET". Load Bee Flow from the top bar, then move with the app's own
  navigation (or `history.pushState` plus a `popstate` event in the frame).
- **No faces, no real names.** The sandbox admin has a real photo as avatar.
  Nextcloud's `/avatar/` requests can be intercepted, but Bee Flow keeps its
  own copy as an inline `data:` image, so swap that one in the page right
  before the capture. Sample data must be fictional (`example.com`
  addresses, the invoices in `/Invoices-Test`).
- **Check the answer's language.** Stored memories apply to every chat: the
  sandbox admin has one saying they write in Dutch, and a question in English
  got a Dutch answer.
- **Ask for something read-only.** An open question ("go through all Q3
  invoices") made the assistant build a Nextcloud Tables table on its own.

## Going live

The files are served from `Bee-Flow/connector` `main`, which the release
workflow (`.github/workflows/connector-release.yml` in Bee-Flow-AI) mirrors
from this folder. The App Store reads the `<screenshot>` list from the
release's `info.xml`, so new or renamed shots appear with the next connector
release. Keep each file under 500 KB.
