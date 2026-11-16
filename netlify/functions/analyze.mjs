// Netlify Function: keeps the Google Gemini API key on the server.
export default async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Use POST for this endpoint." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The request was not valid JSON." }, 400);
  }

  const { task, prompt, images, reservationId } = body || {};
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const firebaseProject = "kalkin-experiments";
  if (!supabaseUrl || !serviceKey) return json({ error: "Supabase is not configured in Netlify." }, 500);
  if (!["status", "reserve", "analyze", "plan"].includes(task)) return json({ error: "Unknown task." }, 400);
  const bearer = request.headers.get("authorization") || "";
  if (!/^Bearer \S+$/i.test(bearer)) return json({ error: "Please sign in with Google first." }, 401);
  let user;
  try { user = await verifyFirebaseToken(bearer.replace(/^Bearer /i, ""), firebaseProject); }
  catch (e) { console.error("Firebase authentication failed:", e.message); return json({ error: "Your Google sign-in is invalid or expired. Please sign in again." }, 401); }
  const serviceHeaders = {
    apikey: serviceKey,
    Authorization: "Bearer " + serviceKey,
    "Content-Type": "application/json"
  };

  if (task === "status") {
    try {
      const since = new Date(Date.now() - 86400000).toISOString();

      const url =
        supabaseUrl +
        "/rest/v1/firebase_analysis_usage?firebase_uid=eq." +
        encodeURIComponent(user.uid) +
        "&created_at=gt." +
        encodeURIComponent(since) +
        "&select=created_at&order=created_at.asc&limit=8";

      const r = await fetch(url, { headers: serviceHeaders });

      if (!r.ok) {
        throw Error("Usage lookup failed: " + r.status);
      }

      const rows = await r.json();
      const remaining = Math.max(0, 8 - rows.length);

      return json({
        remaining,
        retryAt: remaining === 0
          ? new Date(Date.parse(rows[0].created_at) + 86400000).toISOString()
          : null
      });
    } catch (e) {
      console.error(e);
      return json({
        error: "Could not check your analysis limit."
      }, 502);
    }
  }

  if (task === "reserve") {
    try {
      const r = await fetch(
        supabaseUrl + "/rest/v1/rpc/reserve_firebase_analysis_use",
        {
          method: "POST",
          headers: serviceHeaders,
          body: JSON.stringify({ p_firebase_uid: user.uid })
        }
      );

      if (!r.ok) {
        throw Error(
          "Reservation failed: " +
          r.status + " " +
          (await r.text()).slice(0, 300)
        );
      }

      const data = await r.json();

      if (!data.allowed) {
        return json({
          error: "User limit reached. Try again at " +
            new Date(data.retry_at).toLocaleString() + ".",
          retryAt: data.retry_at,
          remaining: 0
        }, 429);
      }

      return json({
        reservationId: data.reservation_id,
        remaining: data.remaining
      });
    } catch (e) {
      console.error(e);
      return json({
        error: "Could not reserve an analysis. Please try again."
      }, 502);
    }
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    return json({
      error: "The request is missing its prompt."
    }, 400);
  }

  if (task === "analyze") {
    if (
      typeof reservationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservationId)
    ) {
      return json({
        error: "Start a new analysis to obtain a valid reservation."
      }, 403);
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return json({
      error: "The AI service is not configured yet. Ask the site administrator to add GEMINI_API_KEY in Netlify."
    }, 500);
  }

  const parts = [{ text: prompt.slice(0, 18000) }];

  if (task === "analyze") {
    if (
      !Array.isArray(images) ||
      images.length < 1 ||
      images.length > 3
    ) {
      return json({
        error: "Each analysis request must contain 1–3 frames."
      }, 400);
    }

    for (const image of images) {
      if (
        typeof image !== "string" ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) ||
        image.length > 2_000_000
      ) {
        return json({
          error: "A video frame was invalid or too large. Try a shorter or smaller clip."
        }, 400);
      }

      const data = image.slice(image.indexOf(",") + 1);

      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data
        }
      });
    }
  }

  if (task === "analyze") {
    // Atomically consume one of two frame batches.
    try {
      const r = await fetch(
        supabaseUrl + "/rest/v1/rpc/consume_firebase_analysis_request",
        {
          method: "POST",
          headers: serviceHeaders,
          body: JSON.stringify({
            p_reservation_id: reservationId,
            p_firebase_uid: user.uid
          })
        }
      );

      if (!r.ok) {
        throw Error(
          "Consumption failed: " +
          r.status + " " +
          (await r.text()).slice(0, 300)
        );
      }

      if (await r.json() !== true) {
        return json({
          error: "This analysis reservation is expired or already used. Start a new analysis."
        }, 403);
      }
    } catch (e) {
      console.error(e);
      return json({
        error: "Could not validate your analysis reservation."
      }, 502);
    }
  }

  try {
    const upstream = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            thinkingConfig: {
              thinkingLevel: "LOW"
            },
            maxOutputTokens: task === "plan" ? 1800 : 2000,
            responseMimeType: "application/json"
          }
        })
      }
    );

    const result = await upstream.json();

    if (!upstream.ok) {
      console.error("Gemini API error:", result);

      if (upstream.status === 503) {
        return json({
          error: "Server is currently experiencing high demand. Please try again later."
        }, 503);
      }

      return json({
        error: "Gemini returned an error. Please try again later or ask the site administrator to check the Netlify function logs."
      }, 502);
    }

    const text = result?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!text) {
      console.error(
        "Gemini returned no text:",
        result?.promptFeedback || result?.candidates?.[0]?.finishReason
      );

      return json({
        error: "Gemini returned an empty response. Please try again."
      }, 502);
    }

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      console.error(
        "Gemini response was not valid JSON:",
        text.slice(0, 500)
      );

      return json({
        error: "The AI response could not be read. Please try again."
      }, 502);
    }

    return json({ result: parsed }, 200);

  } catch (error) {
    console.error("Gemini request failed:", error);

    return json({
      error: "Could not connect to Gemini. Please try again."
    }, 502);
  }
};

function json(data, statusCode = 200) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

// Verify Firebase ID tokens locally using Google's published signing keys.
// The Firebase web API key is not a signing key and must not be trusted for verification.
async function verifyFirebaseToken(token, projectId) {
  const pieces = token.split(".");
  if (pieces.length !== 3) throw Error("Invalid JWT format");
  const decode = (str) => JSON.parse(new TextDecoder().decode(
    Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))));
  const header = decode(pieces[0]);
  const claims = decode(pieces[1]);
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || !header.kid || claims.aud !== projectId ||
      claims.iss !== "https://securetoken.google.com/" + projectId ||
      typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128 ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      !Number.isFinite(claims.iat) || claims.iat > now + 60 ||
      !Number.isFinite(claims.auth_time) || claims.auth_time > now + 60) {
    throw Error("Invalid Firebase token claims");
  }
  const response = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  if (!response.ok) throw Error("Could not retrieve Firebase signing keys");
  const { keys } = await response.json();
  const jwk = keys.find(k => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) throw Error("Unknown Firebase signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const fromBase64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(pieces[2]), new TextEncoder().encode(pieces[0] + "." + pieces[1]));
  if (!valid) throw Error("Invalid Firebase signature");
  return { uid: claims.sub, email: claims.email || null };
}
