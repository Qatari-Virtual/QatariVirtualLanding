/**
 * Cloudflare Pages Function: GET /api/route-news
 * Fetches the latest messages from the Discord Route News channel live,
 * transforms them into Qatari Virtual Route News posts, and caches at the edge for 60s.
 *
 * Required Environment Variables (in Cloudflare Pages Settings -> Environment variables):
 * - DISCORD_BOT_TOKEN: Bot token with View Channel + Read Message History + Message Content Intent
 * - DISCORD_ROUTE_NEWS_CHANNEL_ID: ID of the Route News channel in Discord
 * - DISCORD_GUILD_ID: ID of the Qatari Virtual Discord server
 */

import { onRequestGet as announcementsHandler } from "./announcements.js";

export async function onRequestGet(context) {
  const { env } = context;
  // Delegate to the shared announcements handler with DISCORD_ROUTE_NEWS_CHANNEL_ID mapped to DISCORD_CHANNEL_ID
  const routeNewsContext = {
    ...context,
    env: {
      ...env,
      DISCORD_CHANNEL_ID: env.DISCORD_ROUTE_NEWS_CHANNEL_ID,
    },
  };
  return announcementsHandler(routeNewsContext);
}
