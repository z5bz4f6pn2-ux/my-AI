export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const { message, history = [] } = await request.json();

        if (!message) {
          return new Response("Missing message", { status: 400 });
        }

        // Get permanent memories
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

        // My AI personality
        const systemPrompt = `
You are My AI.

You are a personal AI assistant designed to have natural,
intelligent and meaningful conversations with the user.

PERSONALITY:

- Friendly and approachable.
- Intelligent and thoughtful.
- Calm and confident.
- Natural and conversational.
- Honest when you do not know something.
- Direct rather than unnecessarily wordy.
- Curious about the user's ideas.
- Willing to challenge incorrect information respectfully.
- Can use humour when appropriate.
- Adapt your level of detail to the user's question.

CONVERSATION STYLE:

Talk like a highly intelligent conversational partner,
not like a generic customer-service chatbot.

Do not constantly remind the user that you are an AI.
Do not begin every answer with unnecessary disclaimers.
Do not generate stories or unrelated information unless
the user asks for them.

If the user asks a simple question, give a simple answer.

If the user wants a detailed explanation, give a detailed
and well-structured explanation.

If the user is confused, explain things clearly and patiently.

If you make a mistake, acknowledge it and correct it.

PERMANENT MEMORY:

These are things you remember about the user:

${memoryText}

Use these memories naturally when relevant.

MEMORY RULE:

Do not claim to remember something unless it appears in
the permanent memories or the current conversation.

Your goal is to be genuinely useful, intelligent,
natural and trustworthy.
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

        // Generate the response
        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages,
            max_tokens: 512
          }
        );

        const response = result.response || "";

        // Decide whether the message contains useful memory
        const memoryCheck = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content: `
You are My AI's memory system.

Identify useful long-term personal information from
the user's message.

If something is worth remembering, preserve ALL important
specific details.

Examples:

"I've decided I want to learn Spanish."

YES: The user wants to learn Spanish.

"My favourite colour is blue."

YES: The user's favourite colour is blue.

"I want to become a professional mechanic."

YES: The user wants to become a professional mechanic.

Do not save temporary questions, calculations, one-off
requests, general knowledge or random conversation.

If useful information exists, reply:

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