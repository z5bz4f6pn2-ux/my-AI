export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const { message, history = [] } = await request.json();

        if (!message) {
          return new Response("Missing message", { status: 400 });
        }

        // Get saved memories
        const memoryResult = await env.DB
          .prepare(
            "SELECT id, memory FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 30"
          )
          .bind("default-user")
          .all();

        const memories = memoryResult.results || [];

        const memoryText = memories.length
          ? memories.map(row => `- ${row.memory}`).join("\n")
          : "No permanent memories yet.";

        // Instructions for My AI
        const systemPrompt = `
You are My AI, a helpful, intelligent and natural AI assistant.

Be friendly, conversational and thoughtful.
Answer the user's actual question.
Do not repeatedly say that you are a computer program.
Do not invent stories or unrelated information.
Do not produce huge walls of text unless the user asks for detail.

PERMANENT MEMORIES ABOUT THE USER:

${memoryText}

Use these memories naturally when they are relevant.
`;

        const messages = [
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

        // Generate the normal response
        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages,
            max_tokens: 512
          }
        );

        const response = result.response || "";

        /*
          Decide whether the user's message contains
          something useful to remember.
        */
        const memoryCheck = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content: `
You are My AI's memory system.

Your job is to identify specific personal information
that would be useful in future conversations.

IMPORTANT:
If something is worth remembering, preserve ALL important
specific details from the user's message.

For example:

User:
"I've decided I want to learn Spanish."

Memory:
"The user wants to learn Spanish."

NOT:
"The user wants to learn a language."

Another example:

User:
"My favourite colour is blue."

Memory:
"The user's favourite colour is blue."

NOT:
"The user has a favourite colour."

Another example:

User:
"I want to become a professional mechanic."

Memory:
"The user wants to become a professional mechanic."

Keep names, places, languages, numbers, preferences,
goals and other important details exactly when relevant.

Only save useful long-term information.

Do NOT save:
- Temporary questions
- Calculations
- One-off requests
- General knowledge
- Random conversation
- Things that are unlikely to matter later

If useful information exists, reply:

YES: [specific memory]

If there is nothing worth remembering, reply:

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

        if (memoryDecision.toUpperCase().startsWith("YES:")) {
          const memory = memoryDecision.substring(4).trim();

          if (memory.length > 0) {
            await env.DB
              .prepare(
                "INSERT INTO memories (user_id, memory) VALUES (?, ?)"
              )
              .bind("default-user", memory)
              .run();
          }
        }

        return Response.json({
          response
        });

      } catch (error) {
        return Response.json(
          { error: error.message },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};