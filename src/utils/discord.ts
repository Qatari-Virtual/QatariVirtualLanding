import fs from "node:fs";
import path from "node:path";

export interface DiscordBlogPost {
  id: string;
  title: string;
  body: string;
  author: {
    name: string;
    avatar: string;
    role?: string;
  };
  timestamp: string;
  editedTimestamp: string | null;
  images: string[];
  embeds: {
    title?: string;
    description?: string;
    url?: string;
    color?: string;
    image?: string;
    thumbnail?: string;
    fields?: { name: string; value: string; inline?: boolean }[];
  }[];
  reactions: {
    emoji: string;
    count: number;
  }[];
  discordUrl: string;
  pinned: boolean;
}

/**
 * Reads an environment variable from import.meta.env, process.env, or directly from .env
 * so adding variables to .env works immediately without restarting `npm run dev`.
 */
function getEnvVar(key: string): string {
  const fromMeta = (import.meta.env as Record<string, string | undefined>)?.[key];
  if (fromMeta) return fromMeta.trim();

  const fromProc = process.env?.[key];
  if (fromProc) return fromProc.trim();

  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const k = trimmed.slice(0, eqIdx).trim();
          const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
          if (k === key) return v;
        }
      }
    }
  } catch {
    // Ignore fs errors in restricted environments
  }

  return "";
}

/**
 * Extracts a clean blog title and remaining body from raw Discord message content.
 */
export function parseDiscordContent(
  rawContent: string,
  embedTitle?: string,
  mentions?: any[]
): { title: string; body: string } {
  const mentionMap = new Map<string, string>();
  if (Array.isArray(mentions)) {
    for (const u of mentions) {
      if (u?.id) {
        mentionMap.set(String(u.id), u.global_name || u.username || "Pilot");
      }
    }
  }

  let cleaned = (rawContent || "")
    // Remove @everyone and @here
    .replace(/@everyone/g, "")
    .replace(/@here/g, "")
    // Clean role mentions <@&123456>
    .replace(/<@&\d+>/g, "")
    // Replace user mentions <@123456> or <@!123456> with actual display name if available
    .replace(/<@!?(\d+)>/g, (_, id) => `@${mentionMap.get(String(id)) || "Pilot"}`)
    // Convert custom Discord emojis <:name:id> or <a:name:id>
    .replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, "")
    // Convert Discord timestamps <t:1234567890:F> to readable text
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, unix) => {
      try {
        return new Date(Number(unix) * 1000).toUTCString();
      } catch {
        return "";
      }
    })
    .trim();

  if (!cleaned && embedTitle) {
    return { title: embedTitle, body: "" };
  }

  const lines = cleaned.split(/\r?\n/);
  let title = "";
  let bodyStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check for markdown headings (# Title, ## Title, ### Title)
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      title = headingMatch[1].replace(/\*\*/g, "").trim();
      bodyStartIndex = i + 1;
      break;
    }

    // Check for bold full-line title (**Title**)
    const boldMatch = line.match(/^\*\*(.+?)\*\*$/);
    if (boldMatch && boldMatch[1].length <= 120) {
      title = boldMatch[1].trim();
      bodyStartIndex = i + 1;
      break;
    }

    // First non-empty line fallback if reasonably short
    if (line.length <= 100) {
      title = line.replace(/\*\*/g, "").replace(/^[-•*]\s*/, "").trim();
      bodyStartIndex = i + 1;
    } else {
      title =
        embedTitle ||
        line.replace(/\*\*/g, "").slice(0, 80).trim() + "...";
      bodyStartIndex = i;
    }
    break;
  }

  if (!title) {
    title = embedTitle || "Qatari Virtual Update";
  }

  const body = lines.slice(bodyStartIndex).join("\n").trim();
  return { title, body };
}

/**
 * Transforms a raw Discord API message object into a DiscordBlogPost.
 */
export function transformDiscordMessage(
  msg: any,
  guildId: string,
  channelId: string
): DiscordBlogPost {
  const firstEmbedTitle = msg.embeds?.[0]?.title;
  const { title, body } = parseDiscordContent(
    msg.content || "",
    firstEmbedTitle,
    msg.mentions
  );

  const images: string[] = [];

  if (Array.isArray(msg.attachments)) {
    for (const att of msg.attachments) {
      const isImage =
        att.content_type?.startsWith("image/") ||
        /\.(png|jpe?g|webp|gif)(\?|$)/i.test(att.url || "");
      if (isImage && att.url) {
        images.push(att.url);
      }
    }
  }

  const embeds = (msg.embeds || []).map((emb: any) => {
    const embImage =
      emb.image?.url ||
      (emb.type === "gifv" || emb.type === "image" ? emb.thumbnail?.url : undefined);
    if (embImage && !images.includes(embImage)) {
      images.push(embImage);
    }
    return {
      title: emb.title,
      description: emb.description,
      url: emb.url,
      color: emb.color
        ? `#${Number(emb.color).toString(16).padStart(6, "0")}`
        : "#8B1538",
      image: embImage,
      thumbnail: emb.thumbnail?.url,
      fields: Array.isArray(emb.fields)
        ? emb.fields.map((f: any) => ({
            name: f.name,
            value: f.value,
            inline: f.inline,
          }))
        : [],
    };
  });

  const avatarHash = msg.author?.avatar;
  const authorId = msg.author?.id;
  const avatarUrl =
    avatarHash && authorId
      ? `https://cdn.discordapp.com/avatars/${authorId}/${avatarHash}.png?size=128`
      : "/images/Logo2.png";

  const reactions = Array.isArray(msg.reactions)
    ? msg.reactions.map((r: any) => ({
        emoji: r.emoji?.id
          ? `https://cdn.discordapp.com/emojis/${r.emoji.id}.${r.emoji.animated ? "gif" : "png"}`
          : r.emoji?.name || "❤️",
        count: r.count || 1,
      }))
    : [];

  const discordUrl =
    guildId && channelId
      ? `https://discord.com/channels/${guildId}/${channelId}/${msg.id}`
      : `https://discord.com/channels/@me/${channelId || ""}/${msg.id}`;

  return {
    id: msg.id,
    title,
    body,
    author: {
      name: msg.author?.global_name || msg.author?.username || "Qatari Virtual Staff",
      avatar: avatarUrl,
      role: "Staff Announcement",
    },
    timestamp: msg.timestamp,
    editedTimestamp: msg.edited_timestamp || null,
    images,
    embeds,
    reactions,
    discordUrl,
    pinned: Boolean(msg.pinned),
  };
}

async function fetchDiscordChannelFeed(
  channelEnvKey: string,
  fallbackPosts: DiscordBlogPost[],
  limit = 25
): Promise<{
  posts: DiscordBlogPost[];
  configured: boolean;
  error?: string;
}> {
  const botToken = getEnvVar("DISCORD_BOT_TOKEN");
  const channelId = getEnvVar(channelEnvKey);
  const guildId = getEnvVar("DISCORD_GUILD_ID");

  if (!botToken || !channelId) {
    return {
      posts: fallbackPosts,
      configured: false,
    };
  }

  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,
      {
        headers: {
          Authorization: `Bot ${botToken}`,
          "User-Agent": "DiscordBot (https://qatarivirtual.xyz, 1.0)",
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Discord API error (${response.status}) for ${channelEnvKey}:`, errText);
      return {
        posts: fallbackPosts,
        configured: false,
        error: `Discord API returned status ${response.status}`,
      };
    }

    const rawMessages = await response.json();
    if (!Array.isArray(rawMessages)) {
      return { posts: fallbackPosts, configured: false };
    }

    const validMessages = rawMessages.filter(
      (m: any) =>
        (m.type === 0 || m.type === 19) &&
        (m.content?.trim() || m.embeds?.length > 0 || m.attachments?.length > 0)
    );

    const posts = validMessages.map((m: any) =>
      transformDiscordMessage(m, guildId, channelId)
    );

    return {
      posts,
      configured: true,
    };
  } catch (err: any) {
    console.error(`Failed to fetch Discord channel (${channelEnvKey}):`, err);
    return {
      posts: fallbackPosts,
      configured: false,
      error: err?.message || "Unknown error",
    };
  }
}

export async function fetchDiscordAnnouncements(limit = 25) {
  return fetchDiscordChannelFeed("DISCORD_CHANNEL_ID", SAMPLE_ANNOUNCEMENTS, limit);
}

export async function fetchDiscordRouteNews(limit = 25) {
  return fetchDiscordChannelFeed("DISCORD_ROUTE_NEWS_CHANNEL_ID", SAMPLE_ROUTE_NEWS, limit);
}

export const SAMPLE_ROUTE_NEWS: DiscordBlogPost[] = [
  {
    id: "route-sample-1",
    title: "New Seasonal & Codeshare Routes Added to the Database",
    body: "Our Operations Team has updated the **Qatari Virtual Route Database** with new seasonal frequencies out of **Hamad International Airport (OTHH)** alongside expanded codeshare connections across Europe, Asia, and the Americas.\n\nExplore all updated flight numbers, aircraft assignments, and flight times on the **Route Database** and **Route Map** pages!",
    author: {
      name: "Qatari Virtual Operations Team",
      avatar: "/images/Logo2.png",
      role: "Route Operations",
    },
    timestamp: "2026-10-30T16:00:00.000Z",
    editedTimestamp: null,
    images: [],
    embeds: [],
    reactions: [
      { emoji: "🛫", count: 31 },
      { emoji: "🌍", count: 24 },
    ],
    discordUrl: "https://discord.com/app",
    pinned: true,
  },
];

export const SAMPLE_ANNOUNCEMENTS: DiscordBlogPost[] = [
  {
    id: "sample-1",
    title: "Infinite Flight LIVE Operations & Fleet Expansion",
    body: "As Qatari Virtual continues to grow in the **Infinite Flight LIVE** environment, we are thrilled to welcome our newest batch of pilots to the Doha hub!\n\nMake sure to check out the updated **Route Map** and **Tours** pages for our latest continental legs, and join our weekly group flights posted in the events channel.",
    author: {
      name: "Qatari Virtual Executive Team",
      avatar: "/images/Logo2.png",
      role: "Official Announcement",
    },
    timestamp: "2026-10-28T18:00:00.000Z",
    editedTimestamp: null,
    images: ["/images/About-Hero.png"],
    embeds: [],
    reactions: [
      { emoji: "🇶🇦", count: 42 },
      { emoji: "✈️", count: 35 },
      { emoji: "🔥", count: 29 },
    ],
    discordUrl: "https://discord.com/app",
    pinned: true,
  },
];
