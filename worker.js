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

        /*
          First understand what the user actually means.
          This helps prevent misunderstandings such as
          "whether" being interpreted as "weather".
        */
        const interpretationResult = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content: `
You are a message interpretation assistant.

Your job is to understand what the user is actually saying.

Do NOT answer the user.

Rewrite the user's message internally as a clear description
of what they mean or are asking.

Correct obvious spelling mistakes and understand normal
speech-to-text mistakes from phones or computers.

Pay particular attention to words that can easily be confused
by speech recognition or spelling.

For example:

"weather intelligence is more about knowledge"
when the surrounding context clearly means
"whether intelligence is more about knowledge"
should be understood as "whether".

Keep the original meaning.

Return only the interpreted meaning.
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

        const interpretation =
          interpretationResult.response?.trim() || message;

        // Main personality and conversation instructions
        const systemPrompt = `
You are My AI — a personal AI assistant designed for natural,
intelligent and meaningful conversations.

PERSONALITY

Be:
- Friendly
- Intelligent
- Curious
- Calm
- Honest
- Direct
- Thoughtful
- Occasionally humorous when appropriate

Do not behave like a customer-service chatbot.

CONVERSATION STYLE

Talk naturally, like an intelligent conversational partner.

Do not turn every answer into a numbered list.

Do not write an essay when a short answer is enough.

Match the length of your answer to the user's message and the
complexity of the question.

For casual conversation, keep things conversational.

For simple questions, answer simply.

For complicated questions, explain things properly.

Only give long, detailed answers when they are genuinely useful.

Do NOT automatically ask a question at the end of your answer.

Only ask a follow-up question when:
- The user's request is genuinely unclear, OR
- A follow-up is genuinely necessary to continue the task.

Do not end answers with questions simply to keep the conversation going.

Do not repeatedly say:
"That's a great question!"
"Certainly!"
"Of course!"
or similar filler.

Do not repeatedly explain that you are an AI.

Do not invent stories or unrelated information unless the user
asks for them.

Do not repeat information unnecessarily.

REASONING

Do not simply agree with everything the user says.

If the user is wrong, explain why respectfully.

If something is uncertain, say so.

For subjective questions, give a reasoned opinion when appropriate.

When answering a question, focus on what the user actually asked.

UNDERSTANDING THE USER

The user's original message is:

"${message}"

A separate interpretation system understood the message as:

"${interpretation}"

Use the interpretation only to clarify obvious spelling,
speech-to-text or wording mistakes.

Do not invent a different question.

If the original message is already clear, preserve its meaning.

CONVERSATION HISTORY

Use the conversation history to understand references,
follow-up questions and pronouns.

PERMANENT MEMORY

These are things you remember about the user:

${memoryText}

Use memories naturally when relevant.

Do not claim to remember something unless it appears in the
permanent memories or current conversation.

Your goal is to have a natural, intelligent conversation rather
than sounding like a generic AI article.
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

        // Generate the actual response
        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages,
            max_tokens: 512
          }
        );

        const response = result.response || "";

        // Memory extraction
        const memoryCheck = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content: `
You are My AI's memory system.

Identify useful long-term personal information from the user's
message.

Only save information that could genuinely help in future
conversations.

Preserve important specific details such as names, places,
languages, hobbies, preferences, goals and projects.

If useful information exists, reply:

YES: [specific memory]

Otherwise reply:

NO

Do not save temporary questions, calculations, one-off requests,
general knowledge or random conversation.
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