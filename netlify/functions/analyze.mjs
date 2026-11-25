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

  const {
    task,
    prompt,
    images,
    reservationId,
    rating,
    sport
  } = body || {};

  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const firebaseProject = "athlescan-auth";

  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Supabase is not configured in Netlify." }, 500);
  }

  const allowedTasks = [
    "status",
    "reserve",
    "analyze",
    "plan",
    "feedback",
    "cancel",
    "finalize",
    "history",
    "delete",
    "deleteAnalysis",
    "delete_analysis"
  ];

  if (!allowedTasks.includes(task)) {
    return json({ error: "Unknown task." }, 400);
  }

  const origin = request.headers.get("origin");

  try {
    if (origin && new URL(origin).origin !== new URL(request.url).origin) {
      return json({ error: "Invalid request origin." }, 403);
    }
  } catch {
    return json({ error: "Invalid request origin." }, 403);
  }

  const bearer = request.headers.get("authorization") || "";

  let userId;
  let guestCookie = null;

  if (bearer) {
    if (!/^Bearer \S+$/i.test(bearer)) {
      return json({ error: "Invalid authentication." }, 401);
    }

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
    const cookies = request.headers.get("cookie") || "";
    const match = cookies.match(/(?:^|;\s*)athlescan_guest=([^;]+)/);

    let existing = null;

    if (match) {
      try {
        existing = await verifyGuestCookie(
          decodeURIComponent(match[1]),
          serviceKey
        );
      } catch {
        existing = null;
      }
    }

    const guestId = existing || crypto.randomUUID();

    userId = "guest:" + guestId;

    if (!existing) {
      const value = await signGuestCookie(guestId, serviceKey);

      guestCookie =
        "athlescan_guest=" +
        encodeURIComponent(value) +
        "; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax";
    }
  }

  const respond = (data, code = 200) =>
    json(data, code, guestCookie);

  const serviceHeaders = {
    apikey: serviceKey,
    Authorization: "Bearer " + serviceKey,
    "Content-Type": "application/json"
  };

  const validReservationId = value =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

  const reservationArgs = {
    p_reservation_id: reservationId,
    p_user_id: userId
  };

  let claimedByThisRequest = false;
  let finalizationStarted = false;

  async function rpc(name, args, timeout = 5000) {
    const response = await fetch(
      supabaseUrl + "/rest/v1/rpc/" + name,
      {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeout)
      }
    );

    if (!response.ok) {
      throw new Error(
        name + " failed: " + response.status
      );
    }

    return await response.json();
  }

  async function updateReservation(name) {
    if (!validReservationId(reservationId)) {
      return false;
    }

    return (
      await rpc(name, reservationArgs)
    ) === true;
  }

  // Safe to retry because this function cannot cancel a
  // reservation that has already been claimed.

  async function cancelUnstartedReservation() {
    if (
      task !== "analyze" ||
      !validReservationId(reservationId)
    ) {
      return false;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await updateReservation(
          "athlescan_v2_cancel"
        );
      } catch (error) {
        console.error(
          "Reservation cancellation failed:",
          error.message
        );
      }
    }

    return false;
  }

  // Only the request that successfully claimed the
  // reservation may release it after processing fails.
  // Never release a reservation after an uncertain
  // finalization, since the database may have committed.

  async function releaseFailedAnalysis() {
    if (
      task !== "analyze" ||
      !claimedByThisRequest ||
      finalizationStarted ||
      !validReservationId(reservationId)
    ) {
      return false;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const released = await updateReservation(
          "athlescan_v2_fail"
        );

        if (released) {
          claimedByThisRequest = false;
        }

        return released;
      } catch (error) {
        console.error(
          "Reservation recovery failed:",
          error.message
        );
      }
    }

    return false;
  }

  async function loadSavedAnalysis() {
    if (!validReservationId(reservationId)) {
      return null;
    }

    const query = new URLSearchParams({
      user_id: "eq." + userId,
      reservation_id: "eq." + reservationId,
      select: "id,reservation_id,sport,action,score,summary,strengths,fixes,created_at",
      limit: "1"
    });

    const response = await fetch(
      supabaseUrl +
      "/rest/v1/athlescan_analysis_history?" +
      query,
      {
        headers: serviceHeaders,
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!response.ok) {
      throw new Error("History recovery failed");
    }

    const rows = await response.json();

    return Array.isArray(rows)
      ? rows[0] || null
      : null;
  }

  // ---------------------------------------
  // DASHBOARD HISTORY
  // ---------------------------------------

  if (task === "history") {
    try {
      const query = new URLSearchParams({
        user_id: "eq." + userId,
        select: "id,reservation_id,sport,action,score,summary,strengths,fixes,created_at",
        order: "created_at.desc",
        limit: "100"
      });

      const response = await fetch(
        supabaseUrl +
        "/rest/v1/athlescan_analysis_history?" +
        query,
        {
          headers: serviceHeaders,
          signal: AbortSignal.timeout(5000)
        }
      );

      if (!response.ok) {
        throw new Error(
          "History query failed: " + response.status
        );
      }

      return respond({
        analyses: await response.json()
      });
    } catch (error) {
      console.error(error);

      return respond({
        error: "Could not load analysis history. Please try again."
      }, 502);
    }
  }

  // ---------------------------------------
  // DELETE SAVED ANALYSIS
  // ---------------------------------------

  if (
    task === "delete" ||
    task === "deleteAnalysis" ||
    task === "delete_analysis"
  ) {
    if (!validReservationId(reservationId)) {
      return respond({
        error: "Invalid analysis reference."
      }, 400);
    }

    try {
      const deleted = await rpc(
        "athlescan_delete_analysis",
        reservationArgs
      );

      if (deleted !== true) {
        return respond({
          error: "This analysis was not found or has already been deleted."
        }, 404);
      }

      return respond({
        deleted: true,
        success: true
      });
    } catch (error) {
      console.error(
        "Analysis deletion failed:",
        error.message
      );

      return respond({
        error: "Could not confirm deletion. Refresh your dashboard before trying again."
      }, 502);
    }
  }

  // ---------------------------------------
  // USAGE STATUS AND RESERVATION
  // ---------------------------------------

  if (task === "status" || task === "reserve") {
    try {
      const name = task === "status"
        ? "athlescan_v2_status"
        : "athlescan_v2_reserve";

      const data = await rpc(
        name,
        { p_user_id: userId }
      );

      if (!data || typeof data !== "object") {
        throw new Error("Invalid usage response");
      }

      if (task === "status") {
        return respond({
          remaining: data.remaining,
          retryAt: data.retry_at
        });
      }

      if (!data.allowed) {
        const retryDate = new Date(data.retry_at);

        const retryMessage =
          data.retry_at &&
          Number.isFinite(retryDate.getTime())
            ? "User limit reached. Try again at " +
              retryDate.toLocaleString() + "."
            : "User limit reached. Please try again later.";

        return respond({
          error: retryMessage,
          retryAt: data.retry_at,
          remaining: 0
        }, 429);
      }

      if (!validReservationId(data.reservation_id)) {
        throw new Error(
          "Reservation ID missing or invalid"
        );
      }

      return respond({
        reservationId: data.reservation_id,
        remaining: data.remaining
      });
    } catch (error) {
      console.error(error);

      return respond({
        error: task === "status"
          ? "Could not check your analysis limit. Please try again."
          : "Could not confirm your reservation. Refresh your usage status before trying again."
      }, 502);
    }
  }

  // ---------------------------------------
  // FEEDBACK
  // ---------------------------------------

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
      const response = await fetch(
        supabaseUrl +
        "/rest/v1/rpc/athlescan_submit_feedback",
        {
          method: "POST",
          headers: serviceHeaders,
          signal: AbortSignal.timeout(5000),
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

      if (!response.ok) {
        if (response.status === 409) {
          return respond({
            error: "Feedback has already been submitted for this analysis."
          }, 409);
        }

        throw new Error(
          "Feedback RPC failed: " +
          response.status
        );
      }

      if (await response.json() !== true) {
        return respond({
          error: "Feedback could not be accepted for this analysis."
        }, 403);
      }

      return respond({ saved: true });
    } catch (error) {
      console.error(error);

      return respond({
        error: "Could not save feedback. Please try again."
      }, 502);
    }
  }

  // ---------------------------------------
  // LEGACY FINALIZATION PROTECTION
  // ---------------------------------------

  if (task === "finalize") {
    return respond({
      error: "Please refresh to use the updated analysis workflow."
    }, 409);
  }

  // ---------------------------------------
  // SAFE CLIENT CANCELLATION
  // ---------------------------------------

  if (task === "cancel") {
    if (!validReservationId(reservationId)) {
      return respond({
        error: "Invalid reservation."
      }, 400);
    }

    try {
      const released = await updateReservation(
        "athlescan_v2_cancel"
      );

      return respond({ released });
    } catch (error) {
      console.error(
        "Could not cancel reservation:",
        error.message
      );

      return respond({
        error: "Could not confirm reservation cancellation."
      }, 502);
    }
  }

  // ---------------------------------------
  // ANALYSIS REQUEST VALIDATION
  // ---------------------------------------

  if (
    task === "analyze" &&
    !validReservationId(reservationId)
  ) {
    return respond({
      error: "Start a new analysis to obtain a valid reservation."
    }, 403);
  }

  if (
    typeof prompt !== "string" ||
    !prompt.trim()
  ) {
    await cancelUnstartedReservation();

    return respond({
      error: "The request is missing its prompt."
    }, 400);
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    await cancelUnstartedReservation();

    return respond({
      error: "The AI service is not configured yet. Ask the site administrator to check GEMINI_API_KEY in Netlify."
    }, 500);
  }

  // ---------------------------------------
  // PRIORITY FIX INSTRUCTIONS
  // ---------------------------------------

  const parts = [{
    text: prompt.slice(0, 18000) + (
      task === "analyze"
        ? "\n\nPRIORITY FIX REQUIREMENTS:\n" +
          "- Examine all supplied frames before selecting fixes.\n" +
          "- Aim for 3–5 distinct priority fixes when supported by visual evidence.\n" +
          "- Examine setup, execution, control, and finish.\n" +
          "- Use an integer frame number between 1 and " +
          (Array.isArray(images) ? images.length : 0) + ".\n" +
          "- Use lowercase confidence values: high, medium, or low.\n" +
          "- Do not repeat the same correction in different words.\n" +
          "- Return fewer fixes only when the evidence genuinely supports fewer.\n" +
          "- Never invent technique problems."
        : ""
    )
  }];

  if (task === "analyze") {
    if (
      typeof sport !== "string" ||
      !sport.trim()
    ) {
      await cancelUnstartedReservation();

      return respond({
        error: "Select a sport."
      }, 400);
    }

    if (
      !Array.isArray(images) ||
      images.length < 1 ||
      images.length > 6
    ) {
      await cancelUnstartedReservation();

      return respond({
        error: "Each analysis request must contain 1–6 frames."
      }, 400);
    }

    // Every frame receives a unique sequential label,
    // even when two frames contain identical image data.

    for (const [frameIndex, image] of images.entries()) {
      if (
        typeof image !== "string" ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) ||
        image.length > 2_000_000
      ) {
        await cancelUnstartedReservation();

        return respond({
          error: "A video frame was invalid or too large. Try a shorter or smaller clip."
        }, 400);
      }

      parts.push({
        text: "Frame " + (frameIndex + 1) +
          " of " + images.length
      });

      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: image.slice(image.indexOf(",") + 1)
        }
      });
    }

    // Atomically claim the reservation.
    // Do not retry an uncertain claim because another
    // request may already be processing the same ID.

    try {
      claimedByThisRequest =
        await updateReservation(
          "athlescan_v2_claim"
        );

      if (!claimedByThisRequest) {
        let saved = null;

        try {
          saved = await loadSavedAnalysis();
        } catch (error) {
          console.error(error.message);
        }

        if (saved) {
          return respond({
            error: "This analysis has already been completed. View it in your dashboard.",
            completed: true,
            historySaved: true
          }, 409);
        }

        return respond({
          error: "This analysis is already processing, expired, or unavailable. Check your dashboard before starting another analysis."
        }, 409);
      }
    } catch (error) {
      console.error(
        "Reservation claim failed:",
        error.message
      );

      return respond({
        error: "Could not confirm your analysis reservation. Check your dashboard before retrying."
      }, 502);
    }
  }

  // ---------------------------------------
  // GEMINI ANALYSIS
  // ---------------------------------------

  try {
    const primary = "gemini-3.5-flash-lite";

    const fallback =
      process.env.GEMINI_FALLBACK_MODEL ||
      "gemini-3-flash-preview";

    const models = [
      primary,
      primary,
      fallback
    ];

    const deadline = Date.now() + 25000;

    let upstream;

    for (
      let attempt = 0;
      attempt < models.length;
      attempt++
    ) {
      const model = models[attempt];

      if (attempt > 0) {
        if (Date.now() + 3000 >= deadline) {
          break;
        }

        await new Promise(resolve =>
          setTimeout(
            resolve,
            attempt === 1 ? 2000 : 500
          )
        );
      }

      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        break;
      }

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
              contents: [{
                role: "user",
                parts
              }],
              generationConfig: {
                thinkingConfig: {
                  thinkingLevel: "LOW"
                },
                maxOutputTokens:
                  task === "plan" ? 1800 : 3200,
                responseMimeType:
                  "application/json"
              }
            })
          }
        );

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

        if (response.status !== 503) {
          break;
        }

        console.warn(
          "Gemini overload:",
          model,
          "attempt",
          attempt + 1
        );
      } catch (error) {
        if (!upstream) {
          throw error;
        }

        console.warn(
          "Gemini retry failed:",
          model,
          error.message
        );

        break;
      }
    }

    if (!upstream) {
      throw new Error(
        "Gemini request deadline exceeded"
      );
    }

    const result = await upstream.json()
      .catch(() => null);

    if (!upstream.ok) {
      await releaseFailedAnalysis();

      console.error(
        "Gemini API error status:",
        upstream.status
      );

      if (upstream.status === 503) {
        return respond({
          error: "Server is currently experiencing high demand. Please try again later."
        }, 503);
      }

      return respond({
        error: "Gemini returned an error. Please try again later or ask the site administrator to check the Netlify function logs."
      }, 502);
    }

    // Ignore non-text parts and internal thought parts.

    const text = result
      ?.candidates?.[0]?.content?.parts
      ?.map(part =>
        typeof part?.text === "string" && !part.thought
          ? part.text
          : ""
      )
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
        "Gemini response was not valid JSON."
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

    // ---------------------------------------
    // STANDARDIZED WEIGHTED SCORING
    // ---------------------------------------

    if (task === "analyze") {
      const weights = {
        setup: 20,
        execution: 40,
        control: 25,
        finish: 15
      };

      let total = 0;
      let weight = 0;

      for (
        const [key, w] of Object.entries(weights)
      ) {
        const value = parsed.rubric?.[key];

        if (
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 100
        ) {
          total += value * w;
          weight += w;
        }
      }

      if (
        !weight ||
        typeof parsed.action !== "string" ||
        !parsed.action.trim() ||
        typeof parsed.summary !== "string" ||
        !parsed.summary.trim()
      ) {
        await releaseFailedAnalysis();

        return respond({
          error: "Incomplete technique assessment. Try a clearer clip."
        }, 502);
      }

      parsed.score = Math.round(total / weight);

      // ---------------------------------------
      // PRIORITY FIX NORMALIZATION
      // ---------------------------------------

      const rawFixes = Array.isArray(parsed.fixes)
        ? parsed.fixes
        : [];

      parsed.fixes = rawFixes
        .filter(f =>
          f &&
          typeof f === "object" &&
          !Array.isArray(f)
        )
        .map(f => ({
          ...f,
          frame:
            typeof f.frame === "string" &&
            /^\d+$/.test(f.frame.trim())
              ? Number(f.frame.trim())
              : f.frame,
          confidence:
            typeof f.confidence === "string"
              ? f.confidence.trim().toLowerCase()
              : f.confidence
        }))
        .filter(f =>
          Number.isInteger(f.frame) &&
          f.frame >= 1 &&
          f.frame <= images.length &&
          ["high", "medium"].includes(f.confidence)
        )
        .slice(0, 5);

      console.info("Priority fix diagnostics:", {
        generated: rawFixes.length,
        accepted: parsed.fixes.length,
        discarded: rawFixes.length - parsed.fixes.length,
        availableFrames: images.length
      });

      // ---------------------------------------
      // ATOMIC FINALIZATION
      // ---------------------------------------

      const args = {
        p_reservation_id: reservationId,
        p_user_id: userId,
        p_sport: sport,
        p_result: parsed
      };

      finalizationStarted = true;

      let saved = false;

      // Finalization is idempotent in Supabase.
      // Retry transport failures using the same ID.
      // Never create a replacement reservation here.

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          saved = (
            await rpc(
              "athlescan_v2_finalize",
              args
            )
          ) === true;

          break;
        } catch (error) {
          console.error(
            "Finalize attempt failed:",
            attempt + 1,
            error.message
          );
        }
      }

      // Recover from a lost finalization response
      // by checking the owner's saved history.

      if (!saved) {
        try {
          const existing =
            await loadSavedAnalysis();

          saved = Boolean(existing);
        } catch (error) {
          console.error(
            "Finalization recovery failed:",
            error.message
          );
        }
      }

      if (!saved) {
        // Do not release an uncertain finalization.
        // The database may have already committed.

        return respond({
          error: "Could not confirm analysis storage. Check your dashboard before retrying."
        }, 502);
      }

      claimedByThisRequest = false;

      return respond({
        result: parsed,
        completed: true,
        historySaved: true
      });
    }

    // Practice plan response.
    // No additional analysis finalization.

    return respond({
      result: parsed
    }, 200);

  } catch (error) {
    console.error(
      "Gemini request failed:",
      error.message
    );

    await releaseFailedAnalysis();

    return respond({
      error: finalizationStarted
        ? "Could not confirm analysis storage. Check your dashboard before retrying."
        : "Could not connect to Gemini. Please try again."
    }, 502);
  }
};

// ---------------------------------------
// JSON RESPONSE HELPER
// ---------------------------------------

function json(
  data,
  statusCode = 200,
  cookie = null
) {
  const headers = {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (cookie) {
    headers["Set-Cookie"] = cookie;
  }

  return new Response(
    JSON.stringify(data),
    {
      status: statusCode,
      headers
    }
  );
}

// ---------------------------------------
// FIREBASE AUTHENTICATION
// ---------------------------------------

async function verifyFirebaseToken(
  token,
  projectId
) {
  const pieces = token.split(".");

  if (pieces.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  const fromBase64url = str =>
    Uint8Array.from(
      atob(
        str
          .replace(/-/g, "+")
          .replace(/_/g, "/")
      ),
      c => c.charCodeAt(0)
    );

  const decode = str =>
    JSON.parse(
      new TextDecoder().decode(
        fromBase64url(str)
      )
    );

  const header = decode(pieces[0]);
  const claims = decode(pieces[1]);

  const now = Math.floor(Date.now() / 1000);

  if (
    header.alg !== "RS256" ||
    !header.kid ||
    claims.aud !== projectId ||
    claims.iss !==
      "https://securetoken.google.com/" +
      projectId ||
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
    throw new Error(
      "Invalid Firebase token claims"
    );
  }

  const response = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    {
      signal: AbortSignal.timeout(5000)
    }
  );

  if (!response.ok) {
    throw new Error(
      "Could not retrieve Firebase signing keys"
    );
  }

  const { keys } = await response.json();

  if (!Array.isArray(keys)) {
    throw new Error(
      "Invalid Firebase signing keys"
    );
  }

  const jwk = keys.find(
    key =>
      key.kid === header.kid &&
      key.kty === "RSA"
  );

  if (!jwk) {
    throw new Error(
      "Unknown Firebase signing key"
    );
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

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64url(pieces[2]),
    new TextEncoder().encode(
      pieces[0] + "." + pieces[1]
    )
  );

  if (!valid) {
    throw new Error(
      "Invalid Firebase signature"
    );
  }

  return {
    uid: claims.sub,
    email: claims.email || null
  };
}

// ---------------------------------------
// SIGNED GUEST COOKIES
// ---------------------------------------

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
    byte =>
      byte.toString(16).padStart(2, "0")
  ).join("");
}

async function signGuestCookie(id, secret) {
  return id + "." + await guestHmac(
    id,
    secret
  );
}

async function verifyGuestCookie(
  value,
  secret
) {
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/i
      .exec(value);

  if (!match) {
    return null;
  }

  const expected = await guestHmac(
    match[1],
    secret
  );

  let difference = 0;

  for (let i = 0; i < 64; i++) {
    difference |=
      expected.charCodeAt(i) ^
      match[2].charCodeAt(i);
  }

  return difference === 0
    ? match[1]
    : null;
}
