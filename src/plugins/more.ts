/**
 * Additional built-in plugins: cosmetic CSS tweaks and small DOM helpers.
 * Everything degrades gracefully — unmatched selectors or missing Discord
 * modules simply mean the plugin does nothing.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { cssPlugin } from "./extras";
import { el, observeAdded, toast } from "./dom-utils";
import { findStoreByName } from "./mods";

const log = Logger.get("more");

// ---------------------------------------------------------------------------
// CSS plugins
// ---------------------------------------------------------------------------

const HideNitro = cssPlugin(
    "HideNitro",
    "Hide Nitro, Shop and gift buttons in the UI.",
    `
    /* HideNitro */
    [class*="nitro"],
    [class*="shop"],
    [class*="gift"] {
        display: none !important;
    }
    `,
);

const SquareAvatars = cssPlugin(
    "SquareAvatars",
    "Square avatars instead of circles.",
    `
    /* SquareAvatars */
    [class*="avatar"] {
        border-radius: 0 !important;
    }
    `,
);

const BiggerAvatars = cssPlugin(
    "BiggerAvatars",
    "Slightly larger avatars in messages and member list.",
    `
    /* BiggerAvatars */
    [id^="chat-messages"] [class*="avatar"],
    [class*="member"] [class*="avatar"] {
        transform: scale(1.15);
    }
    `,
);

const ThinMessages = cssPlugin(
    "ThinMessages",
    "Tighter vertical spacing between messages.",
    `
    /* ThinMessages */
    [id^="chat-messages"] li {
        padding-top: 2px !important;
        padding-bottom: 2px !important;
    }
    `,
);

const BiggerReactions = cssPlugin(
    "BiggerReactions",
    "Larger reaction pills under messages.",
    `
    /* BiggerReactions */
    [class*="reactions"] [class*="reaction"],
    [class*="reaction"] {
        transform: scale(1.15);
    }
    `,
);

const NoReactions = cssPlugin(
    "NoReactions",
    "Hide the reaction bar under messages.",
    `
    /* NoReactions */
    [class*="reactions"],
    [class*="reactionBar"],
    [class*="addReaction"] {
        display: none !important;
    }
    `,
);

const NoChannelTopic = cssPlugin(
    "NoChannelTopic",
    "Hide the channel topic bar in the header.",
    `
    /* NoChannelTopic */
    [class*="topic"] {
        display: none !important;
    }
    `,
);

const HideMemberList = cssPlugin(
    "HideMemberList",
    "Hide the right-hand member list column.",
    `
    /* HideMemberList */
    [class*="memberList"],
    [class*="members"] {
        display: none !important;
    }
    `,
);

const CompactGuilds = cssPlugin(
    "CompactGuilds",
    "Smaller server icons with tighter spacing.",
    `
    /* CompactGuilds */
    [class*="guilds"] [class*="avatar"],
    [class*="guilds"] [class*="icon"] {
        width: 40px !important;
        height: 40px !important;
    }
    [class*="guilds"] {
        gap: 4px !important;
    }
    `,
);

const BiggerServerIcons = cssPlugin(
    "BiggerServerIcons",
    "Larger server icons in the left sidebar.",
    `
    /* BiggerServerIcons */
    [class*="guilds"] [class*="avatar"],
    [class*="guilds"] [class*="icon"] {
        width: 52px !important;
        height: 52px !important;
    }
    `,
);

const NoBoostBar = cssPlugin(
    "NoBoostBar",
    "Hide the server boost progress bar.",
    `
    /* NoBoostBar */
    [class*="boostBar"],
    [class*="boostProgress"],
    [class*="premiumProgress"] {
        display: none !important;
    }
    `,
);

const NoServerDiscover = cssPlugin(
    "NoServerDiscover",
    "Hide the Server Discovery button.",
    `
    /* NoServerDiscover */
    [class*="discover"] {
        display: none !important;
    }
    `,
);

const BiggerEmoji = cssPlugin(
    "BiggerEmoji",
    "Larger custom emoji in messages.",
    `
    /* BiggerEmoji */
    [id^="chat-messages"] [class*="emoji"],
    [id^="chat-messages"] img[src*="emoji"] {
        transform: scale(1.3);
    }
    `,
);

const HideSystemMessages = cssPlugin(
    "HideSystemMessages",
    "Hide join/leave and other system messages in chat.",
    `
    /* HideSystemMessages */
    [id^="chat-messages"] [class*="systemMessage"],
    [id^="chat-messages"] [class*="messageSystem"] {
        display: none !important;
    }
    `,
);

const SmallText = cssPlugin(
    "SmallText",
    "Slightly smaller UI text.",
    `
    /* SmallText */
    :root {
        font-size: 14px;
    }
    `,
);

const BiggerInput = cssPlugin(
    "BiggerInput",
    "Larger message input font.",
    `
    /* BiggerInput */
    [class*="channelTextArea"] textarea,
    [class*="slateTextArea"] {
        font-size: 16px !important;
    }
    `,
);

const NoChannelIcons = cssPlugin(
    "NoChannelIcons",
    "Hide the voice/stage icons next to channel names.",
    `
    /* NoChannelIcons */
    [class*="channel"] [class*="icon"] {
        display: none !important;
    }
    `,
);

const FlatScrollbars = cssPlugin(
    "FlatScrollbars",
    "Square, minimal scrollbars.",
    `
    /* FlatScrollbars */
    ::-webkit-scrollbar-thumb {
        border-radius: 0 !important;
    }
    `,
);

const NoGifHover = cssPlugin(
    "NoGifHover",
    "Disable the GIF hover preview enlargement.",
    `
    /* NoGifHover */
    [class*="gif"] img,
    [class*="tenor"] img {
        transform: none !important;
    }
    `,
);

const CompactMembers = cssPlugin(
    "CompactMembers",
    "Tighter member list rows — more members visible at once.",
    `
    /* CompactMembers */
    [class*="member"] [class*="container"],
    [class*="members"] [class*="item"] {
        padding-top: 2px !important;
        padding-bottom: 2px !important;
    }
    `,
);

const ThinGuilds = cssPlugin(
    "ThinGuilds",
    "Tighter spacing in the server and channel lists.",
    `
    /* ThinGuilds */
    [class*="guilds"] {
        padding-top: 4px !important;
        padding-bottom: 4px !important;
    }
    [class*="channels"] [class*="container"],
    [class*="channels"] [class*="channel"] {
        padding-top: 2px !important;
        padding-bottom: 2px !important;
    }
    `,
);

const WiderChat = cssPlugin(
    "WiderChat",
    "Let messages use more of the window width.",
    `
    /* WiderChat */
    [class*="chat"] [class*="content"],
    [id^="chat-messages"] {
        max-width: none !important;
    }
    `,
);

const ChatInputHeight = cssPlugin(
    "ChatInputHeight",
    "Taller message input box.",
    `
    /* ChatInputHeight */
    [class*="channelTextArea"],
    [class*="slateTextArea"] {
        min-height: 44px !important;
    }
    `,
);

const MemberListOpacity = cssPlugin(
    "MemberListOpacity",
    "Fade the member list until hovered.",
    `
    /* MemberListOpacity */
    [class*="memberList"],
    [class*="members"] {
        opacity: 0.55;
        transition: opacity .15s;
    }
    [class*="memberList"]:hover,
    [class*="members"]:hover {
        opacity: 1;
    }
    `,
);

const NoChannelFade = cssPlugin(
    "NoChannelFade",
    "Remove the fade gradient at the bottom of the chat.",
    `
    /* NoChannelFade */
    [class*="scroller"]::after,
    [class*="chat"]::after {
        display: none !important;
    }
    `,
);

const BiggerServerHeader = cssPlugin(
    "BiggerServerHeader",
    "Larger channel header text.",
    `
    /* BiggerServerHeader */
    [class*="header"] [class*="title"],
    [class*="guildHeader"] {
        font-size: 17px !important;
    }
    `,
);

const NoImageHover = cssPlugin(
    "NoImageHover",
    "Disable Discord's native image hover preview.",
    `
    /* NoImageHover */
    [class*="imageContent"] img,
    [class*="embedMedia"] img {
        pointer-events: none;
    }
    `,
);

const GuildIconBorder = cssPlugin(
    "GuildIconBorder",
    "Add a subtle border around server icons.",
    `
    /* GuildIconBorder */
    [class*="guilds"] [class*="avatar"],
    [class*="guilds"] [class*="icon"] {
        border: 2px solid var(--background-accent, #383a40) !important;
    }
    `,
);

const NoUnreadBadge = cssPlugin(
    "NoUnreadBadge",
    "Hide unread mention count badges.",
    `
    /* NoUnreadBadge */
    [class*="badge"],
    [class*="unreadBadge"] {
        display: none !important;
    }
    `,
);

const FlatAvatars = cssPlugin(
    "FlatAvatars",
    "Remove avatar hover lift and shadow.",
    `
    /* FlatAvatars */
    [class*="avatar"] {
        box-shadow: none !important;
    }
    [class*="avatar"]:hover {
        transform: none !important;
    }
    `,
);

const NoAvatars = cssPlugin(
    "NoAvatars",
    "Hide avatars in messages, DMs and the member list.",
    `
    /* NoAvatars */
    [id^="chat-messages"] [class*="avatar"],
    [class*="member"] [class*="avatar"],
    [class*="privateChannels"] [class*="avatar"],
    [class*="chat"] [class*="avatar"] {
        display: none !important;
    }
    `,
);

const CompactAvatars = cssPlugin(
    "CompactAvatars",
    "Smaller avatars in messages and the member list.",
    `
    /* CompactAvatars */
    [id^="chat-messages"] [class*="avatar"],
    [class*="member"] [class*="avatar"],
    [class*="privateChannels"] [class*="avatar"] {
        transform: scale(0.8);
    }
    `,
);

const NoMemberAvatars = cssPlugin(
    "NoMemberAvatars",
    "Hide avatars in the member list only.",
    `
    /* NoMemberAvatars */
    [class*="member"] [class*="avatar"],
    [class*="members"] [class*="avatar"] {
        display: none !important;
    }
    `,
);

const NoEmbedColor = cssPlugin(
    "NoEmbedColor",
    "Hide the colored accent bar on link embeds.",
    `
    /* NoEmbedColor */
    [class*="embed"] [class*="accent"],
    [class*="embed"] > [class*="accent"] {
        display: none !important;
    }
    `,
);

const CompactReactions = cssPlugin(
    "CompactReactions",
    "Smaller reaction pills under messages.",
    `
    /* CompactReactions */
    [class*="reaction"] {
        transform: scale(0.85);
    }
    `,
);

const NoUnreadHighlight = cssPlugin(
    "NoUnreadHighlight",
    "Remove the highlight on channels with unread messages.",
    `
    /* NoUnreadHighlight */
    [class*="channel"][class*="unread"],
    [class*="guilds"] [class*="unread"] {
        background: transparent !important;
    }
    `,
);

const NoRoleColors = cssPlugin(
    "NoRoleColors",
    "Normalize member name colors in the member list and chat.",
    `
    /* NoRoleColors */
    [class*="member"] [class*="name"],
    [id^="chat-messages"] [class*="username"] {
        color: var(--text-normal, #dbdee1) !important;
    }
    `,
);

const NoServerTag = cssPlugin(
    "NoServerTag",
    "Hide server/clan tags in the UI.",
    `
    /* NoServerTag */
    [class*="clanTag"],
    [class*="serverTag"],
    [class*="guildTag"] {
        display: none !important;
    }
    `,
);

const NoEmbedFooter = cssPlugin(
    "NoEmbedFooter",
    "Hide embed footers (timestamps, site names).",
    `
    /* NoEmbedFooter */
    [class*="embed"] [class*="footer"],
    [class*="embed"] [class*="embedFooter"] {
        display: none !important;
    }
    `,
);

const HugeAvatars = cssPlugin(
    "HugeAvatars",
    "Much larger avatars in messages and the member list.",
    `
    /* HugeAvatars */
    [id^="chat-messages"] [class*="avatar"],
    [class*="member"] [class*="avatar"] {
        transform: scale(1.4);
    }
    `,
);

const BiggerServerList = cssPlugin(
    "BiggerServerList",
    "Larger channel names in the server sidebar.",
    `
    /* BiggerServerList */
    [class*="channel"] [class*="name"],
    [class*="channels"] [class*="name"] {
        font-size: 15px !important;
    }
    `,
);

const NoNitroBadge = cssPlugin(
    "NoNitroBadge",
    "Hide remaining Nitro badges and promo surfaces.",
    `
    /* NoNitroBadge */
    [class*="badge"][class*="nitro"],
    [class*="premium"],
    [class*="nitroBadge"] {
        display: none !important;
    }
    `,
);

const CompactRoles = cssPlugin(
    "CompactRoles",
    "Tighter spacing on role groups in the member list.",
    `
    /* CompactRoles */
    [class*="roleName"],
    [class*="member"] [class*="group"] {
        padding-top: 2px !important;
        padding-bottom: 2px !important;
    }
    `,
);

const HideStageChannel = cssPlugin(
    "HideStageChannel",
    "Hide Stage channels from the channel list.",
    `
    /* HideStageChannel */
    [data-list-item-id^="channels"]:has([class*="stage"]),
    [class*="channel"]:has([class*="stage"]) {
        display: none !important;
    }
    `,
);

// ---------------------------------------------------------------------------
// Functional plugins
// ---------------------------------------------------------------------------

/**
 * CopyIds — Ctrl+Alt+C copies the ID of whatever is under the mouse:
 * channel rows expose `data-list-item-id="channels___<id>"`, guild rows
 * `guildsnav___<id>`, and messages carry `id="chat-messages-<channel>-<msg>"`.
 */
function copyIdsPlugin(): Plugin {
    let offs: (() => void)[] = [];
    return {
        name: "CopyIds",
        description: "Ctrl+Alt+C copies the channel/guild/message ID under the cursor.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            // Track the last hovered candidate — keydown has no pointer coords.
            let hovered: Element | null = null;
            const track = (ev: MouseEvent) => {
                const t = ev.target;
                hovered =
                    t instanceof Element
                        ? t.closest(
                              '[data-list-item-id], [id^="chat-messages"], [class*="guilds"] [class*="avatar"]',
                          )
                        : null;
            };
            document.addEventListener("mousemove", track, { passive: true });
            offs.push(() => document.removeEventListener("mousemove", track));

            const copy = (text: string, label: string) => {
                void navigator.clipboard?.writeText(text).then(
                    () => toast(`Copied ${label}: ${text}`),
                    () => toast(`Copy failed — ${text}`),
                );
            };

            const handler = (ev: KeyboardEvent) => {
                if (
                    !(ev.ctrlKey && ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "c")
                ) {
                    return;
                }
                if (!hovered) {
                    toast("Hover a channel, server or message first");
                    return;
                }
                const listId = hovered.getAttribute("data-list-item-id");
                if (listId) {
                    const id = listId.split("___").pop();
                    if (id) {
                        ev.preventDefault();
                        copy(id, "ID");
                        return;
                    }
                }
                const msgId = hovered.id;
                if (msgId.startsWith("chat-messages-")) {
                    ev.preventDefault();
                    copy(msgId.slice("chat-messages-".length), "message ref");
                    return;
                }
                const guildIcon = hovered.closest(
                    '[class*="guilds"] [class*="avatar"], [class*="guilds"] [class*="icon"]',
                );
                if (guildIcon) {
                    const wrapper = guildIcon.closest("[data-list-item-id]");
                    const id = wrapper
                        ?.getAttribute("data-list-item-id")
                        ?.split("___")
                        .pop();
                    if (id) {
                        ev.preventDefault();
                        copy(id, "server ID");
                    }
                }
            };
            document.addEventListener("keydown", handler);
            offs.push(() => document.removeEventListener("keydown", handler));
        },

        stop() {
            for (const off of offs) off();
            offs = [];
        },
    };
}

/**
 * FriendsOnline — shows the number of online friends next to the
 * "Direct Messages" header in the DM sidebar.
 */
function friendsOnlinePlugin(): Plugin {
    let offs: (() => void)[] = [];
    return {
        name: "FriendsOnline",
        description: "Show online friend count in the DM sidebar header.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            const count = (): number => {
                try {
                    const rel = findStoreByName("RelationshipStore");
                    const presence = findStoreByName("PresenceStore");
                    if (!rel || !presence) return -1;
                    const getFriendIDs = rel.getFriendIDs as
                        | (() => unknown)
                        | undefined;
                    const friends = (getFriendIDs?.() ?? rel.friendIDs ?? []) as unknown;
                    if (!Array.isArray(friends)) return -1;
                    const getStatus = presence.getStatus as
                        | ((id: string) => unknown)
                        | undefined;
                    let n = 0;
                    for (const id of friends) {
                        if (typeof id !== "string") continue;
                        const r = getStatus?.(id);
                        const status =
                            typeof r === "string"
                                ? r
                                : (r as { status?: string } | undefined)?.status;
                        if (status && status !== "offline" && status !== "invisible") n++;
                    }
                    return n;
                } catch {
                    return -1;
                }
            };

            const stopObserve = observeAdded(
                '[class*="privateChannels"] [class*="title"], [class*="privateChannels"] header',
                (header) => {
                    if (header.querySelector("[data-monocord-friends]")) return;
                    const n = count();
                    if (n < 0) return;
                    const badge = el(
                        "span",
                        {
                            marginLeft: "6px",
                            fontSize: "12px",
                            color: "var(--text-muted, #949ba4)",
                            fontWeight: "400",
                        },
                        `· ${n} online`,
                    );
                    badge.setAttribute("data-monocord-friends", "1");
                    header.append(badge);
                },
            );
            offs.push(stopObserve);
            // Re-count periodically so badges stay fresh.
            const timer = setInterval(() => {
                const n = count();
                if (n < 0) return;
                document
                    .querySelectorAll("[data-monocord-friends]")
                    .forEach((b) => (b.textContent = `· ${n} online`));
            }, 30000);
            offs.push(() => clearInterval(timer));
        },

        stop() {
            for (const off of offs) off();
            offs = [];
            document.querySelectorAll("[data-monocord-friends]").forEach((n) => n.remove());
        },
    };
}

/**
 * ServerBoosts — shows the server's boost count as a small badge on its
 * icon in the guild sidebar. Reads GuildStore via the guild ID encoded in
 * the icon's `data-list-item-id` (`guildsnav___<id>`).
 */
function serverBoostsPlugin(): Plugin {
    let stopObserve: (() => void) | null = null;
    return {
        name: "ServerBoosts",
        description: "Show server boost count as a badge on guild icons.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            stopObserve = observeAdded(
                '[class*="guilds"] [class*="avatar"], [class*="guilds"] [class*="icon"]',
                (icon) => {
                    try {
                        if (icon.querySelector("[data-monocord-boosts]")) return;
                        const wrapper = icon.closest("[data-list-item-id]");
                        const raw = wrapper?.getAttribute("data-list-item-id") ?? "";
                        const guildId = raw.split("___").pop();
                        if (!guildId || !/^\d+$/.test(guildId)) return;
                        const guilds = findStoreByName("GuildStore");
                        const getGuild = guilds?.getGuild as
                            | ((id: string) => Record<string, unknown> | undefined)
                            | undefined;
                        const guild = getGuild?.(guildId);
                        const boosts = guild?.premiumSubscriberCount;
                        if (typeof boosts !== "number" || boosts <= 0) return;
                        const tier = guild?.premiumTier;
                        const tierText =
                            typeof tier === "number" && tier > 0 ? ` · T${tier}` : "";
                        const badge = el(
                            "span",
                            {
                                position: "absolute",
                                bottom: "-2px",
                                right: "-2px",
                                background: "var(--status-positive, #23a55a)",
                                color: "#fff",
                                fontSize: "10px",
                                fontWeight: "700",
                                borderRadius: "8px",
                                padding: "1px 4px",
                                lineHeight: "12px",
                            },
                            `${boosts}${tierText}`,
                        );
                        badge.setAttribute("data-monocord-boosts", "1");
                        const pos = icon as HTMLElement;
                        if (getComputedStyle(pos).position === "static") {
                            pos.style.position = "relative";
                        }
                        pos.append(badge);
                    } catch {
                        /* store or DOM shape changed — skip */
                    }
                },
            );
        },

        stop() {
            stopObserve?.();
            stopObserve = null;
            document
                .querySelectorAll("[data-monocord-boosts]")
                .forEach((n) => n.remove());
        },
    };
}

/**
 * GifStealth — Alt+click a GIF/tenor image copies its URL to the clipboard
 * instead of opening Discord's preview. Mirrors Vencord's gifStealthMode.
 */
function gifStealthPlugin(): Plugin {
    let off: (() => void) | null = null;
    return {
        name: "GifStealth",
        description: "Alt+click a GIF to copy its URL instead of previewing it.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            const handler = (ev: MouseEvent) => {
                if (!ev.altKey) return;
                const t = ev.target;
                if (!(t instanceof HTMLImageElement)) return;
                const src = t.currentSrc || t.src;
                if (!/tenor|giphy|gif/i.test(src)) return;
                ev.preventDefault();
                ev.stopPropagation();
                void navigator.clipboard?.writeText(src).then(
                    () => toast("GIF URL copied"),
                    () => toast(`Copy failed — ${src}`),
                );
            };
            document.addEventListener("click", handler, true);
            off = () => document.removeEventListener("click", handler, true);
        },

        stop() {
            off?.();
            off = null;
        },
    };
}

/**
 * CopyCurrentIds — Ctrl+Alt+1 copies the current channel ID,
 * Ctrl+Alt+2 copies the current guild ID (or @me for DMs).
 */
function copyCurrentIdsPlugin(): Plugin {
    let off: (() => void) | null = null;
    return {
        name: "CopyCurrentIds",
        description: "Ctrl+Alt+1 copies channel ID, Ctrl+Alt+2 copies server ID.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            const handler = (ev: KeyboardEvent) => {
                if (!(ev.ctrlKey && ev.altKey && !ev.shiftKey)) return;
                const k = ev.key;
                if (k !== "1" && k !== "2") return;
                try {
                    const sel = findStoreByName("SelectedChannelStore");
                    const getChannelId = sel?.getChannelId as
                        | (() => string | null)
                        | undefined;
                    const getGuildId = sel?.getGuildId as
                        | (() => string | null)
                        | undefined;
                    let text: string | null = null;
                    let label = "";
                    if (k === "1") {
                        text = getChannelId?.() ?? null;
                        label = "channel ID";
                    } else {
                        const gid = getGuildId?.();
                        text = gid || "@me";
                        label = "server ID";
                    }
                    if (!text) {
                        toast("No channel/server selected");
                        return;
                    }
                    ev.preventDefault();
                    void navigator.clipboard?.writeText(text).then(
                        () => toast(`Copied ${label}: ${text}`),
                        () => toast(`Copy failed — ${text}`),
                    );
                } catch {
                    toast("Stores not ready yet");
                }
            };
            document.addEventListener("keydown", handler);
            off = () => document.removeEventListener("keydown", handler);
        },

        stop() {
            off?.();
            off = null;
        },
    };
}

/**
 * CopyMsgLink — Ctrl+Alt+L copies a jump link for the message under the
 * cursor (parsed from its `chat-messages-<channel>-<msg>` element id).
 */
function copyMsgLinkPlugin(): Plugin {
    let off: (() => void) | null = null;
    return {
        name: "CopyMsgLink",
        description: "Ctrl+Alt+L copies a jump link for the hovered message.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            let hovered: Element | null = null;
            const track = (ev: MouseEvent) => {
                const t = ev.target;
                hovered =
                    t instanceof Element
                        ? t.closest('[id^="chat-messages"]')
                        : null;
            };
            document.addEventListener("mousemove", track, { passive: true });

            const handler = (ev: KeyboardEvent) => {
                if (
                    !(ev.ctrlKey && ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "l")
                ) {
                    return;
                }
                const msgEl = hovered;
                if (!msgEl?.id.startsWith("chat-messages-")) {
                    toast("Hover a message first");
                    return;
                }
                const rest = msgEl.id.slice("chat-messages-".length);
                const dash = rest.lastIndexOf("-");
                if (dash < 0) return;
                const channelId = rest.slice(0, dash);
                const messageId = rest.slice(dash + 1);
                let guildId = "@me";
                try {
                    const sel = findStoreByName("SelectedChannelStore");
                    const gid = (sel?.getGuildId as (() => string | null) | undefined)?.();
                    if (gid) guildId = gid;
                } catch {
                    /* stay @me */
                }
                const url = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
                ev.preventDefault();
                void navigator.clipboard?.writeText(url).then(
                    () => toast("Message link copied"),
                    () => toast(`Copy failed — ${url}`),
                );
            };
            document.addEventListener("keydown", handler);
            off = () => {
                document.removeEventListener("mousemove", track);
                document.removeEventListener("keydown", handler);
            };
        },

        stop() {
            off?.();
            off = null;
        },
    };
}

/**
 * ServerListAlphabetical — sorts server icons A→Z in the guild sidebar.
 * Bails out entirely when server folders are present (folders have their
 * own ordering and mixing them would look broken).
 */
function serverListAlphabeticalPlugin(): Plugin {
    let stopObserve: (() => void) | null = null;
    let sorting = false;
    return {
        name: "ServerListAlphabetical",
        description: "Sort server icons alphabetically (disabled while folders exist).",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            const sort = (scroller: Element) => {
                if (sorting) return;
                if (scroller.querySelector('[class*="folder"]')) return;
                const items = Array.from(scroller.children).filter(
                    (c) =>
                        c instanceof HTMLElement &&
                        (c.getAttribute("data-list-item-id")?.startsWith("guildsnav") ||
                            c.querySelector('[class*="avatar"], [role="listitem"]')),
                );
                if (items.length < 2) return;
                const keyed = items.map((el) => ({
                    el,
                    key: (
                        el.getAttribute("aria-label") ??
                        el.textContent ??
                        ""
                    ).toLowerCase(),
                }));
                keyed.sort((a, b) => a.key.localeCompare(b.key));
                if (keyed.every((k, i) => k.el === items[i])) return;
                sorting = true;
                try {
                    for (const { el } of keyed) scroller.append(el);
                } finally {
                    sorting = false;
                }
            };
            stopObserve = observeAdded('[class*="guilds"]', (node) => {
                const scroller =
                    node instanceof HTMLElement && node.scrollHeight > node.clientHeight
                        ? node
                        : node.querySelector('[class*="scroller"], [class*="list"]') ?? node;
                sort(scroller);
            });
        },

        stop() {
            stopObserve?.();
            stopObserve = null;
        },
    };
}

/** Register all "more" plugins. */
export function registerMore(): void {
    for (const plugin of [
        HideNitro,
        SquareAvatars,
        BiggerAvatars,
        ThinMessages,
        BiggerReactions,
        NoReactions,
        NoChannelTopic,
        HideMemberList,
        CompactGuilds,
        BiggerServerIcons,
        NoBoostBar,
        NoServerDiscover,
        BiggerEmoji,
        HideSystemMessages,
        SmallText,
        BiggerInput,
        NoChannelIcons,
        FlatScrollbars,
        NoGifHover,
        CompactMembers,
        ThinGuilds,
        WiderChat,
        ChatInputHeight,
        MemberListOpacity,
        NoChannelFade,
        BiggerServerHeader,
        NoImageHover,
        GuildIconBorder,
        NoUnreadBadge,
        FlatAvatars,
        NoAvatars,
        CompactAvatars,
        NoMemberAvatars,
        NoEmbedColor,
        CompactReactions,
        NoUnreadHighlight,
        NoRoleColors,
        NoServerTag,
        NoEmbedFooter,
        HugeAvatars,
        BiggerServerList,
        NoNitroBadge,
        HideStageChannel,
        CompactRoles,
        copyIdsPlugin(),
        friendsOnlinePlugin(),
        serverBoostsPlugin(),
        gifStealthPlugin(),
        copyCurrentIdsPlugin(),
        copyMsgLinkPlugin(),
        serverListAlphabeticalPlugin(),
    ]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
