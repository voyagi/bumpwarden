/**
 * The stack bumpwarden publishes about itself. The About page prints these, the agent calls the
 * model named here, and the deploy instructions target this region, so the page cannot advertise a
 * model or a region that nothing uses.
 */

/** GA, on the free tier, and the smallest model that reads a changelog well. */
export const BRIEF_MODEL = 'gemini-3.5-flash';

/**
 * What the free tier allows in one minute on that model, read verbatim off a live refusal:
 * "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
 * limit: 20, model: gemini-3.5-flash". Google's rate-limit page no longer prints a per-model table,
 * so the refusal itself and the operator's AI Studio dashboard are the only two places this number
 * exists. A paid key raises it, and pacing to a lower number than the key allows costs only time.
 */
export const FREE_TIER_REQUESTS_PER_MINUTE = 20;

/** ADK for TypeScript requires 24.13 or newer, so the container and the repo both pin the major. */
export const NODE_MAJOR = '24';

/** EU region, because the operator and the data both sit in the EU. */
export const CLOUD_REGION = 'europe-west1';

export const REPOSITORY_URL = 'https://github.com/voyagi/bumpwarden';
