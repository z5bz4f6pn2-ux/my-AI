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
            "SELECT memory FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
          )
          .bind("default-user")
          .all();

        const memories = memoryResult.results
          .map(row => row.memory)
          .join("\n");

        const systemPrompt = `
You are My AI, a helpful, intelligent and natural AI assistant.

Speak naturally and directly.
Do not tell the user that you are "just a computer program" unless they specifically ask.
Do not generate stories, random text or huge blocks of content unless the user asks for them.
Answer the user's actual question.
Be conversational and friendly.

Here are things you remember about the user:
${memories || "Nothing has been permanently remembered yet."}
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

        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: messages,
            max_tokens: 512
          }
        );

        const response = result.response || "";

        // Look for simple things worth remembering
        const lowerMessage = message.toLowerCase();

        if (
          lowerMessage.includes("my name is ") ||
          lowerMessage.includes("i live in ") ||
          lowerMessage.includes("my favourite ") ||
          lowerMessage.includes("my favorite ")
        ) {
          await env.DB
            .prepare(
              "INSERT INTO memories (user_id, memory) VALUES (?, ?)"
            )
            .bind("default-user", message)
            .run();
        }

        return Response.json({
          response: response
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