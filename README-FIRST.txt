ATHLESCAN AI — NETLIFY PROJECT

This is the updated AthleScan project. It keeps the existing website design and adds a secure server-side AI connection.

PROJECT FILES
- public/index.html — the website
- netlify/functions/analyze.mjs — server-side AI function
- netlify.toml — Netlify configuration

IMPORTANT ACCOUNT NOTE
Gemini's current Services Agreement says Cloud Services users must be 18 or older. A parent/guardian must be the actual Groq account holder and manage the account, API key, and service. They should review the agreement and take responsibility for any service use. Do not put the key in the website code or share it in chat.

DEPLOYMENT NOTE
This project includes a Netlify Function, so do not deploy only public/index.html using the simple static-file upload. Deploy the whole project using a Git-connected Netlify deploy or the Netlify CLI. Netlify's official docs explain both methods.

AFTER DEPLOY
The adult account holder should add an environment variable in Netlify:
Name: GEMIN_API_KEY
Value: the API key they create and manage

Then trigger a new deploy. The key must remain in Netlify's environment-variable settings, never in public/index.html.

MODEL
The function uses Gemini's qwen/qwen3.8-27b vision model. It sends up to 3 frames per request; the site analyzes 6 frames in two requests. Practice-plan generation is text-only.

LIMITS / PRIVACY
Free usage, if offered to the account, is quota-limited and not unlimited. The published website is publicly reachable unless access controls are added. Anyone may be able to submit requests and use the AI quota. Before sharing it with the community, the adult administrator should review the provider's current limits and privacy/data terms, monitor usage, and consider access/rate controls. Upload videos only with the athlete's and, where appropriate, their parent/guardian's permission.
