
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

  const { task, prompt, images, reservationId, rating, sport } = body || {};
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const firebaseProject = "athlescan-auth";

  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Supabase is not configured in Netlify." }, 500);
  }

  if (!["status", "reserve", "analyze", "plan", "feedback"].includes(task)) {
    return json({ error: "Unknown task." }, 400);
  }

  // Google users use their verified Firebase UID. Guests receive a signed,
  // HttpOnly, same-site cookie; the cookie never contains a Supabase credential.
  const bearer = request.headers.get("authorization") || "";
  let userId, guestCookie = null;

  if (/^Bearer \S+$/i.test(bearer)) {
    try {
      const user = await verifyFirebaseToken(
        bearer.replace(/^Bearer /i, ""),
        firebaseProject
      );
      userId = "firebase:" + user.uid;
    } catch (e) {
      console.error("Firebase authentication failed:", e.message);
      return json({
        error: "Your Google sign-in is invalid or expired. Please sign in again."
      }, 401);
    }
  } else {
    // A cross-site POST must not mint or spend someone else's guest identity.
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).origin !== new URL(request.url).origin) {
      return json({ error: "Invalid request origin." }, 403);
    }

    const secret = serviceKey;
    const cookies = request.headers.get("cookie") || "";
    const match = cookies.match(/(?:^|;\s*)athlescan_guest=([^;]+)/);
    const existing = match
      ? await verifyGuestCookie(decodeURIComponent(match[1]), secret)
      : null;

    const guestId = existing || crypto.randomUUID();
    userId = "guest:" + guestId;

    if (!existing) {
      const value = await signGuestCookie(guestId, secret);
      guestCookie =
        "athlescan_guest=" + encodeURIComponent(value) +
        "; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax";
    }
  }

  const respond = (data, code = 200) => json(data, code, guestCookie);

  const serviceHeaders = {
    apikey: serviceKey,
    Authorization: "Bearer " + serviceKey,
    "Content-Type": "application/json"
  };

  if (task === "status" || task === "reserve") {
    try {
      const rpc = task === "status"
        ? "athlescan_v2_status"
        : "athlescan_v2_reserve";

      const r = await fetch(supabaseUrl + "/rest/v1/rpc/" + rpc, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ p_user_id: userId })
      });

      if (!r.ok) {
        throw Error(
          "Usage RPC failed: " +
          r.status + " " +
          (await r.text()).slice(0, 300)
        );
      }

      const data = await r.json();

      if (task === "status") {
        return respond({
          remaining: data.remaining,
          retryAt: data.retry_at
        });
      }

      if (!data.allowed) {
        return respond({
          error: "User limit reached. Try again at " +
            new Date(data.retry_at).toLocaleString() + ".",
          retryAt: data.retry_at,
          remaining: 0
        }, 429);
      }

      if (typeof data.reservation_id !== "string") {
        throw Error("Reservation ID missing from RPC");
      }

      return respond({
        reservationId: data.reservation_id,
        remaining: data.remaining
      });
    } catch (e) {
      console.error(e);
      return respond({
        error: "Could not " +
          (task === "status" ? "check" : "reserve") +
          " your analysis limit. Please try again."
      }, 502);
    }
  }

  if (task === "feedback") {
    if (
      !Number.isInteger(rating) ||
      rating < 0 ||
      rating > 5 ||
      typeof reservationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservationId)
    ) {
      return respond({
        error: "Invalid feedback rating or analysis reference."
      }, 400);
    }

    try {
      const r = await fetch(
        supabaseUrl + "/rest/v1/rpc/athlescan_submit_feedback",
        {
          method: "POST",
          headers: serviceHeaders,
          body: JSON.stringify({
            p_user_id: userId,
            p_reservation_id: reservationId,
            p_rating: rating,
            p_sport: typeof sport === "string"
              ? sport.slice(0, 100)
              : ""
          })
        }
      );

      if (!r.ok) {
        if (r.status === 409) {
          return respond({
            error: "Feedback has already been submitted for this analysis."
          }, 409);
        }

        throw Error(
          "Feedback RPC failed: " +
          r.status + " " +
          (await r.text()).slice(0, 300)
        );
      }

      if (await r.json() !== true) {
        return respond({
          error: "Feedback could not be accepted for this analysis."
        }, 403);
      }

      return respond({ saved: true });
    } catch (e) {
      console.error(e);
      return respond({
        error: "Could not save feedback. Please try again."
      }, 502);
    }
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    return respond({
      error: "The request is missing its prompt."
    }, 400);
  }

  if (task === "analyze") {
    if (
      typeof reservationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservationId)
    ) {
      return respond({
        error: "Start a new analysis to obtain a valid reservation."
      }, 403);
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return respond({
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
      return respond({
        error: "Each analysis request must contain 1–3 frames."
      }, 400);
    }

    for (const image of images) {
      if (
        typeof image !== "string" ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) ||
        image.length > 2_000_000
      ) {
        return respond({
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
        supabaseUrl + "/rest/v1/rpc/athlescan_v2_consume",
        {
          method: "POST",
          headers: serviceHeaders,
          body: JSON.stringify({
            p_reservation_id: reservationId,
            p_user_id: userId
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
        return respond({
          error: "This analysis reservation is expired or already used. Start a new analysis."
        }, 403);
      }
    } catch (e) {
      console.error(e);
      return respond({
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
            maxOutputTokens: task === "plan" ? 1800 : 3200,
            responseMimeType: "application/json"
          }
        })
      }
    );

    const result = await upstream.json();

    if (!upstream.ok) {
      console.error("Gemini API error:", result);

      if (upstream.status === 503) {
        return respond({
          error: "Server is currently experiencing high demand. Please try again later."
        }, 503);
      }

      return respond({
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
        result?.promptFeedback ||
        result?.candidates?.[0]?.finishReason
      );

      return respond({
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

      return respond({
        error: "The AI response could not be read. Please try again."
      }, 502);
    }

    return respond({ result: parsed }, 200);

  } catch (error) {
    console.error("Gemini request failed:", error);

    return respond({
      error: "Could not connect to Gemini. Please try again."
    }, 502);
  }
};

function json(data, statusCode = 200, cookie = null) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (cookie) {
    headers["Set-Cookie"] = cookie;
  }

  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers
  });
}

// Verify Firebase ID tokens locally using Google's published signing keys.
async function verifyFirebaseToken(token, projectId) {
  const pieces = token.split(".");

  if (pieces.length !== 3) {
    throw Error("Invalid JWT format");
  }

  const decode = (str) => JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(str.replace(/-/g, "+").replace(/_/g, "/")),
        c => c.charCodeAt(0)
      )
    )
  );

  const header = decode(pieces[0]);
  const claims = decode(pieces[1]);
  const now = Math.floor(Date.now() / 1000);

  if (
    header.alg !== "RS256" ||
    !header.kid ||
    claims.aud !== projectId ||
    claims.iss !== "https://securetoken.google.com/" + projectId ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.sub.length > 128 ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    !Number.isFinite(claims.auth_time) ||
    claims.auth_time > now + 60
  ) {
    throw Error("Invalid Firebase token claims");
  }

  const response = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  );

  if (!response.ok) {
    throw Error("Could not retrieve Firebase signing keys");
  }

  const { keys } = await response.json();
  const jwk = keys.find(
    k => k.kid === header.kid && k.kty === "RSA"
  );

  if (!jwk) {
    throw Error("Unknown Firebase signing key");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const fromBase64url = s => Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/")),
    c => c.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64url(pieces[2]),
    new TextEncoder().encode(pieces[0] + "." + pieces[1])
  );

  if (!valid) {
    throw Error("Invalid Firebase signature");
  }

  return {
    uid: claims.sub,
    email: claims.email || null
  };
}

// The signature prevents clients from choosing arbitrary guest IDs.
async function guestHmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(value)
    )
  );

  return Array.from(
    bytes,
    b => b.toString(16).padStart(2, "0")
  ).join("");
}

async function signGuestCookie(id, secret) {
  return id + "." + await guestHmac(id, secret);
}

async function verifyGuestCookie(value, secret) {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/i.exec(value);

  if (!m) return null;

  const expected = await guestHmac(m[1], secret);

  // Constant-time compare of two fixed-length hexadecimal signatures.
  let difference = 0;

  for (let i = 0; i < 64; i++) {
    difference |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
  }

  return difference === 0 ? m[1] : null;
}
