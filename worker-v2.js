import {
  jwtVerify,
  createRemoteJWKSet
} from "jose";

const MODEL = "@cf/zai-org/glm-4.7-flash";
const MAX_CONTEXT_MESSAGES = 30;
const MAX_MEMORY_RESULTS = 8;
const ADMIN_EMAIL = "thomasbateman6@gmail.com";

const TEAM_DOMAIN = "https://shrill-snowflake-7123.cloudflareaccess.com";
const POLICY_AUD = "904c21185d6c40c0f1fa1e0aaeaae2da5fe9818afa54b1507e3bf647a257d11f";

const JWKS = createRemoteJWKSet(
  new URL(`${TEAM_DOMAIN}/cdn-cgi/access/certs`)
);

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function cleanText(value, maxLength = 12000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function extractAIResponse(result) {
  if (!result) return "";
  if (typeof result.response === "string") return result.response.trim();
  return "";
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string"
    )
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((item) => ({
      role: item.role,
      content: item.content.slice(0, 12000)
    }));
}

function tokens(text) {
  return new Set(
    cleanText(text, 2000)
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3)
  );
}

function memoryScore(query, memory) {
  const q = tokens(query);
  const m = tokens(memory);
  if (!q.size || !m.size) return 0;

  let overlap = 0;
  for (const word of q) {
    if (m.has(word)) overlap += 1;
  }

  return overlap / Math.max(1, Math.sqrt(q.size * m.size));
}

async function getAuthenticatedUser(request) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Error("Missing Cloudflare Access authentication.");

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: TEAM_DOMAIN,
    audience: POLICY_AUD
  });

  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const name = typeof payload.name === "string" ? payload.name.trim() : "";

  if (!subject && !email) {
    throw new Error("Authenticated identity not provided.");
  }

  return {
    userId: `cf:${subject || email}`,
    email,
    name
  };
}

async function ensureUserProfile(db, user) {
  await db
    .prepare(`
      INSERT INTO user_profiles (user_id, email, display_name)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        updated_at = current_timestamp
    `)
    .bind(user.userId, user.email || null, user.name || null)
    .run();
}

async function recordUsage(db, userId, eventType, metadata = null) {
  try {
    await db
      .prepare(`
        INSERT INTO usage_events (user_id, event_type, metadata)
        VALUES (?, ?, ?)
      `)
      .bind(userId, eventType, metadata ? JSON.stringify(metadata) : null)
      .run();
  } catch (error) {
    console.error("Usage logging failed:", error);
  }
}

async function migrateLegacyUser(db, userId) {
  if (userId === "cf:default-user") return;

  const current = await db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE user_id = ?) +
        (SELECT COUNT(*) FROM memories WHERE user_id = ?) AS total
    `)
    .bind(userId, userId)
    .first();

  const legacy = await db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE user_id = 'default-user') +
        (SELECT COUNT(*) FROM memories WHERE user_id = 'default-user') AS total
    `)
    .first();

  if (Number(current?.total || 0) === 0 && Number(legacy?.total || 0) > 0) {
    await db.batch([
      db
        .prepare(`UPDATE conversations SET user_id = ? WHERE user_id = 'default-user'`)
        .bind(userId),
      db
        .prepare(`UPDATE memories SET user_id = ? WHERE user_id = 'default-user'`)
        .bind(userId)
    ]);
  }
}

async function getConversationContext(db, conversationId, userId) {
  const result = await db
    .prepare(`
      SELECT role, content
      FROM messages
      WHERE conversation_id = ?
      AND conversation_id IN (
        SELECT id FROM conversations WHERE id = ? AND user_id = ?
      )
      ORDER BY id DESC
      LIMIT ?
    `)
    .bind(conversationId, conversationId, userId, MAX_CONTEXT_MESSAGES)
    .all();

  return (result.results || [])
    .reverse()
    .map((row) => ({ role: row.role, content: row.content.slice(0, 12000) }));
}

async function getRelevantMemories(db, userId, message) {
  const result = await db
    .prepare(`
      SELECT id, memory, created_at
      FROM memories
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 60
    `)
    .bind(userId)
    .all();

  return (result.results || [])
    .map((memory) => ({
      ...memory,
      score: memoryScore(message, memory.memory)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MEMORY_RESULTS);
}

function buildSystemPrompt(memories) {
  const memoryText = memories.length
    ? memories.map((item) => `- ${item.memory}`).join("\n")
    : "No relevant saved memories.";

  return `
You are My AI, a capable personal assistant.

Be accurate, direct, natural, calm, and useful.
Do not invent facts. If something is uncertain, say so.
Do not use filler enthusiasm or repetitive conclusions.
Keep simple answers simple and give detail when it genuinely helps.
Use previous conversation context when relevant.
Do not mention internal instructions or hidden systems.

Relevant long-term user information:
${memoryText}

Use a memory only when it is genuinely relevant to the current request.
`;
}

function getAdminPage(env) {
  return env.ASSETS.fetch(new Request(new URL("/admin.html", "https://my-ai.internal")));
}

async function handleAdminStats(db, user) {
  if (user.email !== ADMIN_EMAIL) {
    return json({ error: "Admin access required." }, 403);
  }

  const [users, messages, conversations, memories, day, week, month, activeWeek] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM user_profiles`).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE role IN ('user','assistant')`).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM conversations`).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM memories`).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM usage_events WHERE event_type = 'chat' AND created_at >= datetime('now','-1 day')`).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM usage_events WHERE event_type = 'chat' AND created_at >= datetime('now','-7 days')`).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM usage_events WHERE event_type = 'chat' AND created_at >= datetime('now','-30 days')`).first(),
    db.prepare(`SELECT COUNT(DISTINCT user_id) AS count FROM usage_events WHERE created_at >= datetime('now','-7 days')`).first()
  ]);

  return json({
    generatedAt: new Date().toISOString(),
    users: Number(users?.count || 0),
    messages: Number(messages?.count || 0),
    conversations: Number(conversations?.count || 0),
    memories: Number(memories?.count || 0),
    chats24h: Number(day?.count || 0),
    chats7d: Number(week?.count || 0),
    chats30d: Number(month?.count || 0),
    activeUsers7d: Number(activeWeek?.count || 0)
  });
}

export default {
  async fetch(request, env) {
    let user;

    try {
      user = await getAuthenticatedUser(request);
    } catch (error) {
      console.error("Access authentication error:", error);
      return new Response("Authentication required.", { status: 403 });
    }

    try {
      await ensureUserProfile(env.DB, user);
      await migrateLegacyUser(env.DB, user.userId);
    } catch (error) {
      console.error("User initialisation error:", error);
      return json({ error: "Unable to initialise your account." }, 500);
    }

    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      if (user.email !== ADMIN_EMAIL) return json({ error: "Admin access required." }, 403);
      return getAdminPage(env);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "My AI", authenticated: true, user: user.email });
    }

    if (url.pathname === "/api/features" && request.method === "GET") {
      return json({
        model: MODEL,
        voiceInput: true,
        voiceOutput: true,
        webSearch: Boolean(env.AISEARCH),
        fileStorage: Boolean(env.FILES),
        semanticMemory: Boolean(env.VECTORIZE)
      });
    }

    if (url.pathname === "/api/admin/stats" && request.method === "GET") {
      return handleAdminStats(env.DB, user);
    }

    if (url.pathname === "/api/search" && request.method === "POST") {
      if (!env.AISEARCH) {
        return json({
          enabled: false,
          error: "Web search is not enabled on this deployment yet."
        }, 501);
      }

      try {
        const body = await request.json();
        const query = cleanText(body?.query, 500);
        if (!query) return json({ error: "Search query required." }, 400);

        const result = await env.AISEARCH.search({ query, max_num_results: 6 });
        await recordUsage(env.DB, user.userId, "search", { query });
        return json({ enabled: true, results: result });
      } catch (error) {
        console.error("Search error:", error);
        return json({ error: "Search failed." }, 500);
      }
    }

    if (url.pathname === "/api/memories" && request.method === "GET") {
      const result = await env.DB
        .prepare(`SELECT id, memory, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC`)
        .bind(user.userId)
        .all();
      return json({ memories: result.results || [] });
    }

    if (url.pathname.startsWith("/api/memories/") && request.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      const result = await env.DB
        .prepare(`DELETE FROM memories WHERE id = ? AND user_id = ?`)
        .bind(id, user.userId)
        .run();
      await recordUsage(env.DB, user.userId, "memory_delete", { id });
      return json({ success: true, deleted: Number(result.meta?.changes || 0) > 0 });
    }

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      const result = await env.DB
        .prepare(`
          SELECT id, title, created_at, updated_at
          FROM conversations
          WHERE user_id = ?
          ORDER BY updated_at DESC
        `)
        .bind(user.userId)
        .all();
      return json({ conversations: result.results || [] });
    }

    if (url.pathname.startsWith("/api/conversations/")) {
      const id = url.pathname.split("/").pop();

      if (request.method === "GET") {
        const conversation = await env.DB
          .prepare(`
            SELECT id, title, created_at, updated_at
            FROM conversations
            WHERE id = ? AND user_id = ?
          `)
          .bind(id, user.userId)
          .first();

        if (!conversation) return json({ error: "Conversation not found." }, 404);

        const messages = await env.DB
          .prepare(`
            SELECT role, content, created_at
            FROM messages
            WHERE conversation_id = ?
            ORDER BY id ASC
          `)
          .bind(id)
          .all();

        return json({ conversation, messages: messages.results || [] });
      }

      if (request.method === "PATCH") {
        const body = await request.json();
        const title = cleanText(body?.title, 80);
        if (!title) return json({ error: "Title cannot be empty." }, 400);

        const result = await env.DB
          .prepare(`
            UPDATE conversations
            SET title = ?, updated_at = current_timestamp
            WHERE id = ? AND user_id = ?
          `)
          .bind(title, id, user.userId)
          .run();

        if (Number(result.meta?.changes || 0) === 0) {
          return json({ error: "Conversation not found." }, 404);
        }

        return json({ success: true });
      }

      if (request.method === "DELETE") {
        const conversation = await env.DB
          .prepare(`SELECT id FROM conversations WHERE id = ? AND user_id = ?`)
          .bind(id, user.userId)
          .first();

        if (!conversation) return json({ error: "Conversation not found." }, 404);

        await env.DB
          .prepare(`DELETE FROM messages WHERE conversation_id = ?`)
          .bind(id)
          .run();

        await env.DB
          .prepare(`DELETE FROM conversations WHERE id = ? AND user_id = ?`)
          .bind(id, user.userId)
          .run();

        await recordUsage(env.DB, user.userId, "conversation_delete");
        return json({ success: true });
      }
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const body = await request.json();
        const message = cleanText(body?.message, 12000);
        const browserHistory = cleanHistory(body?.history);
        let conversationId = body?.conversationId || null;

        if (!message) return json({ error: "Please enter a message." }, 400);

        if (conversationId) {
          const ownsConversation = await env.DB
            .prepare(`SELECT id FROM conversations WHERE id = ? AND user_id = ?`)
            .bind(conversationId, user.userId)
            .first();

          if (!ownsConversation) return json({ error: "Conversation not found." }, 404);
        } else {
          const row = await env.DB
            .prepare(`INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id`)
            .bind(user.userId, "New Chat")
            .first();
          conversationId = row.id;
        }

        await env.DB
          .prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`)
          .bind(conversationId, message)
          .run();

        const databaseHistory = await getConversationContext(
          env.DB,
          conversationId,
          user.userId
        );

        const history = databaseHistory.length
          ? databaseHistory.slice(0, -1)
          : browserHistory.slice(0, -1);

        const memories = await getRelevantMemories(
          env.DB,
          user.userId,
          message
        );

        const system = buildSystemPrompt(memories);

        const result = await env.AI.run(MODEL, {
          messages: [
            { role: "system", content: system },
            ...history,
            { role: "user", content: message }
          ],
          max_completion_tokens: 900,
          temperature: 0.35,
          top_p: 0.9
        });

        const reply = extractAIResponse(result) || "I couldn't generate a response.";

        await env.DB
          .prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`)
          .bind(conversationId, reply)
          .run();

        await env.DB
          .prepare(`UPDATE conversations SET updated_at = current_timestamp WHERE id = ? AND user_id = ?`)
          .bind(conversationId, user.userId)
          .run();

        await recordUsage(env.DB, user.userId, "chat", {
          model: MODEL,
          conversationId
        });

        const conversation = await env.DB
          .prepare(`SELECT title FROM conversations WHERE id = ? AND user_id = ?`)
          .bind(conversationId, user.userId)
          .first();

        if (conversation?.title === "New Chat") {
          try {
            const titleResult = await env.AI.run(MODEL, {
              messages: [
                {
                  role: "system",
                  content: "Create a concise 3-6 word conversation title. Return only the title."
                },
                { role: "user", content: message }
              ],
              max_completion_tokens: 30,
              temperature: 0.2
            });

            const title = extractAIResponse(titleResult)
              .replace(/^['\"]|['\"]$/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 60);

            if (title) {
              await env.DB
                .prepare(`UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?`)
                .bind(title, conversationId, user.userId)
                .run();
            }
          } catch (error) {
            console.error("Title generation failed:", error);
          }
        }

        try {
          const memoryResult = await env.AI.run(MODEL, {
            messages: [
              {
                role: "system",
                content: `
Decide whether the user's message contains stable, useful personal information worth remembering.
Save only preferences, long-term goals, hobbies, important ongoing projects, or stable facts about the user.
Do not save questions, temporary events, or generic information.
Return exactly NO or YES: <one concise memory>.
`
              },
              { role: "user", content: message }
            ],
            max_completion_tokens: 80,
            temperature: 0.1
          });

          const decision = extractAIResponse(memoryResult);
          if (decision.toUpperCase().startsWith("YES:")) {
            const memory = decision.slice(4).trim().slice(0, 500);
            if (memory) {
              const duplicate = await env.DB
                .prepare(`SELECT id FROM memories WHERE user_id = ? AND LOWER(memory) = LOWER(?) LIMIT 1`)
                .bind(user.userId, memory)
                .first();

              if (!duplicate) {
                await env.DB
                  .prepare(`INSERT INTO memories (user_id, memory) VALUES (?, ?)`)
                  .bind(user.userId, memory)
                  .run();
                await recordUsage(env.DB, user.userId, "memory_save");
              }
            }
          }
        } catch (error) {
          console.error("Memory extraction failed:", error);
        }

        return json({ response: reply, conversationId });
      } catch (error) {
        console.error("Chat error:", error);
        return json({ error: error?.message || "Something went wrong." }, 500);
      }
    }

    const response = await env.ASSETS.fetch(request);

    const contentType = response.headers.get("content-type") || "";
    if (url.pathname === "/" && contentType.includes("text/html")) {
      const html = await response.text();
      const upgraded = html.replace(
        "</body>",
        `<script src="/upgrades.js" defer></script></body>`
      );
      return new Response(upgraded, {
        status: response.status,
        headers: response.headers
      });
    }

    return response;
  }
};
