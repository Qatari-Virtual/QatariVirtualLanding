/**
 * Cloudflare Pages Function: GET /api/announcements
 * Fetches the latest messages from the Discord #announcements channel live,
 * transforms them into Qatari Virtual blog posts, and caches at the edge for 60s.
 *
 * Required Environment Variables (in Cloudflare Pages Settings -> Environment variables):
 * - DISCORD_BOT_TOKEN: Bot token with View Channel + Read Message History + Message Content Intent
 * - DISCORD_CHANNEL_ID: ID of the #announcements channel
 * - DISCORD_GUILD_ID: ID of the Qatari Virtual Discord server (used to build jump links)
 */

function parseDiscordContent(rawContent, embedTitle) {
  const cleaned = (rawContent || "")
    .replace(/@everyone/g, "")
    .replace(/@here/g, "")
    .replace(/<@&\d+>/g, "")
    .replace(/<@!?\d+>/g, "@Pilot")
    .replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, "")
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

    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      title = headingMatch[1].replace(/\*\*/g, "").trim();
      bodyStartIndex = i + 1;
      break;
    }

    const boldMatch = line.match(/^\*\*(.+?)\*\*$/);
    if (boldMatch && boldMatch[1].length <= 120) {
      title = boldMatch[1].trim();
      bodyStartIndex = i + 1;
      break;
    }

    if (line.length <= 100) {
      title = line.replace(/\*\*/g, "").replace(/^[-•*]\s*/, "").trim();
      bodyStartIndex = i + 1;
    } else {
      title = embedTitle || line.replace(/\*\*/g, "").slice(0, 80).trim() + "...";
      bodyStartIndex = i;
    }
    break;
  }

  if (!title) {
    title = embedTitle || "Qatari Virtual Announcement";
  }

  const body = lines.slice(bodyStartIndex).join("\n").trim();
  return { title, body };
}

function transformDiscordMessage(msg, guildId, channelId) {
  const firstEmbedTitle = msg.embeds?.[0]?.title;
  const { title, body } = parseDiscordContent(msg.content || "", firstEmbedTitle);

  const images = [];
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

  const embeds = (msg.embeds || []).map((emb) => {
    const embImage = emb.image?.url || undefined;
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
        ? emb.fields.map((f) => ({
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
    ? msg.reactions.map((r) => ({
        emoji: r.emoji?.id
          ? `https://cdn.discordapp.com/emojis/${r.emoji.id}.png`
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

export async function onRequestGet(context) {
  const { env } = context;
  const botToken = env.DISCORD_BOT_TOKEN;
  const channelId = env.DISCORD_CHANNEL_ID;
  const guildId = env.DISCORD_GUILD_ID || "";

  if (!botToken || !channelId) {
    return new Response(
      JSON.stringify({
        configured: false,
        posts: [],
        message: "DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID not configured.",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?limit=25`,
      {
        headers: {
          Authorization: `Bot ${botToken}`,
          "User-Agent": "DiscordBot (https://qatarivirtual.xyz, 1.0)",
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          configured: false,
          posts: [],
          error: `Discord API status ${response.status}`,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const rawMessages = await response.json();
    const validMessages = (Array.isArray(rawMessages) ? rawMessages : []).filter(
      (m) =>
        (m.type === 0 || m.type === 19) &&
        (m.content?.trim() || m.embeds?.length > 0 || m.attachments?.length > 0)
    );

    const posts = validMessages.map((m) =>
      transformDiscordMessage(m, guildId, channelId)
    );

    return new Response(
      JSON.stringify({
        configured: true,
        posts,
        fetchedAt: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        configured: false,
        posts: [],
        error: err?.message || "Failed to fetch announcements",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
