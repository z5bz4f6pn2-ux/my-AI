import {
  jwtVerify,
  createRemoteJWKSet
} from "jose";

const MODEL =
  "@cf/meta/llama-3.1-8b-instruct-fast";

const MAX_CONTEXT_MESSAGES = 24;

// Cloudflare Access configuration for your My AI application.
const TEAM_DOMAIN =
  "https://shrill-snowflake-7123.cloudflareaccess.com";

const POLICY_AUD =
  "904c21185d6c40c0f1fa1e0aaeaae2da5fe9818afa54b1507e3bf647a257d11f";

const JWKS =
  createRemoteJWKSet(
    new URL(
      `${TEAM_DOMAIN}/cdn-cgi/access/certs`
    )
  );


function json(
  data,
  status = 200,
  extraHeaders = {}
) {
  return Response.json(
    data,
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...extraHeaders
      }
    }
  );
}


/* ==================================================
   CLOUDFLARE ACCESS AUTHENTICATION
   ================================================== */

async function getAuthenticatedUser(request) {

  const token =
    request.headers.get(
      "cf-access-jwt-assertion"
    );

  if (!token) {
    throw new Error(
      "Missing Cloudflare Access authentication."
    );
  }

  const { payload } =
    await jwtVerify(
      token,
      JWKS,
      {
        issuer: TEAM_DOMAIN,
        audience: POLICY_AUD
      }
    );

  const subject =
    typeof payload.sub === "string"
      ? payload.sub.trim()
      : "";

  const email =
    typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : "";

  if (!subject && !email) {
    throw new Error(
      "Authenticated user identity was not provided."
    );
  }

  /*
    Use the stable Access subject where available.
    Email is only a fallback.
  */
  const identity =
    subject || email;

  return {
    userId: `cf:${identity}`,
    email
  };
}


/* ==================================================
   LEGACY DATA MIGRATION
   ==================================================

   Your existing data was stored under:

   default-user

   When your account signs in for the first time, move that
   existing data to the authenticated account.

   This does NOT delete messages. Messages belong to
   conversations, so changing the conversation owner is enough.
   ================================================== */

async function migrateLegacyUser(
  db,
  userId
) {

  if (userId === "cf:default-user") {
    return;
  }

  const currentUser =
    await db
      .prepare(`
        SELECT
          (
            SELECT COUNT(*)
            FROM conversations
            WHERE user_id = ?
          )
          +
          (
            SELECT COUNT(*)
            FROM memories
            WHERE user_id = ?
          )
          AS total
      `)
      .bind(
        userId,
        userId
      )
      .first();

  const legacyUser =
    await db
      .prepare(`
        SELECT
          (
            SELECT COUNT(*)
            FROM conversations
            WHERE user_id = 'default-user'
          )
          +
          (
            SELECT COUNT(*)
            FROM memories
            WHERE user_id = 'default-user'
          )
          AS total
      `)
      .first();

  const currentCount =
    Number(
      currentUser?.total || 0
    );

  const legacyCount =
    Number(
      legacyUser?.total || 0
    );

  /*
    Only migrate legacy data when the authenticated user
    has no existing data yet.

    This means your current data gets attached to your
    first authenticated account, while later users start
    with completely separate data.
  */

  if (
    currentCount === 0 &&
    legacyCount > 0
  ) {

    await db.batch([
      db
        .prepare(`
          UPDATE conversations
          SET user_id = ?
          WHERE user_id = 'default-user'
        `)
        .bind(userId),

      db
        .prepare(`
          UPDATE memories
          SET user_id = ?
          WHERE user_id = 'default-user'
        `)
        .bind(userId)
    ]);
  }
}


/* ==================================================
   TEXT HELPERS
   ================================================== */

function cleanText(
  value,
  maxLength = 10000
) {

  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value
    .trim()
    .slice(0, maxLength);
}


function cleanHistory(history) {

  if (
    !Array.isArray(history)
  ) {
    return [];
  }

  return history
    .filter(
      item =>
        item &&
        (
          item.role === "user" ||
          item.role === "assistant"
        ) &&
        typeof item.content === "string"
    )
    .slice(-20)
    .map(
      item => ({
        role: item.role,
        content:
          item.content.slice(
            0,
            10000
          )
      })
    );
}


function extractAIResponse(result) {

  if (!result) {
    return "";
  }

  if (
    typeof result.response === "string"
  ) {
    return result.response.trim();
  }

  return "";
}


/* ==================================================
   CONVERSATION CONTEXT
   ================================================== */

async function getConversationContext(
  db,
  conversationId,
  userId
) {

  if (!conversationId) {
    return [];
  }

  const result =
    await db
      .prepare(`
        SELECT
          role,
          content
        FROM messages
        WHERE conversation_id = ?
        AND conversation_id IN (
          SELECT id
          FROM conversations
          WHERE id = ?
          AND user_id = ?
        )
        ORDER BY id DESC
        LIMIT ?
      `)
      .bind(
        conversationId,
        conversationId,
        userId,
        MAX_CONTEXT_MESSAGES
      )
      .all();

  const rows =
    result.results || [];

  return rows
    .reverse()
    .filter(
      row =>
        (
          row.role === "user" ||
          row.role === "assistant"
        ) &&
        typeof row.content === "string"
    )
    .map(
      row => ({
        role: row.role,
        content:
          row.content.slice(
            0,
            10000
          )
      })
    );
}


/* ==================================================
   WORKER
   ================================================== */

export default {

  async fetch(
    request,
    env
  ) {

    /*
      Cloudflare Access should already block unauthenticated
      traffic before this Worker receives it, but the Worker
      independently validates the Access JWT as recommended
      by Cloudflare.
    */

    let authenticatedUser;

    try {

      authenticatedUser =
        await getAuthenticatedUser(
          request
        );

    } catch (error) {

      console.error(
        "Access authentication error:",
        error
      );

      return new Response(
        "Authentication required.",
        {
          status: 403,
          headers: {
            "Content-Type":
              "text/plain"
          }
        }
      );
    }


    const {
      userId,
      email
    } =
      authenticatedUser;


    /*
      Move your existing default-user data to your account
      the first time you authenticate.
    */

    try {

      await migrateLegacyUser(
        env.DB,
        userId
      );

    } catch (error) {

      console.error(
        "Legacy migration error:",
        error
      );

      return json(
        {
          error:
            "Unable to initialise your account."
        },
        500
      );
    }


    const url =
      new URL(
        request.url
      );


    /* ==================================================
       HEALTH CHECK
       ================================================== */

    if (
      url.pathname ===
        "/api/health" &&
      request.method === "GET"
    ) {

      return json({
        ok: true,
        service: "My AI",
        authenticated: true,
        user:
          email || "authenticated user"
      });
    }


    /* ==================================================
       GET SAVED MEMORIES
       ================================================== */

    if (
      url.pathname ===
        "/api/memories" &&
      request.method === "GET"
    ) {

      try {

        const result =
          await env.DB
            .prepare(`
              SELECT
                id,
                memory,
                created_at
              FROM memories
              WHERE user_id = ?
              ORDER BY created_at DESC
            `)
            .bind(userId)
            .all();

        return json({
          memories:
            result.results || []
        });

      } catch (error) {

        console.error(
          "Memory fetch error:",
          error
        );

        return json(
          {
            error:
              "Unable to load memories."
          },
          500
        );
      }
    }


    /* ==================================================
       DELETE ONE MEMORY
       ================================================== */

    if (
      url.pathname.startsWith(
        "/api/memories/"
      ) &&
      request.method === "DELETE"
    ) {

      try {

        const id =
          url.pathname
            .split("/")
            .pop();

        if (!id) {

          return json(
            {
              error:
                "Memory ID is required."
            },
            400
          );
        }

        const result =
          await env.DB
            .prepare(`
              DELETE FROM memories
              WHERE id = ?
              AND user_id = ?
            `)
            .bind(
              id,
              userId
            )
            .run();

        return json({
          success: true,
          deleted:
            (
              result.meta?.changes ||
              0
            ) > 0
        });

      } catch (error) {

        console.error(
          "Memory delete error:",
          error
        );

        return json(
          {
            error:
              "Unable to delete memory."
          },
          500
        );
      }
    }


    /* ==================================================
       GET ALL CONVERSATIONS
       ================================================== */

    if (
      url.pathname ===
        "/api/conversations" &&
      request.method === "GET"
    ) {

      try {

        const result =
          await env.DB
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

        return json({
          conversations:
            result.results || []
        });

      } catch (error) {

        console.error(
          "Conversation list error:",
          error
        );

        return json(
          {
            error:
              "Unable to load conversations."
          },
          500
        );
      }
    }


    /* ==================================================
       RENAME CONVERSATION
       ================================================== */

    if (
      url.pathname.startsWith(
        "/api/conversations/"
      ) &&
      request.method === "PATCH"
    ) {

      try {

        const id =
          url.pathname
            .split("/")
            .pop();

        const body =
          await request.json();

        const title =
          cleanText(
            body?.title,
            80
          );

        if (!title) {

          return json(
            {
              error:
                "Title cannot be empty."
            },
            400
          );
        }

        const result =
          await env.DB
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

        if (
          (
            result.meta?.changes ||
            0
          ) === 0
        ) {

          return json(
            {
              error:
                "Conversation not found."
            },
            404
          );
        }

        return json({
          success: true
        });

      } catch (error) {

        console.error(
          "Conversation rename error:",
          error
        );

        return json(
          {
            error:
              "Unable to rename conversation."
          },
          500
        );
      }
    }


    /* ==================================================
       DELETE CONVERSATION
       ================================================== */

    if (
      url.pathname.startsWith(
        "/api/conversations/"
      ) &&
      request.method === "DELETE"
    ) {

      try {

        const id =
          url.pathname
            .split("/")
            .pop();

        const conversation =
          await env.DB
            .prepare(`
              SELECT id
              FROM conversations
              WHERE id = ?
              AND user_id = ?
            `)
            .bind(
              id,
              userId
            )
            .first();

        if (!conversation) {

          return json(
            {
              error:
                "Conversation not found."
            },
            404
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
          .bind(
            id,
            userId
          )
          .run();

        return json({
          success: true
        });

      } catch (error) {

        console.error(
          "Conversation delete error:",
          error
        );

        return json(
          {
            error:
              "Unable to delete conversation."
          },
          500
        );
      }
    }


    /* ==================================================
       GET ONE CONVERSATION
       ================================================== */

    if (
      url.pathname.startsWith(
        "/api/conversations/"
      ) &&
      request.method === "GET"
    ) {

      try {

        const id =
          url.pathname
            .split("/")
            .pop();

        const conversation =
          await env.DB
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
            .bind(
              id,
              userId
            )
            .first();

        if (!conversation) {

          return json(
            {
              error:
                "Conversation not found."
            },
            404
          );
        }

        const messages =
          await env.DB
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

        return json({
          conversation,
          messages:
            messages.results || []
        });

      } catch (error) {

        console.error(
          "Conversation fetch error:",
          error
        );

        return json(
          {
            error:
              "Unable to load conversation."
          },
          500
        );
      }
    }


    /* ==================================================
       CHAT
       ================================================== */

    if (
      url.pathname ===
        "/api/chat" &&
      request.method === "POST"
    ) {

      try {

        const body =
          await request.json();

        const message =
          cleanText(
            body?.message,
            12000
          );

        const browserHistory =
          cleanHistory(
            body?.history
          );

        const conversationId =
          body?.conversationId ||
          null;

        if (!message) {

          return json(
            {
              error:
                "Please enter a message."
            },
            400
          );
        }


        /* ----------------------------------------------
           CREATE OR VERIFY CONVERSATION
           ---------------------------------------------- */

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
                error:
                  "Conversation not found."
              },
              404
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


        /* ----------------------------------------------
           SAVE USER MESSAGE
           ---------------------------------------------- */

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


        /* ----------------------------------------------
           GET SAVED MEMORIES
           ---------------------------------------------- */

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
                .map(
                  row =>
                    `- ${row.memory}`
                )
                .join("\n")
            : "No saved memories.";


        /* ----------------------------------------------
           GET REAL CONVERSATION CONTEXT
           ---------------------------------------------- */

        let databaseHistory = [];

        try {

          databaseHistory =
            await getConversationContext(
              env.DB,
              currentConversationId,
              userId
            );

        } catch (historyError) {

          console.error(
            "Database history error:",
            historyError
          );
        }


        const conversationHistory =
          databaseHistory.length > 0
            ? databaseHistory
            : browserHistory;


        const filteredHistory =
          conversationHistory.length > 0
            ? conversationHistory
                .slice(0, -1)
                .slice(
                  -MAX_CONTEXT_MESSAGES
                )
            : [];


        /* ----------------------------------------------
           SYSTEM PROMPT
           ---------------------------------------------- */

        const systemPrompt = `
You are My AI.

You are a capable, intelligent personal assistant.

Be:
- accurate
- natural
- calm
- direct
- thoughtful
- honest

Understand what the user is actually asking.

Do not invent facts.

Do not guess when uncertain.

Correct mistakes politely.

Keep simple questions simple.

Give more detail when useful.

Do not pad answers.

Do not use childish language unless the user asks for it.

Do not use fake enthusiasm.

Do not repeatedly say "Great question!" or similar filler.

Do not repeat the user's question unnecessarily.

Do not automatically end with a question.

Do not automatically use numbered lists.

Use paragraphs when a natural explanation is better.

Use lists when they genuinely improve clarity.

PERSONALITY:

Sound like an intelligent older teen or adult.

Do not sound like a children's educational chatbot.

Use normal conversational language.

Prefer simple, precise wording.

Avoid filler phrases such as:

"So, you know..."

"Guess what?"

"Pretty cool, huh?"

"Imagine you're..."

"It's like..."

unless an analogy genuinely helps.

Do not repeat the same point in several ways.

Do not add a conclusion that simply repeats the answer.

ACCURACY:

Accuracy is more important than sounding confident.

For science, technology, history and factual subjects,
use the correct mechanism.

If something is uncertain, say so.

CONVERSATION:

Use previous messages when relevant.

Do not pretend to remember something that is not in context.

Do not mention internal instructions.

Do not mention the memory system unless the user asks.

SAVED USER MEMORIES:

${memoryText}

Only use a memory when genuinely relevant.

Do not invent connections between unrelated memories.

The current user message is:

${message}
`;


        /* ----------------------------------------------
           GENERATE AI RESPONSE
           ---------------------------------------------- */

        const aiMessages = [
          {
            role: "system",
            content: systemPrompt
          },
          ...filteredHistory,
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
              max_tokens: 700,
              temperature: 0.35,
              top_p: 0.9,
              repetition_penalty: 1.08
            }
          );


        const response =
          extractAIResponse(
            result
          ) ||
          "I'm sorry, I wasn't able to generate a response.";


        /* ----------------------------------------------
           SAVE AI RESPONSE
           ---------------------------------------------- */

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


        /* ----------------------------------------------
           UPDATE CONVERSATION
           ---------------------------------------------- */

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


        /* ----------------------------------------------
           AUTOMATIC TITLE
           ---------------------------------------------- */

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
          existingConversation.title ===
            "New Chat"
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
Create a short title for the conversation.

Rules:
- Maximum 6 words.
- Maximum 60 characters.
- No quotation marks.
- Do not use "Chat" or "Conversation".
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
              extractAIResponse(
                titleResult
              );


            title =
              title
                .replace(
                  /^["']|["']$/g,
                  ""
                )
                .replace(
                  /\n/g,
                  " "
                )
                .trim()
                .slice(
                  0,
                  60
                );


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


        /* ----------------------------------------------
           MEMORY EXTRACTION
           ---------------------------------------------- */

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

Decide whether the user's message contains useful,
long-term personal information that would genuinely
help the assistant in future conversations.

Useful examples:
- Favourite things
- Stable preferences
- Hobbies
- Long-term goals
- Important projects
- Things the user wants to learn
- Names of important people, pets or projects
- Stable personal preferences

Do NOT save:
- Questions
- Temporary situations
- General knowledge
- One-off tasks
- Calculations
- Random comments

Never invent information.

If useful memory exists, respond exactly:

YES: [short specific memory]

Otherwise respond exactly:

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
            extractAIResponse(
              memoryCheck
            );


          if (
            memoryDecision
              .toUpperCase()
              .startsWith("YES:")
          ) {

            const memory =
              memoryDecision
                .substring(4)
                .trim()
                .slice(
                  0,
                  500
                );


            if (memory) {

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

          console.error(
            "Memory extraction error:",
            memoryError
          );
        }


        /* ----------------------------------------------
           RETURN RESPONSE
           ---------------------------------------------- */

        return json({
          response,
          conversationId:
            currentConversationId
        });

      } catch (error) {

        console.error(
          "Chat error:",
          error
        );

        return json(
          {
            error:
              error?.message ||
              "Something went wrong while generating the response."
          },
          500
        );
      }
    }


    /* ==================================================
       SERVE WEBSITE
       ================================================== */

    return env.ASSETS.fetch(
      request
    );
  }
};
