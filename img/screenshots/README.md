# App Store screenshots

The Nextcloud App Store listing for Bee Flow renders the images in this
folder, in the order they're listed in `appinfo/info.xml` `<screenshot>`
elements.

## Required shots (commit them as 1920×1080 PNG)

1. **`01-chat.png`** — chat window with a real-looking conversation
   inside the Nextcloud iframe. The Bee Flow top-bar icon should be
   visible. Best shot: ask it to summarise an email, show the answer.
2. **`02-onboarding.png`** — the 4-step admin onboarding wizard, on
   step 2 (User sync mode) so the radio buttons + group multi-select
   are visible.
3. **`03-org-integrations.png`** — Settings → Organisation → Integrations,
   the Nextcloud-integrations panel showing the org-wide checkboxes plus
   one expanded per-group exception row.
4. **`04-privacy-shield.png`** — a chat where Privacy Shield kicked in;
   show the "Tokenised" badge under "How I got this answer" + the
   tokenised payload visible in the raw-payload panel.
5. *(optional)* **`05-multi-user.png`** — a Bee Flow user list showing
   3-4 users that were auto-mirrored from Nextcloud.
6. *(optional)* **`06-talk.png`** — once Talk-bot integration ships,
   the bot replying in a Talk room.

## How to update

Drop the PNGs in this folder, commit + push. Then update the
`<screenshot>` URLs in `appinfo/info.xml` to point at:

```
https://raw.githubusercontent.com/Bee-Flow/connector/main/img/screenshots/01-chat.png
```

(replace `01-chat` per shot). After the next tag, the App Store fetches
them automatically — no manual upload to apps.nextcloud.com needed.

## Sizing + format

- 1920×1080 PNG preferred (16:9, matches modern desktops).
- Keep file size under 500 KB each — use `pngquant` or `oxipng` if needed.
- No personal data — use the demo tenant or anonymise emails / names.
