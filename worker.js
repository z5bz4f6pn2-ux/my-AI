export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const { message } = await request.json();

        if (!message) {
          return new Response("Missing message", { status: 400 });
        }

        const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          prompt: message
        });

        return Response.json(result);
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
