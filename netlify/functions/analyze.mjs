// Netlify Function: keeps the Groq API key on the server.
export default async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Use POST for this endpoint." }, 405);
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return json({ error: "The AI service is not configured yet. Ask the site administrator to add the API key in Netlify." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The request was not valid JSON." }, 400);
  }

  const { task, prompt, images } = body || {};
  if (!["analyze", "plan"].includes(task) || typeof prompt !== "string" || !prompt.trim()) {
    return json({ error: "The request is missing its task or prompt." }, 400);
  }

  const content = [{ type: "text", text: prompt.slice(0, 18000) }];

  if (task === "analyze") {
    if (!Array.isArray(images) || images.length < 1 || images.length > 3) {
      return json({ error: "Each analysis request must contain 1–3 frames." }, 400);
    }
    for (const image of images) {
      if (typeof image !== "string" ||
          !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) ||
          image.length > 2_000_000) {
        return json({ error: "A video frame was invalid or too large. Try a shorter or smaller clip." }, 400);
      }
      content.push({ type: "image_url", image_url: { url: image } });
    }
  }

  try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen/qwen3.8-27b",
        messages: [{ role: "user", content }],
        temperature: 0.2,
        max_completion_tokens: task === "plan" ? 2200 : 3000,
        response_format: { type: "json_object" }
      })
    });

    const result = await upstream.json();
    if (!upstream.ok) {
      console.error("Groq API error:", result);
      return json({ error: "The AI provider returned an error. Please try again later." }, 502);
    }

    const text = result?.choices?.[0]?.message?.content;
    if (!text) return json({ error: "The AI provider returned an empty response. Please try again." }, 502);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "The AI response could not be read. Please try again." }, 502);
    }

    return json({ result: parsed }, 200);
  } catch (error) {
    console.error("AI request failed:", error);
    return json({ error: "Could not connect to the AI provider. Please try again." }, 502);
  }
};

function json(data, statusCode = 200) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
