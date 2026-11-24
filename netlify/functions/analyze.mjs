
  try {
    // Retry overload responses while preserving the reservation.
    const primary = "gemini-3.5-flash-lite";
    const fallback = process.env.GEMINI_FALLBACK_MODEL || "gemini-3-flash-preview";
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

        if (upstream) await upstream.body?.cancel();

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
