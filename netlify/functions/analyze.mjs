
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

  const { task, prompt, images, reservationId, rating, sport, result } = body || {};
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const firebaseProject = "athlescan-auth";

  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Supabase is not configured in Netlify." }, 500);
  }

  if (!["status", "reserve", "analyze", "plan", "feedback", "cancel", "finalize", "history"].includes(task)) {
    return json({ error: "Unknown task." }, 400);
  }

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

  const validReservationId = (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

  // Dashboard history is stored per authenticated account or signed guest cookie.
  if (task === "history") {
    try {
      const url = supabaseUrl + "/rest/v1/athlescan_analysis_history?" +
        new URLSearchParams({
          user_id: "eq." + userId,
          select: "id,reservation_id,sport,action,score,summary,strengths,fixes,created_at",
          order: "created_at.desc",
          limit: "100"
        });

      const r = await fetch(url, { headers: serviceHeaders });

      if (!r.ok) {
        throw Error(
          "History query failed: " +
          r.status + " " +
          (await r.text()).slice(0, 300)
        );
      }

      return respond({ analyses: await r.json() });

    } catch (error) {
      console.error(error);
      return respond({
        error: "Could not load analysis history. Make sure the dashboard SQL has been installed."
      }, 502);
    }
  }

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
      rating < 1 ||
      rating > 5 ||
      !validReservationId(reservationId)
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

  async function updateReservation(rpc) {
    const response = await fetch(supabaseUrl + "/rest/v1/rpc/" + rpc, {
      method: "POST",
      headers: serviceHeaders,
      body: JSON.stringify({
        p_reservation_id: reservationId,
        p_user_id: userId
      })
    });

    if (!response.ok) {
      throw Error(
        rpc + " failed: " + response.status + " " +
        (await response.text()).slice(0, 300)
      );
    }

    return (await response.json()) === true;
  }

  // Only cancel a reservation when the frontend explicitly cancels the
  // complete analysis. Individual Gemini requests must not release it,
  // because one video analysis makes multiple requests with the same ID.
  async function releaseFailedAnalysis() {
    return;
  }

  if (task === "finalize") {
    if (
      !validReservationId(reservationId) ||
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !Number.isFinite(result.score) ||
      result.score < 0 ||
      result.score > 100 ||
      typeof sport !== "string" ||
      !sport.trim() ||
      JSON.stringify(result).length > 25000
    ) {
      return respond({
        error: "Invalid completed analysis."
      }, 400);
    }

    try {
      const completed = await updateReservation("athlescan_v2_consume");

      if (!completed) {
        // An already-consumed reservation may indicate a retried finalize
        // request. Check for an existing history record before rejecting it.
        const existingUrl =
          supabaseUrl + "/rest/v1/athlescan_analysis_history?" +
          new URLSearchParams({
            user_id: "eq." + userId,
            reservation_id: "eq." + reservationId,
            select: "id",
            limit: "1"
          });

        const existingResponse = await fetch(existingUrl, {
          headers: serviceHeaders
        });

        if (existingResponse.ok) {
          const existingRows = await existingResponse.json();

          if (Array.isArray(existingRows) && existingRows.length > 0) {
            return respond({
              completed: true,
              historySaved: true,
              alreadyFinalized: true
            });
          }
        }

        return respond({
          error: "This analysis reservation is expired or already used. Start a new analysis."
        }, 403);
      }

      // The analysis is already completed. A history storage problem must not undo it.
      let historySaved = false;

      try {
        const entry = {
          user_id: userId,
          reservation_id: reservationId,
          sport: sport.slice(0, 100),
          action: String(result.action || "").slice(0, 200),
          score: Math.round(result.score),
          summary: String(result.summary || "").slice(0, 2500),
          strengths: Array.isArray(result.strengths)
            ? result.strengths.slice(0, 8)
            : [],
          fixes: Array.isArray(result.fixes)
            ? result.fixes.slice(0, 8)
            : []
        };

        const saved = await fetch(
          supabaseUrl + "/rest/v1/athlescan_analysis_history",
          {
            method: "POST",
            headers: {
              ...serviceHeaders,
              Prefer: "return=minimal"
            },
            body: JSON.stringify(entry)
          }
        );

        if (!saved.ok) {
          throw Error(
            "History insert failed: " +
            saved.status + " " +
            (await saved.text()).slice(0, 300)
          );
        }

        historySaved = true;

      } catch (error) {
        console.error("Completed analysis history not saved:", error);
      }

      return respond({
        completed: true,
        historySaved
      });

    } catch (error) {
      console.error("Could not finalize analysis:", error);

      return respond({
        error: "Could not finalize your analysis. Please try again."
      }, 502);
    }
  }

  if (task === "cancel") {
    if (!validReservationId(reservationId)) {
      return respond({
        error: "Invalid reservation."
      }, 400);
    }

    try {
      const released = await updateReservation("athlescan_v2_fail");

      if (!released) {
        console.warn(
          "Reservation cancellation returned false; reservation may already be closed."
        );
      }

      return respond({ released });

    } catch (error) {
      console.error("Could not cancel reservation:", error);

      return respond({
        error: "Could not cancel reservation."
      }, 502);
    }
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    if (task === "analyze" && typeof reservationId === "string") {
      await releaseFailedAnalysis();
    }

    return respond({
      error: "The request is missing its prompt."
    }, 400);
  }

  if (task === "analyze" && !validReservationId(reservationId)) {
    return respond({
      error: "Start a new analysis to obtain a valid reservation."
    }, 403);
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    await releaseFailedAnalysis();

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
      await releaseFailedAnalysis();

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
        await releaseFailedAnalysis();

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

  try {
    // Retry only overload responses; preserve the same analysis reservation.
    const primary = "gemini-3.5-flash-lite";

    const fallback =
      process.env.GEMINI_FALLBACK_MODEL ||
      "gemini-3-flash-preview";

    const models = [primary, primary, fallback];
    const deadline = Date.now() + 25000;

    let upstream;

    for (let attempt = 0; attempt < models.length; attempt++) {
      const model = models[attempt];

      if (attempt > 0) {
        if (Date.now() + 3000 >= deadline) break;

        await new Promise(resolve =>
          setTimeout(resolve, attempt === 1 ? 2000 : 500)
        );
      }

      const remaining = deadline - Date.now();

      if (remaining <= 0) break;

      try {
        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) +
          ":generateContent",
          {
            method: "POST",
            signal: AbortSignal.timeout(remaining),
            headers: {
              "x-goog-api-key": apiKey,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts
                }
              ],
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

        // Preserve the original overload error if the fallback is unavailable
        // or not enabled for this API key.
        if (
          attempt === 2 &&
          !response.ok &&
          upstream?.status === 503
        ) {
          console.warn(
            "Gemini fallback failed:",
            model,
            response.status
          );

          await response.body?.cancel();
          break;
        }

        if (upstream) {
          await upstream.body?.cancel();
        }

        upstream = response;

        if (response.status !== 503) break;

        console.warn(
          "Gemini overload:",
          model,
          "attempt",
          attempt + 1
        );

      } catch (error) {
        if (!upstream) throw error;

        console.warn(
          "Gemini retry failed:",
          model,
          error.message
        );

        break;
      }
    }

    if (!upstream) {
      throw Error("Gemini request deadline exceeded");
    }

    const result = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      await releaseFailedAnalysis();

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
      await releaseFailedAnalysis();

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
      await releaseFailedAnalysis();

      console.error(
        "Gemini response was not valid JSON:",
        text.slice(0, 500)
      );

      return respond({
        error: "The AI response could not be read. Please try again."
      }, 502);
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length === 0
    ) {
      await releaseFailedAnalysis();

      return respond({
        error: "Gemini returned an incomplete analysis. Please try again."
      }, 502);
    }

    // Do not consume the reservation here: one video uses two Gemini calls.
    // The frontend finalizes only after both halves return successfully.

    return respond({
      result: parsed
    }, 200);

  } catch (error) {
    console.error("Gemini request failed:", error);

    await releaseFailedAnalysis();

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
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
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

async function guestHmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
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

  let difference = 0;

  for (let i = 0; i < 64; i++) {
    difference |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
  }

  return difference === 0 ? m[1] : null;
}
