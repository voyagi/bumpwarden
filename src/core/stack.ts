/**
 * The stack bumpwarden publishes about itself. The About page prints these, the agent calls the
 * model named here, and the deploy instructions target this region, so the page cannot advertise a
 * model or a region that nothing uses.
 */

/** GA, on the free tier, and the smallest model that reads a changelog well. */
export const BRIEF_MODEL = 'gemini-3.5-flash';

/** ADK for TypeScript requires 24.13 or newer, so the container and the repo both pin the major. */
export const NODE_MAJOR = '24';

/** EU region, because the operator and the data both sit in the EU. */
export const CLOUD_REGION = 'europe-west1';

export const REPOSITORY_URL = 'https://github.com/voyagi/bumpwarden';
