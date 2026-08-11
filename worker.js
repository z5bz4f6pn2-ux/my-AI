export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const userId = "default-user";
        // --------------------------------------------------
    // GET SAVED MEMORIES
    // --------------------------------------------------

    if (
      url.pathname === "/api/memories" &&
      request.method === "GET"
    ) {
      try {

        const result =
          await env.DB
            .prepare(`
              SELECT id, memory, created_at
              FROM memories
              WHERE user_id = ?
              ORDER BY created_at DESC
            `)
            .bind(userId)
            .all();

        return Response.json({
          memories:
            result.results || []
        });

      } catch (error) {

        return Response.json(
          {
            error:
              error.message
          },
          {
            status: 500
          }
        );

      }
    }


    // --------------------------------------------------
    // DELETE ONE MEMORY
    // --------------------------------------------------

    if (
      url.pathname.startsWith("/api/memories/") &&
      request.method === "DELETE"
    ) {
      try {

        const id =
          url.pathname
            .split("/")
            .pop();


        await env.DB
          .prepare(`
            DELETE FROM memories
            WHERE id = ? AND user_id = ?
          `)
          .bind(
            id,
            userId
          )
          .run();


        return Response.json({
          success: true
        });

      } catch (error) {

        return Response.json(
          {
            error:
              error.message
          },
          {
            status: 500
          }
        );

      }
    }

    // --------------------------------------------------
    // GET SAVED CONVERSATIONS
    // --------------------------------------------------

    if (
      url.pathname === "/api/conversations" &&
      request.method === "GET"
    ) {
      try {
        const result = await env.DB
          .prepare(`
            SELECT id, title, created_at, updated_at
            FROM conversations
            WHERE user_id = ?
            ORDER BY updated_at DESC
          `)
          .bind(userId)
          .all();

        return Response.json({
          conversations: result.results || []
        });

      } catch (error) {
        return Response.json(
          { error: error.message },
          { status: 500 }
        );
      }
    }


    // --------------------------------------------------
    // GET ONE SAVED CONVERSATION
    // --------------------------------------------------

    if (
      url.pathname.startsWith("/api/conversations/") &&
      request.method === "GET"
    ) {
      try {
        const id =
          url.pathname.split("/").pop();

        const conversation =
          await env.DB
            .prepare(`
              SELECT id, title, created_at, updated_at
              FROM conversations
              WHERE id = ? AND user_id = ?
            `)
            .bind(id, userId)
            .first();

        if (!conversation) {
          return Response.json(
            {
              error:
                "Conversation not found"
            },
            {
              status: 404
            }
          );
        }

        const messages =
          await env.DB
            .prepare(`
              SELECT role, content, created_at
              FROM messages
              WHERE conversation_id = ?
              ORDER BY id ASC
            `)
            .bind(id)
            .all();

        return Response.json({
          conversation,
          messages:
            messages.results || []
        });

      } catch (error) {

        return Response.json(
          {
            error:
              error.message
          },
          {
            status: 500
          }
        );

      }
    }


    // --------------------------------------------------
    // CHAT
    // --------------------------------------------------

    if (
      url.pathname === "/api/chat" &&
      request.method === "POST"
    ) {

      try {

        const {
          message,
          history = [],
          conversationId = null
        } = await request.json();


        if (!message) {

          return Response.json(
            {
              error:
                "Missing message"
            },
            {
              status: 400
            }
          );

        }


        // ----------------------------------------------
        // CREATE OR LOAD CONVERSATION
        // ----------------------------------------------

        let currentConversationId =
          conversationId;


        if (!currentConversationId) {

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
              SELECT id, memory
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
          memories.length
            ? memories
                .map(
                  row =>
                    `- ${row.memory}`
                )
                .join("\n")
            : "No permanent memories yet.";


        // ----------------------------------------------
        // SPEECH CORRECTION
        // ----------------------------------------------

        let understoodMessage =
          message;


        understoodMessage =
          understoodMessage.replace(
            /\bweather intelligence\b/gi,
            "whether intelligence"
          );


        // ----------------------------------------------
        // AI SYSTEM PROMPT
        // ----------------------------------------------

        const systemPrompt = `
You are My AI.

You are a personal AI assistant designed for natural,
intelligent and meaningful conversations.

Be friendly, intelligent, thoughtful, calm, honest and direct.

Talk naturally.

Do not behave like a customer-service chatbot.

Do not automatically turn every answer into a numbered list.

Match the length of your response to the user's message.

Do not automatically ask a question at the end of every response.

Only ask a question when it is genuinely useful or necessary.

Do not use unnecessary filler.

Do not repeatedly say you are an AI.

Do not invent information.

Do not simply agree with everything the user says.

If the user is wrong, explain why respectfully.

If something is uncertain, say so.

IMPORTANT MEMORY RULE:

Only use a saved memory when it is genuinely relevant.

Do not invent connections between unrelated memories and the
current conversation.

PERMANENT MEMORY:

${memoryText}

CURRENT USER MESSAGE:

${understoodMessage}
`;


        // ----------------------------------------------
        // GENERATE AI RESPONSE
        // ----------------------------------------------

        const messages = [

          {
            role:
              "system",

            content:
              systemPrompt
          },

          ...history,

          {
            role:
              "user",

            content:
              understoodMessage
          }

        ];


        const result =
          await env.AI.run(
            "@cf/meta/llama-3.1-8b-instruct-fast",
            {
              messages,
              max_tokens: 512
            }
          );


        const response =
          result.response ||
          "I couldn't generate a response.";


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
        // UPDATE TIME
        // ----------------------------------------------

        await env.DB
          .prepare(`
            UPDATE conversations
            SET updated_at =
              current_timestamp
            WHERE id = ?
          `)
          .bind(
            currentConversationId
          )
          .run();


        // ----------------------------------------------
        // AUTOMATIC CHAT TITLE
        // ----------------------------------------------

        const existingConversation =
          await env.DB
            .prepare(`
              SELECT title
              FROM conversations
              WHERE id = ?
            `)
            .bind(
              currentConversationId
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
                "@cf/meta/llama-3.1-8b-instruct-fast",
                {
                  messages: [
                    {
                      role:
                        "system",

                      content: `
Create a very short title for this conversation.

Rules:
- Maximum 6 words.
- Do not use quotation marks.
- Do not say "Chat".
- Do not say "Conversation".
- Describe the main subject.
- Do not invent information.
`
                    },

                    {
                      role:
                        "user",

                      content:
                        message
                    }
                  ],

                  max_tokens: 30
                }
              );


            let title =
              (
                titleResult.response ||
                ""
              ).trim();


            title =
              title
                .replace(/^["']|["']$/g, "")
                .replace(/\n/g, " ")
                .trim();


            if (
              title &&
              title.length > 0 &&
              title.length < 80
            ) {

              await env.DB
                .prepare(`
                  UPDATE conversations
                  SET title = ?
                  WHERE id = ?
                `)
                .bind(
                  title,
                  currentConversationId
                )
                .run();

            }

          } catch (titleError) {

            console.error(
              "Title error:",
              titleError
            );

          }

        }


        // ----------------------------------------------
        // MEMORY EXTRACTION
        // ----------------------------------------------

        const memoryCheck =
          await env.AI.run(
            "@cf/meta/llama-3.1-8b-instruct-fast",
            {
              messages: [

                {
                  role:
                    "system",

                  content: `
You are the permanent memory system for My AI.

Save only useful long-term personal information.

Examples:
- Favourite things
- Personal preferences
- Goals
- Hobbies
- Languages the user wants to learn
- Important projects
- Names
- Other information that would genuinely help later

Do NOT save:
- Ordinary questions
- General knowledge
- Temporary conversation
- One-off calculations
- Random statements

Never invent information.

If useful information exists:

YES: [specific memory]

Otherwise:

NO
`
                },

                {
                  role:
                    "user",

                  content:
                    message
                }

              ],

              max_tokens: 150

            }
          );


        const memoryDecision =
          (
            memoryCheck.response ||
            ""
          ).trim();


        if (
          memoryDecision
            .toUpperCase()
            .startsWith("YES:")
        ) {

          const memory =
            memoryDecision
              .substring(4)
              .trim();


          if (
            memory.length > 0
          ) {

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


        // ----------------------------------------------
        // RETURN
        // ----------------------------------------------

        return Response.json({

          response,

          conversationId:
            currentConversationId

        });


      } catch (error) {

        console.error(error);


        return Response.json(

          {
            error:
              error.message
          },

          {
            status: 500
          }

        );

      }

    }


    return env.ASSETS.fetch(
      request
    );

  }
};