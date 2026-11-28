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

  const { task, prompt, images, frameTimes, reservationId, rating, sport, result } = body || {};
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const firebaseProject = "athlescan-auth";

  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Supabase is not configured in Netlify." }, 500);
  }

  if (!["status", "reserve", "analyze", "plan", "feedback", "cancel", "finalize", "history", "delete"].includes(task)) {
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

  if (task === "delete") {
    if (!validReservationId(reservationId)) {
      return respond({ error: "Invalid analysis reference." }, 400);
    }
    try {
      const deleted = await rpc("athlescan_delete_analysis", {
        p_reservation_id: reservationId,
        p_user_id: userId
      });
      if (deleted !== true) {
        return respond({ error: "Analysis not found." }, 404);
      }
      return respond({ deleted: true });
    } catch (error) {
      console.error("Analysis deletion failed:", error.message);
      return respond({ error: "Could not delete analysis. Refresh your dashboard and try again." }, 502);
    }
  }

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

  const reservationArgs = {
    p_reservation_id: reservationId,
    p_user_id: userId
  };

  let claimed = false;
  let finalizationStarted = false;

  async function updateReservation(name) {
    return (await rpc(name, reservationArgs)) === true;
  }

  async function releaseFailedAnalysis() {
    if (
      task !== "analyze" ||
      !validReservationId(reservationId) ||
      finalizationStarted
    ) return;

    const name = claimed
      ? "athlescan_v2_fail"
      : "athlescan_v2_cancel";

    for (let i = 0; i < 2; i++) {
      try {
        await updateReservation(name);
        return;
      } catch (error) {
        console.warn(
          "Reservation cleanup failed:",
          error.message
        );
      }
    }
  }

  async function historyExists() {
    try {
      const query = new URLSearchParams({
        user_id: "eq." + userId,
        reservation_id: "eq." + reservationId,
        select: "id",
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

      return response.ok &&
        (await response.json()).length > 0;

    } catch (error) {
      console.warn(
        "History recovery failed:",
        error.message
      );

      return false;
    }
  }

  async function rpc(name, args) {
    const response = await fetch(supabaseUrl + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: serviceHeaders,
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw Error(name + " failed: " + response.status);
    }

    return await response.json();
  }

  if (task === "finalize") {
    return respond({
      error: "Please refresh to use the updated analysis workflow."
    }, 409);
  }

  if (task === "cancel") {
    if (!validReservationId(reservationId)) {
      return respond({
        error: "Invalid reservation."
      }, 400);
    }

    try {
      const released = await updateReservation("athlescan_v2_cancel");

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
      images.length > 12
    ) {
      await releaseFailedAnalysis();

      return respond({
        error: "Each analysis request must contain 1–12 frames."
      }, 400);
    }

    if (!Array.isArray(frameTimes) || frameTimes.length !== images.length ||
        !frameTimes.every((t, i) => typeof t === "string" && /^\d+\.\d{2}$/.test(t) && Number.isFinite(Number(t)) && (i === 0 || Number(t) >= Number(frameTimes[i-1])))) {
      await releaseFailedAnalysis();
      return respond({ error: "Invalid frame timestamps. Refresh and try again." }, 400);
    }

    for (const [i, image] of images.entries()) {
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

      parts.push({ text: `Frame ${i + 1} at ${frameTimes[i]} seconds` });
      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data
        }
      });
    }
  }

  if (task === "analyze") {
    if (typeof sport !== "string" || !sport.trim()) {
      await releaseFailedAnalysis();

      return respond({
        error: "Select a sport."
      }, 400);
    }

    try {
      if (await updateReservation("athlescan_v2_claim") !== true) {
        return respond({
          error: "Analysis already started or expired. Refresh and try again."
        }, 409);
      }

      claimed = true;

    } catch (e) {
      console.error(e);
      await releaseFailedAnalysis();

      return respond({
        error: "Could not verify analysis reservation."
      }, 502);
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
                  thinkingLevel: task === "analyze" ? "MEDIUM" : "LOW"
                },
                maxOutputTokens: task === "plan" ? 1800 : 3200,
                responseMimeType: "application/json",
...(task === "analyze" ? {
  responseSchema: {
    type: "OBJECT",
    required: [
      "instrument", "action", "summary", "score",
      "rubric", "strengths", "phases", "fixes"
    ],
    properties: {
      instrument: { type: "STRING" },
      action: { type: "STRING" },
      summary: { type: "STRING" },
      score: { type: "NUMBER" },
      rubric: {
        type: "OBJECT",
        required: ["setup", "execution", "control", "finish"],
        properties: {
          setup: { type: "NUMBER" },
          execution: { type: "NUMBER" },
          control: { type: "NUMBER" },
          finish: { type: "NUMBER" }
        }
      },
      strengths: {
        type: "ARRAY",
        items: { type: "STRING" }
      },
      phases: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          required: [
            "frame", "phase", "observation", "confidence"
          ],
          properties: {
            frame: { type: "INTEGER" },
            phase: { type: "STRING" },
            observation: { type: "STRING" },
            confidence: { type: "STRING" }
          }
        }
      },
      fixes: {
        type: "ARRAY",
        maxItems: 5,
        items: {
          type: "OBJECT",
          required: [
            "frame", "timestamp", "evidence",
            "visibility", "x", "y", "area",
            "issue", "criterion", "fix", "drill",
            "severity", "confidence"
          ],
          properties: {
            frame: { type: "INTEGER" },
            timestamp: { type: "STRING" },
            evidence: { type: "STRING" },
            visibility: { type: "STRING" },
            x: {
              type: "NUMBER",
              nullable: true,
              minimum: 0,
              maximum: 1
            },
            y: {
              type: "NUMBER",
              nullable: true,
              minimum: 0,
              maximum: 1
            },
            area: { type: "STRING" },
            issue: { type: "STRING" },
            criterion: { type: "STRING" },
            fix: { type: "STRING" },
            drill: { type: "STRING" },
            severity: { type: "STRING" },
            confidence: { type: "STRING" }
          }
        }
      }
    }
  }
} : {})
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

    if (task === "analyze") {
      const weights = {
        setup: 20,
        execution: 40,
        control: 25,
        finish: 15
      };

      let total = 0;
      let weight = 0;

      for (const [key, w] of Object.entries(weights)) {
        const v = parsed.rubric?.[key];

        if (
          typeof v === "number" &&
          Number.isFinite(v) &&
          v >= 0 &&
          v <= 100
        ) {
          total += v * w;
          weight += w;
        }
      }

      if (
        !weight ||
        typeof parsed.action !== "string" ||
        typeof parsed.summary !== "string"
      ) {
        await releaseFailedAnalysis();

        return respond({
          error: "Incomplete technique assessment. Try a clearer clip."
        }, 502);
      }

      parsed.score = Math.round(total / weight);

      const rawFixes = Array.isArray(parsed.fixes) ? parsed.fixes : [];
      for (const f of rawFixes) {
  if (!f || typeof f !== "object") continue;

  const validX =
    Number.isFinite(f.x) && f.x >= 0 && f.x <= 1;

  const validY =
    Number.isFinite(f.y) && f.y >= 0 && f.y <= 1;

  if (!validX || !validY) {
    console.warn("[AthleScan incomplete coordinate pair]", {
      frame: f.frame,
      validX,
      validY
    });

    f.x = null;
    f.y = null;
  }
}
      const fixDiagnostics = [];
      const coordinateStatus = (value) => {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value !== "number") return "invalid_type";
  if (!Number.isFinite(value)) return "non_finite";
  if (value < 0 || value > 1) return "out_of_range";
  return "valid";
};

console.info("[AthleScan circle audit]", JSON.stringify(
  rawFixes.map((f, index) => ({
    fix: index + 1,
    frame: f?.frame,
    area: f?.area,
    confidence: f?.confidence,
    x: f?.x,
    y: f?.y,
    xStatus: coordinateStatus(f?.x),
    yStatus: coordinateStatus(f?.y),
    renderable:
      coordinateStatus(f?.x) === "valid" &&
      coordinateStatus(f?.y) === "valid"
  }))
));
      parsed.fixes = (
        Array.isArray(parsed.fixes)
          ? parsed.fixes
          : []
      ).filter((f, index) => {
        const reasons = [];
        if (!f || !Number.isInteger(f.frame) || f.frame < 1 || f.frame > images.length) reasons.push("invalid_frame");
        if (!["high", "medium"].includes(f?.confidence)) reasons.push("confidence");
        if (f?.visibility !== "clear") reasons.push("visibility");
        if (typeof f?.evidence !== "string" || !f.evidence.trim()) reasons.push("missing_evidence");
        if (!f || !["string", "number"].includes(typeof f.timestamp) || !String(f.timestamp).trim() || Number(f.timestamp) !== Number(frameTimes[f.frame - 1])) reasons.push("timestamp_mismatch");
        if (reasons.length) fixDiagnostics.push({ index: index + 1, reasons });
        return (
        f &&
        Number.isInteger(f.frame) &&
        f.frame >= 1 &&
        f.frame <= images.length &&
        ["high", "medium"].includes(f.confidence) &&
        f.visibility === "clear" &&
        typeof f.evidence === "string" && f.evidence.trim().length > 0 &&
        (typeof f.timestamp === "string" || typeof f.timestamp === "number") &&
        String(f.timestamp).trim() !== "" &&
        Number(f.timestamp) === Number(frameTimes[f.frame - 1])
        );
      }).slice(0, 5);
      console.info("[AthleScan fix audit]", JSON.stringify({
        generated: rawFixes.length,
        accepted: parsed.fixes.length,
        rejected: fixDiagnostics,
        capped: Math.max(0, rawFixes.length - fixDiagnostics.length - 5)
      }));

      const args = {
        p_reservation_id: reservationId,
        p_user_id: userId,
        p_sport: sport,
        p_result: parsed
      };

      finalizationStarted = true;
      let saved = false;

      for (let i = 0; i < 2; i++) {
        try {
          saved = await rpc("athlescan_v2_finalize", args);
          break;
        } catch (e) {
          console.error("Finalize attempt", e.message);
        }
      }

      if (saved !== true) {
        saved = await historyExists();
      }

      if (saved !== true) {
        return respond({
          error: "Could not confirm analysis storage. Check your dashboard before retrying."
        }, 502);
      }

      return respond({
        result: parsed,
        completed: true,
        historySaved: true
      });
    }

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
