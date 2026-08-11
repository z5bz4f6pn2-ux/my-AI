export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const { message, history = [] } = await request.json();

        if (!message) {
          return new Response("Missing message", { status: 400 });
        }

        const messages = [
          {
            role: "system",
            content:
              "You are My AI, a helpful, intelligent and conversational AI assistant. Speak naturally and directly. Answer the user's actual question. Do not continue stories or text unless the user asks you to. Keep responses reasonably concise unless more detail is useful."
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

        return Response.json({
          response: result.response
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