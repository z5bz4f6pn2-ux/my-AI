# Tom's AI

Personal AI assistant built on Cloudflare Workers AI, D1 and Cloudflare Access.

## What the current version includes

- Cloudflare Access authentication (Google identity continues to be validated by Access)
- Existing conversations and memories, preserved with an additive D1 migration
- Relevant long-term memory retrieval using Workers AI embeddings, with a graceful lexical fallback for existing memories
- Automatic web search for questions that need current or online information, with source labels
- Text, CSV, Markdown, JSON, PDF and image attachment handling in the chat composer
- Voice-first conversations: speech is sent automatically after a short pause and replies are read aloud
- Interruptible Luna voice playback: tap the voice button while Luna is speaking to stop her and start recording
- Fast reply path: conversation titles, memory extraction and usage recording run after the answer is returned
- England-first place matching with Eston, England as the default home location
- Concise location-aware time, date and weather using the Met Office feed when configured, with a UK Met Office model fallback
- Profile and response-style settings
- Secure Windows computer control through a separately authenticated local companion
- A private aggregate usage endpoint and dashboard for the configured admin email

## Deploy notes

Apply the D1 migration before deploying the Worker. The migration only adds tables/columns; it does not remove or rewrite any chats or memories.

Set `ADMIN_EMAIL` in your Worker environment to the email address allowed to view the private usage dashboard. Leave it blank to disable dashboard access. The variable is intentionally not a secret, but it should still be set per environment rather than committed with a personal address.

The app uses the Cloudflare Workers AI binding already defined in `wrangler.jsonc`; semantic memory uses `@cf/baai/bge-base-en-v1.5`.

## Windows computer control

Computer control is intentionally restricted to named actions. Tom's AI can open an approved app or HTTP/HTTPS website, find and open a safe document or media file in the current user's Desktop, Documents, Downloads or Pictures folders, adjust volume, and save a screenshot locally. Lock, restart and shutdown always require approval in a Windows dialog. The companion does not accept shell commands, scripts, deletion, passwords, purchases, or outbound messages.

The companion uses a separate Worker (`device-worker.js`) and the same D1 database. Apply `migrations/0003_windows_companion.sql`, then deploy both configurations:

```text
npx wrangler d1 migrations apply my-ai-memory --remote --config wrangler.jsonc
npx wrangler deploy --config wrangler.device.jsonc
npx wrangler deploy --config wrangler.jsonc
```

To pair a computer:

1. Open **Profile & settings → Computer control** in Tom's AI.
2. Select **Connect a Windows computer** and copy the one-time token.
3. Download `Install-TomsAICompanion.ps1` and `TomsAICompanion.ps1` into the same folder.
4. Run `Install-TomsAICompanion.ps1` with PowerShell and paste the token when prompted.

The installer stores the device token under `%LOCALAPPDATA%\TomsAI` with access restricted to the current Windows user, registers a limited scheduled task at sign-in, and starts the companion. Disconnecting the device in Tom's AI immediately revokes its token. Run `Uninstall-TomsAICompanion.ps1` to remove the scheduled task and local companion files.

## Met Office weather

Tom's AI supports the official Met Office Weather DataHub Global Spot hourly API. Add the API key as a Worker secret; never commit it to this repository:

```text
npx wrangler secret put MET_OFFICE_API_KEY
```

If the secret is not present or the Met Office request is temporarily unavailable, UK locations use Open-Meteo's delivery of the UKMO seamless model. Weather replies are deliberately concise and only state the verified place, temperature and wind. The saved home location defaults to `Eston, England` and can be changed in Profile & settings.
