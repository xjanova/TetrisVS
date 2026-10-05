/**
 * The XMAN GAMES HUB build (`vite build --mode hub`) is a static page with no
 * game server behind it. Everything that needs one — Quick Match, private
 * rooms, accounts, the leaderboard, the server status poll — is switched off
 * there and shown as "coming soon" instead of failing requests at a host that
 * does not exist. Solo, versus the AI, and local 2P run entirely in the tab and
 * are unaffected.
 *
 * Vite replaces `import.meta.env.MODE` with a string literal at build time, so
 * in the hub build this is the constant `false` and the online UI is dropped
 * from the bundle rather than merely hidden.
 */
export const ONLINE_ENABLED = import.meta.env.MODE !== 'hub';
