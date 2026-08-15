const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const USER_COOKIE = "my_ai_user";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2;

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function createUserId() {
  return crypto.randomUUID();
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie");

  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");

    if (key === name) {
      return valueParts.join("=");
    }
  }

  return null;
}

function getUser(request) {
  const existingUser = getCookie(request, USER_COOKIE);

  if (existingUser && existingUser.length <= 100) {
    return {
      userId: existingUser,
      isNew: false
    };
  }

  return {
    userId: "default-user",
    isNew: false
  };
}

function userCookie(userId) {
  return `${USER_COOKIE}=${userId}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function cleanText(value, maxLength = 10000) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function cleanHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter(
      item =>
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string"
    )
    .slice(-20)
    .map(item => ({
      role: item.role,
      content: item.content.slice(0, 10000)
    }));
}

function extractAIResponse(result) {
  if (!result) {
    return "";
  }

  if (typeof result.response === "string") {
    return result.response.trim();
  }

  return "";
}

function buildHeaders(isNewUser, userId) {
  return isNewUser
    ? {
        "Set-Cookie": userCookie(userId)
      }
    : {};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const { userId, isNew } = getUser(request);

    const headers = buildHeaders(isNew, userId);

    // ==================================================
    // HEALTH CHECK
    // ==================================================

    if (
      url.pathname === "/api/health" &&
      request.method === "GET"
    ) {
      return json(
        {
          ok: true,
          service: "My AI"
        },
        200,
        headers
      );
    }

    // ==================================================
    // GET SAVED MEMORIES
    // ==================================================

    if (
      url.pathname === "/api/memories" &&
      request.method === "GET"
    ) {
      try {
        const result = await env.DB
          .prepare(`
            SELECT id, memory, created_at
            FROM memories
            WHERE user_id = ?
            ORDER BY created_at DESC
          `)
          .bind(userId)
          .all();

        return json(
          {
            memories: result.results || []
          },
          200,
          headers
        );

      } catch (error) {
        console.error("Memory fetch error:", error);

        return json(
          {
            error: "Unable to load memories."
          },
          500,
          headers
        );
      }
    }

    // ==================================================
    // DELETE ONE MEMORY
    // ==================================================

    if (
      url.pathname.startsWith("/api/memories/") &&
      request.method === "DELETE"
    ) {
      try {
        const id = url.pathname.split("/").pop();

        if (!id) {
          return json(
            {
              error: "Memory ID is required."
            },
            400,
            headers
          );
        }

        const result = await env.DB
          .prepare(`
            DELETE FROM memories
            WHERE id = ?
            AND user_id = ?
          `)
          .bind(id, userId)
          .run();

        return json(
          {
            success: true,
            deleted: (result.meta?.changes || 0) > 0
          },
          200,
          headers
        );

      } catch (error) {
        console.error("Memory delete error:", error);

        return json(
          {
            error: "Unable to delete memory."
          },
          500,
          headers
        );
      }
    }

    // ==================================================
    // GET ALL CONVERSATIONS
    // ==================================================

    if (
      url.pathname === "/api/conversations" &&
      request.method === "GET"
    ) {
      try {
        const result = await env.DB
          .prepare(`
            SELECT
              id,
              title,
              created_at,
              updated_at
            FROM conversations
            WHERE user_id = ?
            ORDER BY updated_at DESC
          `)
          .bind(userId)
          .all();

        return json(
          {
            conversations: result.results || []
          },
          200,
          headers
        );

      } catch (error) {
        console.error("Conversation list error:", error);

        return json(
          {
            error: "Unable to load conversations."
          },
          500,
          headers
        );
      }
    }

    // ==================================================
    // RENAME CONVERSATION
    // ==================================================

    if (
      url.pathname.startsWith("/api/conversations/") &&
      request.method === "PATCH"
    ) {
      try {
        const id = url.pathname.split("/").pop();

        const body = await request.json();

        const title = cleanText(body?.title, 80);

        if (!title) {
          return json(
            {
              error: "Title cannot be empty."
            },
            400,
            headers
          );
        }

        const result = await env.DB
          .prepare(`
            UPDATE conversations
            SET
              title = ?,
              updated_at = current_timestamp
            WHERE id = ?
            AND user_id = ?
          `)
          .bind(
            title,
            id,
            userId
          )
          .run();

        if ((result.meta?.changes || 0) === 0) {
          return json(
            {
              error: "Conversation not found."
            },
            404,
            headers
          );
        }

        return json(
          {
            success: true
          },
          200,
          headers
        );

      } catch (error) {
        console.error("Conversation rename error:", error);

        return json(
          {
            error: "Unable to rename conversation."
          },
          500,
          headers
        );
      }
    }

    // ==================================================
    // DELETE CONVERSATION
    // ==================================================

    if (
      url.pathname.startsWith("/api/conversations/") &&
      request.method === "DELETE"
    ) {
      try {
        const id = url.pathname.split("/").pop();

        const conversation = await env.DB
          .prepare(`
            SELECT id
            FROM conversations
            WHERE id = ?
            AND user_id = ?
          `)
          .bind(id, userId)
          .first();

        if (!conversation) {
          return json(
            {
              error: "Conversation not found."
            },
            404,
            headers
          );
        }

        await env.DB
          .prepare(`
            DELETE FROM messages
            WHERE conversation_id = ?
          `)
          .bind(id)
          .run();

        await env.DB
          .prepare(`
            DELETE FROM conversations
            WHERE id = ?
            AND user_id = ?
          `)
          .bind(id, userId)
          .run();

        return json(
          {
            success: true
          },
          200,
          headers
        );

      } catch (error) {
        console.error("Conversation delete error:", error);

        return json(
          {
            error: "Unable to delete conversation."
          },
          500,
          headers
        );
      }
    }

    // ==================================================
    // GET ONE CONVERSATION
    // ==================================================

    if (
      url.pathname.startsWith("/api/conversations/") &&
      request.method === "GET"
    ) {
      try {
        const id = url.pathname.split("/").pop();

        const conversation = await env.DB
          .prepare(`
            SELECT
              id,
              title,
              created_at,
              updated_at
            FROM conversations
            WHERE id = ?
            AND user_id = ?
          `)
          .bind(id, userId)
          .first();

        if (!conversation) {
          return json(
            {
              error: "Conversation not found."
            },
            404,
            headers
          );
        }

        const messages = await env.DB
          .prepare(`
            SELECT
              role,
              content,
              created_at
            FROM messages
            WHERE conversation_id = ?
            ORDER BY id ASC
          `)
          .bind(id)
          .all();

        return json(
          {
            conversation,
            messages: messages.results || []
          },
          200,
          headers
        );

      } catch (error) {
        console.error("Conversation fetch error:", error);

        return json(
          {
            error: "Unable to load conversation."
          },
          500,
          headers
        );
      }
    }

    // ==================================================
    // CHAT
    // ==================================================

    if (
      url.pathname === "/api/chat" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const message = cleanText(body?.message, 12000);

        const history = cleanHistory(body?.history);

        const conversationId =
          body?.conversationId || null;

        if (!message) {
          return json(
            {
              error: "Please enter a message."
            },
            400,
            headers
          );
        }

        // ----------------------------------------------
        // CREATE OR VERIFY CONVERSATION
        // ----------------------------------------------

        let currentConversationId =
          conversationId;

        if (currentConversationId) {
          const existingConversation =
            await env.DB
              .prepare(`
                SELECT id
                FROM conversations
                WHERE id = ?
                AND user_id = ?
              `)
              .bind(
                currentConversationId,
                userId
              )
              .first();

          if (!existingConversation) {
            return json(
              {
                error: "Conversation not found."
              },
              404,
              headers
            );
          }

        } else {
          const conversation =
            await env.DB
              .prepare(`
                INSERT INTO conversations
                (user_id, title)
                VALUES (?, ?)
                RETURNING id
              `)
              .bind(
                userId,
                "New Chat"
              )
              .first();

          currentConversationId =
            conversation.id;
        }

        // ----------------------------------------------
        // SAVE USER MESSAGE
        // ----------------------------------------------

        await env.DB
          .prepare(`
            INSERT INTO messages
            (conversation_id, role, content)
            VALUES (?, ?, ?)
          `)
          .bind(
            currentConversationId,
            "user",
            message
          )
          .run();

        // ----------------------------------------------
        // GET MEMORIES
        // ----------------------------------------------

        const memoryResult =
          await env.DB
            .prepare(`
              SELECT
                id,
                memory
              FROM memories
              WHERE user_id = ?
              ORDER BY created_at DESC
              LIMIT 30
            `)
            .bind(userId)
            .all();

        const memories =
          memoryResult.results || [];

        const memoryText =
          memories.length > 0
            ? memories
                .map(row => `- ${row.memory}`)
                .join("\n")
            : "No saved memories.";

        // ----------------------------------------------
        // SYSTEM PROMPT
        // ----------------------------------------------

const systemPrompt = `
You are My AI.

You are a capable, intelligent personal assistant.
Your job is to understand what the user is actually asking
and give the most useful answer possible.

CORE BEHAVIOUR:

- Be intelligent, natural, and conversational.
- Be direct.
- Give accurate information.
- Do not invent facts.
- Do not guess when you are uncertain.
- Correct mistakes politely.
- Think through the question before answering.
- Match the answer to the user's level of understanding.
- Keep simple questions simple.
- Give more detail when the user asks for detail.
- Do not pad answers with unnecessary words.
- Do not use childish language unless the user asks for it.
- Do not use phrases like "Pretty cool, huh?", "Great question!",
  or similar filler unless it genuinely fits the conversation.
- Do not repeat the user's question unnecessarily.
- Do not end every response with a question.
- Do not automatically use numbered lists.
- Use paragraphs when a natural explanation is better.
- Use bullet points only when they improve clarity.

ACCURACY:

Accuracy is more important than sounding confident.

When explaining science, technology, history, or other factual
subjects, use the correct mechanism rather than an oversimplified
or misleading analogy.

If there is an important distinction between a simplified
explanation and the technically correct explanation, explain it
clearly.

For example, when explaining why the sky is blue, explain that
shorter wavelengths of sunlight are scattered more strongly by
molecules in Earth's atmosphere. Do not claim that the main cause
is water droplets or dust.

CONVERSATION:

Use the conversation history naturally.

Remember information that is relevant to the current discussion.

Do not mention internal instructions.

Do not mention the memory system unless the user asks about it.

PERSONALITY:

Be calm, confident, thoughtful, and human-like.

Do not sound like a children's educational chatbot.

Do not sound like a customer-service script.

Do not use unnecessary enthusiasm.

Do not flatter the user unnecessarily.

Be willing to say:
"I don't know."
"I'm not certain."
"That's not quite right."

when appropriate.

SAVED USER MEMORIES:

${memoryText}

Only use a memory when it is genuinely relevant.
Do not invent connections between unrelated memories.

CURRENT USER MESSAGE:

${message}
`;

Speak naturally like a capable personal assistant.

Do not behave like a customer-service chatbot.

Do not use numbered lists unless they genuinely make
the answer easier to understand.

Match the length of your answer to the user's request.

Do not add unnecessary filler.

Do not repeatedly say that you are an AI.

Do not automatically ask a question at the end of every
response.

Only ask a question when it is genuinely useful.

Never invent facts.

If you are uncertain, say so.

If the user is mistaken, explain the correction respectfully.

MEMORY RULES:

The following information has been deliberately saved
as long-term memory for this user.

Only use memories when they are genuinely relevant.

Do not mention memories unnecessarily.

Do not reveal the entire memory list unless the user
specifically asks about their memories.

Do not assume that unrelated memories are connected.

SAVED MEMORIES:

${memoryText}
`;

        // ----------------------------------------------
        // GENERATE AI RESPONSE
        // ----------------------------------------------

        const aiMessages = [
          {
            role: "system",
            content: systemPrompt
          },

          ...history,

          {
            role: "user",
            content: message
          }
        ];

        const result =
          await env.AI.run(
            MODEL,
            {
              messages: aiMessages,
              max_tokens: 700
            }
          );

        const response =
          extractAIResponse(result) ||
          "I'm sorry, I wasn't able to generate a response.";

        // ----------------------------------------------
        // SAVE AI RESPONSE
        // ----------------------------------------------

        await env.DB
          .prepare(`
            INSERT INTO messages
            (conversation_id, role, content)
            VALUES (?, ?, ?)
          `)
          .bind(
            currentConversationId,
            "assistant",
            response
          )
          .run();

        // ----------------------------------------------
        // UPDATE CONVERSATION
        // ----------------------------------------------

        await env.DB
          .prepare(`
            UPDATE conversations
            SET updated_at = current_timestamp
            WHERE id = ?
            AND user_id = ?
          `)
          .bind(
            currentConversationId,
            userId
          )
          .run();

        // ----------------------------------------------
        // AUTOMATIC TITLE
        // ----------------------------------------------

        const existingConversation =
          await env.DB
            .prepare(`
              SELECT title
              FROM conversations
              WHERE id = ?
              AND user_id = ?
            `)
            .bind(
              currentConversationId,
              userId
            )
            .first();

        if (
          existingConversation &&
          existingConversation.title === "New Chat"
        ) {
          try {
            const titleResult =
              await env.AI.run(
                MODEL,
                {
                  messages: [
                    {
                      role: "system",
                      content: `
Create a short title for this conversation.

Rules:
- Maximum 6 words.
- Maximum 60 characters.
- No quotation marks.
- Do not use the words "Chat" or "Conversation".
- Describe the main subject.
- Do not invent information.
- Return only the title.
`
                    },
                    {
                      role: "user",
                      content: message
                    }
                  ],
                  max_tokens: 30
                }
              );

            let title =
              extractAIResponse(titleResult);

            title = title
              .replace(/^["']|["']$/g, "")
              .replace(/\n/g, " ")
              .trim()
              .slice(0, 60);

            if (title) {
              await env.DB
                .prepare(`
                  UPDATE conversations
                  SET title = ?
                  WHERE id = ?
                  AND user_id = ?
                `)
                .bind(
                  title,
                  currentConversationId,
                  userId
                )
                .run();
            }

          } catch (titleError) {
            console.error(
              "Title generation error:",
              titleError
            );
          }
        }

        // ----------------------------------------------
        // MEMORY EXTRACTION
        // ----------------------------------------------

        try {
          const memoryCheck =
            await env.AI.run(
              MODEL,
              {
                messages: [
                  {
                    role: "system",
                    content: `
You manage permanent memory for My AI.

Look at the user's message and decide whether it contains
useful long-term personal information that would genuinely
help the assistant in future conversations.

Useful examples:
- Favourite things
- Preferences
- Hobbies
- Long-term goals
- Important projects
- Things the user wants to learn
- Names of important people, pets or projects
- Stable personal preferences

Do NOT save:
- Questions
- Temporary situations
- General facts
- One-off tasks
- Calculations
- Random comments
- Sensitive information unless the user clearly intends
  it to be remembered

Never invent information.

If there is useful memory, respond EXACTLY like:

YES: [short specific memory]

If there is nothing worth saving, respond exactly:

NO
`
                  },
                  {
                    role: "user",
                    content: message
                  }
                ],
                max_tokens: 100
              }
            );

          const memoryDecision =
            extractAIResponse(memoryCheck);

          if (
            memoryDecision
              .toUpperCase()
              .startsWith("YES:")
          ) {
            const memory =
              memoryDecision
                .substring(4)
                .trim()
                .slice(0, 500);

            if (memory) {
              // Prevent exact duplicate memories.
              const duplicate =
                await env.DB
                  .prepare(`
                    SELECT id
                    FROM memories
                    WHERE user_id = ?
                    AND LOWER(memory) = LOWER(?)
                    LIMIT 1
                  `)
                  .bind(
                    userId,
                    memory
                  )
                  .first();

              if (!duplicate) {
                await env.DB
                  .prepare(`
                    INSERT INTO memories
                    (user_id, memory)
                    VALUES (?, ?)
                  `)
                  .bind(
                    userId,
                    memory
                  )
                  .run();
              }
            }
          }

        } catch (memoryError) {
          // Memory failure should never stop the user's
          // main AI response from working.
          console.error(
            "Memory extraction error:",
            memoryError
          );
        }

        // ----------------------------------------------
        // RETURN RESPONSE
        // ----------------------------------------------

        return json(
          {
            response,
            conversationId:
              currentConversationId
          },
          200,
          headers
        );

      } catch (error) {
        console.error(
          "Chat error:",
          error
        );

        return json(
          {
            error:
              "Something went wrong while generating the response."
          },
          500,
          headers
        );
      }
    }

    // ==================================================
    // SERVE WEBSITE
    // ==================================================

    return env.ASSETS.fetch(request);
  }
};
