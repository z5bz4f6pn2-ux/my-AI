export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const {
          message,
          history = [],
          conversationId = null
        } = await request.json();

        if (!message) {
          return Response.json(
            { error: "Missing message" },
            { status: 400 }
          );
        }

        const userId = "default-user";

        /*
         * ---------------------------------------------------------
         * 1. CREATE OR LOAD CONVERSATION
         * ---------------------------------------------------------
         */

        let currentConversationId = conversationId;

        if (!currentConversationId) {
          const conversation = await env.DB
            .prepare(`
              INSERT INTO conversations
              (user_id, title)
              VALUES (?, ?)
              RETURNING id
            `)
            .bind(userId, "New Chat")
            .first();

          currentConversationId = conversation.id;
        }

        /*
         * ---------------------------------------------------------
         * 2. SAVE USER MESSAGE
         * ---------------------------------------------------------
         */

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

        /*
         * ---------------------------------------------------------
         * 3. GET PERMANENT MEMORIES
         * ---------------------------------------------------------
         */

        const memoryResult = await env.DB
          .prepare(`
            SELECT id, memory
            FROM memories
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 30
          `)
          .bind(userId)
          .all();

        const memories = memoryResult.results || [];

        const memoryText = memories.length
          ? memories
              .map(row => `- ${row.memory}`)
              .join("\n")
          : "No permanent memories yet.";

        /*
         * ---------------------------------------------------------
         * 4. CORRECT OBVIOUS SPEECH-TO-TEXT MISTAKES
         * ---------------------------------------------------------
         */

        let understoodMessage = message;

        understoodMessage = understoodMessage.replace(
          /\bweather intelligence\b/gi,
          "whether intelligence"
        );

        /*
         * ---------------------------------------------------------
         * 5. AI PERSONALITY
         * ---------------------------------------------------------
         */

        const systemPrompt = `
You are My AI.

You are a personal AI assistant designed for natural,
intelligent and meaningful conversations.

PERSONALITY

Be friendly, intelligent, thoughtful, calm, honest and direct.

You can use humour naturally when appropriate.

Do not behave like a customer-service chatbot.

CONVERSATION STYLE

Talk naturally.

Do not turn every answer into a numbered list.

Do not write an essay when a short answer is enough.

Match the length of your answer to the user's question.

For casual conversation, be conversational.

For simple questions, answer simply.

For complicated questions, explain them properly.

Do not automatically ask a question at the end of every response.

Only ask a follow-up question when the user's request is genuinely
unclear or a follow-up is actually necessary.

Do not use filler such as:
"That's a great question!"
"Certainly!"
"Of course!"

Do not repeatedly tell the user that you are an AI.

Do not invent stories or unrelated information.

Do not repeat information unnecessarily.

REASONING

Do not simply agree with everything the user says.

If the user is wrong, explain why respectfully.

If something is uncertain, say so.

For subjective questions, give a reasoned opinion.

Focus on what the user is actually asking.

IMPORTANT MEMORY RULE

Do not invent connections between the user's current question
and their memories.

A memory should only be mentioned when it is clearly relevant.

For example, knowing that the user wants to learn Spanish does NOT
mean that an unrelated question is about Spanish.

Do not claim the user has mentioned something before unless it
actually appears in the conversation history or permanent memory.

PERMANENT MEMORY

These are the user's saved memories:

${memoryText}

Use them naturally when genuinely relevant.

CONVERSATION HISTORY

Use the recent conversation history to understand references,
follow-up questions and pronouns.

Do not allow unrelated previous conversations to override
the meaning of the current question.

Your goal is to have a natural, intelligent conversation rather
than producing a generic AI essay.
`;

        /*
         * ---------------------------------------------------------
         * 6. GENERATE AI RESPONSE
         * ---------------------------------------------------------
         */

        const messages = [
          {
            role: "system",
            content: systemPrompt
          },
          ...history,
          {
            role: "user",
            content: understoodMessage
          }
        ];

        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages,
            max_tokens: 512
          }
        );

        const response =
          result.response ||
          "I couldn't generate a response.";

        /*
         * ---------------------------------------------------------
         * 7. SAVE AI RESPONSE
         * ---------------------------------------------------------
         */

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

        /*
         * ---------------------------------------------------------
         * 8. UPDATE CONVERSATION TIMESTAMP
         * ---------------------------------------------------------
         */

        await env.DB
          .prepare(`
            UPDATE conversations
            SET updated_at = current_timestamp
            WHERE id = ?
          `)
          .bind(currentConversationId)
          .run();

        /*
         * ---------------------------------------------------------
         * 9. MEMORY EXTRACTION
         * ---------------------------------------------------------
         */

        const memoryCheck = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content: `
You are the permanent memory system for My AI.

Decide whether the user's message contains useful personal
information that should be remembered for future conversations.

Useful memories include:
- Personal preferences
- Favourite things
- Goals
- Hobbies
- Languages they want to learn
- Important projects
- Names
- Other long-term information

Do NOT save:
- Ordinary questions
- General knowledge
- Temporary conversation
- One-off calculations
- Random statements unlikely to matter later

Never invent information.

If there is something genuinely useful to remember, reply:

YES: [specific memory]

Otherwise reply:

NO
`
              },
              {
                role: "user",
                content: message
              }
            ],
            max_tokens: 150
          }
        );

        const memoryDecision =
          (memoryCheck.response || "").trim();

        if (
          memoryDecision
            .toUpperCase()
            .startsWith("YES:")
        ) {
          const memory =
            memoryDecision.substring(4).trim();

          if (memory.length > 0) {
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

        /*
         * ---------------------------------------------------------
         * 10. RETURN RESPONSE
         * ---------------------------------------------------------
         */

        return Response.json({
          response,
          conversationId: currentConversationId
        });

      } catch (error) {

        console.error(error);

        return Response.json(
          {
            error: error.message
          },
          {
            status: 500
          }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};