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

        const systemPrompt = `
You are My AI, a helpful, intelligent and natural AI assistant.

Be friendly, conversational and thoughtful.
Answer the user's actual question.
Do not repeatedly say that you are a computer program.
Do not invent stories or unrelated information.
Do not produce huge walls of text unless the user asks for detail.

These are permanent memories about the user:

${memoryText}

Use these memories naturally when relevant.
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

        // Generate response
        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages,
            max_tokens: 512
          }
        );

        const response = result.response || "";

        /*
          Ask the AI for a simple memory decision.
          We deliberately use plain text rather than JSON.
        */
        const memoryCheck = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content: `
Decide whether the user's message contains useful personal information
that should be remembered for future conversations.

Examples worth remembering:
- Their name
- Their hobbies
- Their preferences
- Their long-term goals
- Important projects
- Useful personal facts

Examples NOT worth remembering:
- Temporary questions
- Calculations
- One-off requests
- General knowledge
- Casual conversation

If it should be remembered, reply with:

YES: followed by a short description of the memory.

If it should NOT be remembered, reply with:

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