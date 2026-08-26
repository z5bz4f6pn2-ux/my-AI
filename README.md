# Tom's AI

Personal AI assistant built on Cloudflare Workers AI, D1 and Cloudflare Access.

## What the current version includes

- Cloudflare Access authentication (Google identity continues to be validated by Access)
- Existing conversations and memories, preserved with an additive D1 migration
- Relevant long-term memory retrieval using Workers AI embeddings, with a graceful lexical fallback for existing memories
- Automatic web search for questions that need current or online information, with source labels
- Text, CSV, Markdown, JSON, PDF and image attachment handling in the chat composer
- Voice-first conversations: spoken turns are sent automatically and replies are read aloud
- Interruptible Luna voice playback: tap the voice button while Luna is speaking to stop her and start recording
- England-first place matching with Eston, England as the default home location
- Concise location-aware time, date and weather using the Met Office feed when configured, with a UK Met Office model fallback
- Profile and response-style settings
- A private aggregate usage endpoint and dashboard for the configured admin email

## Deploy notes

Apply the D1 migration before deploying the Worker. The migration only adds tables/columns; it does not remove or rewrite any chats or memories.

Set `ADMIN_EMAIL` in your Worker environment to the email address allowed to view the private usage dashboard. Leave it blank to disable dashboard access. The variable is intentionally not a secret, but it should still be set per environment rather than committed with a personal address.

The app uses the Cloudflare Workers AI binding already defined in `wrangler.jsonc`; semantic memory uses `@cf/baai/bge-base-en-v1.5`.

## Met Office weather

Tom's AI supports the official Met Office Weather DataHub Global Spot hourly API. Add the API key as a Worker secret; never commit it to this repository:

```text
npx wrangler secret put MET_OFFICE_API_KEY
```

If the secret is not present or the Met Office request is temporarily unavailable, UK locations use Open-Meteo's delivery of the UKMO seamless model. Weather replies are deliberately concise and only state the verified place, temperature and wind. The saved home location defaults to `Eston, England` and can be changed in Profile & settings.
