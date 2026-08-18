# Tom's AI

Personal AI assistant built on Cloudflare Workers AI, D1 and Cloudflare Access.

## What the current version includes

- Cloudflare Access authentication (Google identity continues to be validated by Access)
- Existing conversations and memories, preserved with an additive D1 migration
- Relevant long-term memory retrieval using Workers AI embeddings, with a graceful lexical fallback for existing memories
- Automatic web search for questions that need current or online information, with source labels
- Text, CSV, Markdown, JSON, PDF and image attachment handling in the chat composer
- Voice-first conversations: spoken turns are sent automatically and replies are read aloud
- Profile and response-style settings
- A private aggregate usage endpoint and dashboard for the configured admin email

## Deploy notes

Apply the D1 migration before deploying the Worker. The migration only adds tables/columns; it does not remove or rewrite any chats or memories.

Set `ADMIN_EMAIL` in your Worker environment to the email address allowed to view the private usage dashboard. Leave it blank to disable dashboard access. The variable is intentionally not a secret, but it should still be set per environment rather than committed with a personal address.

The app uses the Cloudflare Workers AI binding already defined in `wrangler.jsonc`; semantic memory uses `@cf/baai/bge-base-en-v1.5`.
