/**
 * The stack bumpwarden publishes about itself. The About page prints these, the agent calls the
 * model named here, and the deploy instructions target this region, so the page cannot advertise a
 * model or a region that nothing uses.
 */

/** GA, on the free tier, and the smallest model that reads a changelog well. */
export const BRIEF_MODEL = 'gemini-3.5-flash';

/**
 * What the free tier allows in one minute on that model, read verbatim off a live refusal on
 * 2026-08-22: "Quota exceeded for metric:
 * generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model:
 * gemini-3.5-flash". Google's rate-limit page no longer prints a per-model table, so the refusal
 * itself and the operator's AI Studio dashboard are the only two places this number exists. A paid
 * key raises it, and pacing to a lower number than the key allows costs only time. The same
 * metric also refuses with "limit: 20", which an earlier reading took for a second minute limit:
 * it is the day's allowance below, and it fires with the minute empty.
 */
export const FREE_TIER_REQUESTS_PER_MINUTE = 5;

/**
 * What the free tier allowed in one day on that model, counted rather than read: on 2026-08-22 the
 * key answered exactly twenty requests between the day's reset (midnight in California) and the
 * first "limit: 20" refusal, then refused every request for the rest of the day, and the evening
 * before it did the same. A brief costs two requests, so a free key explains ten bumps a day; a run
 * over the seven-bump demo spends fourteen, and a repeat run over unchanged bumps spends none
 * because a ready brief is cached.
 */
export const FREE_TIER_REQUESTS_PER_DAY = 20;

/**
 * How many briefs a run asks the model for at once. A brief depends on nothing but its own
 * material, so there is no reason to wait for one answer before asking the next question. The
 * ceiling is the minute: five requests, two to a brief, so two briefs fill a minute's allowance
 * and a third would only stand in the pacer's queue. Measured before this was chosen: four at once
 * opened eight requests inside two seconds, and the API refused three of them on the spot.
 */
export const BRIEFS_IN_FLIGHT = 2;

/** ADK for TypeScript requires 24.13 or newer, so the container and the repo both pin the major. */
export const NODE_MAJOR = '24';

/** EU region, because the operator and the data both sit in the EU. */
export const CLOUD_REGION = 'europe-west1';

export const REPOSITORY_URL = 'https://github.com/voyagi/bumpwarden';
