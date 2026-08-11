export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const { message, history = [] } = await request.json();

        if (!message) {
          return new Response("Missing message", { status: 400 });
        }

        // Get existing permanent memories
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

Your personality:
- Friendly and conversational.
- Intelligent and thoughtful.
- Direct when answering questions.
- Do not repeatedly say that you are a computer program.
- Do not invent stories or unrelated information.
- Do not produce huge walls of text unless the user asks for detail.
- Answer what the user actually asked.

PERMANENT MEMORY

These are things you already know about the user:

${memoryText}

Use these memories naturally when they are relevant.

IMPORTANT:
Not everything the user says should be remembered permanently.
Only save information that is genuinely useful for future conversations.
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

        // Generate the normal AI response
        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages,
            max_tokens: 512
          }
        );

        const response = result.response || "";

        /*
          Ask the AI whether this message contains something
          worth remembering permanently.
        */
        const memoryCheck = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content: `
You decide whether a user's message contains useful personal information
that should be remembered for future conversations.

Save things such as:
- Name
- Important preferences
- Hobbies
- Long-term goals
- Important projects
- Useful personal facts

Do NOT save:
- Temporary questions
- Random statements
- One-off requests
- General knowledge
- Casual conversation

Respond ONLY with JSON in this exact format:

{
  "remember": true,
  "memory": "short useful memory"
}

or

{
  "remember": false,
  "memory": ""
}
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

        let memoryDecision = null;

        try {
          memoryDecision = JSON.parse(memoryCheck.response);
        } catch {
          memoryDecision = null;
        }

        // Save the memory if the AI decided it was useful
        if (
          memoryDecision &&
          memoryDecision.remember === true &&
          memoryDecision.memory
        ) {
          await env.DB
            .prepare(
              "INSERT INTO memories (user_id, memory) VALUES (?, ?)"
            )
            .bind("default-user", memoryDecision.memory)
            .run();
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