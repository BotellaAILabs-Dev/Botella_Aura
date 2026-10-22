# WhatsApp demo on your computer (Meta test number)

Runs Aura on your machine with a free temporary public address (Cloudflare
quick tunnel), so Meta's free WhatsApp **test number** can talk to it. No
deployment, no purchase, no production change. Uses the local database and
the sample workspace `demo@botella.ai` / `Password123`.

## One-time: get the 4 values from Meta (≈15 min)

At developers.facebook.com → **My Apps** → your app (add the **WhatsApp**
product if it isn't there):

| Put in `.env` | Where in Meta |
| --- | --- |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → **API Setup** → "Phone number ID" (not the number itself) |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp → **API Setup** → temporary token (24 h — fine for a demo; regenerate the day of the demo). Permanent token: [WHATSAPP-TEST-SETUP.md](WHATSAPP-TEST-SETUP.md) |
| `WHATSAPP_APP_SECRET` | **App settings → Basic** → App secret → Show |
| `WHATSAPP_VERIFY_TOKEN` | Make one up: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `WHATSAPP_DISPLAY_NUMBER` (optional) | The test number as shown on API Setup, e.g. `+15551234567` — gives one-tap "open WhatsApp" buttons |

Also on **API Setup → To**: add and verify each phone that will be used in
the demo (up to 5). The test number only messages verified phones.

Open `.env` in VS Code, add the lines, save. Don't paste the values anywhere
else.

## Each demo: start it

```
npm run demo:whatsapp
```

It checks the values (without showing them), builds, opens the tunnel,
starts Aura, tests the webhook through the public address, then prints:

- the **Callback URL** → Meta: WhatsApp → **Configuration** → Webhook →
  Edit → paste it, Verify token = your `WHATSAPP_VERIFY_TOKEN`, **Verify and
  save**, then subscribe the **messages** field (first time only).
- the **Aura address** to open on your computer and phone.

The address changes every run, so update the Callback URL in Meta each time.
Restarting without code changes is faster: `npm run demo:whatsapp -- --no-build`.

Keep the terminal open during the demo. Ctrl+C stops it.

## Demo script (≈5 min)

1. On the phone, send **Hi** to the test number → Aura replies with a
   welcome and a sign-in link.
2. Tap the link → log in as `demo@botella.ai` → confirm → Aura shows a code.
3. Send the code on WhatsApp → linked to the "Botella Demo Co." workspace.
4. **MENU** → show Dashboard, Pending Approvals, Campaigns, Content Calendar.
5. Pending Approvals → pick a draft → **Approve** → Aura asks for
   confirmation → yes. (Tap the menu options and buttons rather than typing
   long requests — taps never need the AI.)
6. On the computer, show the same draft approved in the dashboard.
7. **STOP** → opt-out confirmation; **START** → back on.
8. **LOGOUT** to finish.

**Avoid during the demo:** asking Aura to *write* new content. That needs
Gemini, whose free daily quota was exhausted in testing — check it works
the morning of the demo, or Aura will politely say it is at its limit.
**Don't publish** to real social accounts from the demo workspace.

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| "Add these to .env first" | A value is missing or empty |
| Meta: "callback URL or verify token couldn't be validated" | The demo isn't running, the URL is from an old run, or the token differs from `.env` |
| Message sent, no reply | Webhook field **messages** not subscribed; phone not a verified recipient; check `.demo-whatsapp.log` |
| Error 190 / "access token expired" in the log | Temporary token expired — copy a new one, restart |
| "(#131030) Recipient phone number not in allowed list" | Add the phone on API Setup → To |
| Sign-in page loops back to login | Open the printed address, not `localhost` |
