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
        copyIdsPlugin(),
        friendsOnlinePlugin(),
    ]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
