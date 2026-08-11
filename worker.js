export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const { message, history = [] } = await request.json();

        if (!message) {
          return new Response("Missing message", { status: 400 });
        }

        /*
          Correct a few obvious speech-to-text mistakes.

          IMPORTANT:
          We only make a correction when the surrounding wording
          strongly indicates what the user meant.
        */
        let understoodMessage = message;

        understoodMessage = understoodMessage.replace(
          /\bweather intelligence\b/gi,
          "whether intelligence"
        );

        /*
          Get permanent memories
        */
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
          Build the system instructions
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

IMPORTANT CONTEXT RULE

Do not invent connections between the user's current question
and their memories.

A memory should only be mentioned when it is clearly relevant
to the current conversation.

For example, knowing that the user wants to learn Spanish does
NOT mean that a completely unrelated question is about Spanish.

Do not say the user has "mentioned this before" unless the
conversation history actually contains the same subject.

USER MESSAGE

The user's message is:

"${understoodMessage}"

Answer that message directly.

PERMANENT MEMORY

These are the user's saved memories:

${memoryText}

Use them only when genuinely relevant.

CONVERSATION HISTORY

Use the conversation history to understand follow-up messages,
references and pronouns.

Do not let unrelated previous conversations override the meaning
of the current message.

Your goal is to have a natural, intelligent conversation with
the user rather than producing a generic AI essay.
`;

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

        /*
          Generate response
        */
        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages,
            max_tokens: 512
          }
        );

        const response = result.response || "";

        /*
          Memory extraction
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

If there is something genuinely useful to remember, reply:

YES: [specific memory]

Otherwise reply:

NO

Never invent information.
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