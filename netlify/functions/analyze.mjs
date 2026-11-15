// Netlify Function: keeps the Google Gemini API key on the server.
export default async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Use POST for this endpoint." }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "The AI service is not configured yet. Ask the site administrator to add GEMINI_API_KEY in Netlify." }, 500);
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

  const parts = [{ text: prompt.slice(0, 18000) }];

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
      const data = image.slice(image.indexOf(",") + 1);
      parts.push({ inlineData: { mimeType: "image/jpeg", data } });
    }
  }

  try {
    const upstream = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: task === "plan" ? 2200 : 3000,
            responseMimeType: "application/json"
          }
        })
      }
    );

    const result = await upstream.json();
    if (!upstream.ok) {
      // Log provider details privately in Netlify, but do not expose them to site visitors.
      console.error("Gemini API error:", result);
      return json({ error: "Gemini returned an error. Please try again later or ask the site administrator to check the Netlify function logs." }, 502);
    }

    const text = result?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();
    if (!text) {
      console.error("Gemini returned no text:", result?.promptFeedback || result?.candidates?.[0]?.finishReason);
      return json({ error: "Gemini returned an empty response. Please try again." }, 502);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error("Gemini response was not valid JSON:", text.slice(0, 500));
      return json({ error: "The AI response could not be read. Please try again." }, 502);
    }

    return json({ result: parsed }, 200);
  } catch (error) {
    console.error("Gemini request failed:", error);
    return json({ error: "Could not connect to Gemini. Please try again." }, 502);
  }
};

function json(data, statusCode = 200) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
