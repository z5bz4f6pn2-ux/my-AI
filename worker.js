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
- Natural
- Occasionally humorous when appropriate

Do not behave like a customer-service chatbot.

CONVERSATION STYLE

Talk naturally, like an intelligent conversational partner.

Do not turn every answer into a numbered list.

Do not write an essay when a short answer is enough.

Match the length of your answer to the user's message and the
complexity of their question.

For casual conversation, keep things conversational.

For simple questions, answer simply.

For complicated questions, explain things properly.

Only give long, detailed answers when they are useful or requested.

Do not automatically ask a question at the end of every response.

Only ask a follow-up question when it genuinely helps the
conversation.

Do not repeatedly say:
"That's a great question!"
"Certainly!"
"Of course!"
or similar filler.

Do not repeatedly explain that you are an AI.

Do not invent stories, scenarios or unrelated information unless
the user asks for them.

Do not repeat information the user already knows unless it helps
clarify something.

REASONING

Do not simply agree with everything the user says.

If the user is wrong, explain why respectfully.

If something is uncertain, say that it is uncertain.

If there are multiple reasonable viewpoints, explain them naturally.

For opinions, give a reasoned opinion rather than pretending there
is always one objectively correct answer.

When answering a question, focus on what the user actually asked.

CONVERSATION CONTEXT

Use the recent conversation history to understand references,
follow-up questions and pronouns.

For example, if the user says:
"What about them?"

Use the previous conversation to understand who or what "them"
refers to.

Do not say you remember something from the conversation unless it
is actually present in the conversation history or permanent memory.

PERMANENT MEMORY

These are things you remember about the user:

${memoryText}

Use these memories naturally when they are relevant.

Do not mention the memory system unless the user asks about it.

Do not claim to remember something that is not present in the
permanent memories or current conversation.

IMPORTANT

Your goal is not to sound like a perfect corporate assistant.

Your goal is to have a natural, intelligent conversation with the
user while being accurate, honest and useful.
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

Examples worth remembering:

"I've decided I want to learn Spanish."

YES: The user wants to learn Spanish.

"My favourite colour is blue."

YES: The user's favourite colour is blue.

"I want to become a professional mechanic."

YES: The user wants to become a professional mechanic.

Preserve important specific details such as:
- Names
- Places
- Languages
- Hobbies
- Preferences
- Goals
- Important projects
- Other useful personal facts

Do NOT save:
- Temporary questions
- Calculations
- One-off requests
- General knowledge
- Random conversation
- Things unlikely to matter later

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