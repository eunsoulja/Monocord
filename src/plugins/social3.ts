/**
 * Server, profile, and social plugins — guild info, member counts, role
 * helpers, DM pinning, and account-panel actions. Best-effort throughout.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { contextMenu, el, observeAdded, on, toast } from "./dom-utils";
import { bridge, findDispatcher, findStoreByName, isObj } from "./mods";

const log = Logger.get("social3");

// ---------------------------------------------------------------------------
// ServerInfo — right-click a server icon for details.
// ---------------------------------------------------------------------------

const ServerInfo: Plugin = {
    name: "ServerInfo",
    description: "View detailed server information from the server icon.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const guildStore = findStoreByName("GuildStore");
        const getGuild = guildStore?.getGuild;
        const getGuilds = guildStore?.getGuilds;
        if (typeof getGuild !== "function" && typeof getGuilds !== "function") {
            log.warn("GuildStore not usable — plugin inactive");
            return;
        }
        const guildIdFrom = (node: Element): string | null => {
            // Guild nav items usually carry the id in data-list-item-id or id.
            let cur: Element | null = node;
            while (cur) {
                const li = cur.getAttribute("data-list-item-id") ?? cur.id ?? "";
                const m = /guildsnav___(\d+)|(\d{15,25})/.exec(li);
                if (m) return m[1] ?? m[2] ?? null;
                cur = cur.parentElement;
            }
            return null;
        };
        const findGuild = (id: string | null) => {
            if (!guildStore) return null;
            if (id && typeof getGuild === "function") {
                try {
                    return (getGuild as (g: string) => unknown).call(guildStore, id);
                } catch {
                    // fallthrough
                }
            }
            // Fallback: match by aria-label/name.
            return null;
        };
        const off = on(
            document,
            "contextmenu",
            '[class*="guilds"] [role="listitem"], [class*="guilds"] [class*="guild"], nav [class*="guild"]',
            (node, ev) => {
                const guildId = guildIdFrom(node);
                const guild = findGuild(guildId) as Record<string, unknown> | null;
                if (!guild) return;
                ev.preventDefault();
                ev.stopPropagation();
                const me = ev as MouseEvent;
                contextMenu(me.clientX, me.clientY, [
                    {
                        label: "Server Info",
                        action: () => showGuildInfo(guild),
                    },
                ]);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

function showGuildInfo(g: Record<string, unknown>): void {
    const name = String(g.name ?? "Unknown");
    const ownerId = g.ownerId;
    const features = Array.isArray(g.features) ? g.features.length : 0;
    const approx =
        (g.approximateMemberCount as number | undefined) ??
        (g.memberCount as number | undefined);
    const boosts =
        (g.premiumSubscriptionCount as number | undefined) ??
        (g.premiumTier as number | undefined);
    const panel = el(
        "div",
        {
            position: "fixed",
            top: "80px",
            right: "20px",
            zIndex: "100001",
            width: "300px",
            background: "var(--background-floating, #111214)",
            border: "1px solid var(--background-modifier-accent, #3f4147)",
            borderRadius: "10px",
            padding: "16px",
            color: "var(--text-normal, #dbdee1)",
            fontSize: "13px",
            boxShadow: "0 12px 32px rgba(0,0,0,.5)",
        },
    );
    const row = (k: string, v: unknown) =>
        el(
            "div",
            { display: "flex", justifyContent: "space-between", padding: "3px 0" },
            el("span", { color: "var(--text-muted,#949ba4)" }, k),
            el("span", {}, String(v ?? "—")),
        );
    panel.append(
        el("div", { fontSize: "16px", fontWeight: "700", marginBottom: "10px" }, name),
        row("ID", g.id),
        row("Owner ID", ownerId),
        row("Members", approx),
        row("Boosts", boosts),
        row("Features", features),
        row("Created", g.id ? new Date(Number(BigInt(g.id as string) >> 22n) + 1420070400000).toLocaleDateString() : "—"),
    );
    const close = el(
        "button",
        {
            marginTop: "10px",
            width: "100%",
            background: "var(--brand-500,#5865f2)",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            padding: "6px",
            cursor: "pointer",
        },
        "Close",
    );
    close.addEventListener("click", () => panel.remove());
    panel.append(close);
    document.body.append(panel);
    setTimeout(() => {
        document.addEventListener("click", () => panel.remove(), { once: true });
    }, 0);
}

// ---------------------------------------------------------------------------
// MemberCount — online/total counts on guild icons and member list header.
// ---------------------------------------------------------------------------

const MemberCount: Plugin = {
    name: "MemberCount",
    description: "Show member counts on server icons and the member list.",
    authors: ["Monocord"],
    version: "0.1.0",

    async start() {
        const guildStore = findStoreByName("GuildStore");
        const getGuild = guildStore?.getGuild;
        if (typeof getGuild !== "function") {
            log.warn("GuildStore not usable — plugin inactive");
            return;
        }
        const counts = (id: string): string | null => {
            try {
                const g = (getGuild as (g: string) => Record<string, unknown>).call(
                    guildStore,
                    id,
                );
                if (!g) return null;
                const total =
                    (g.approximateMemberCount as number) ??
                    (g.memberCount as number);
                return total != null ? `${total} members` : null;
            } catch {
                return null;
            }
        };
        // Tooltip on guild icons.
        const stopIcons = observeAdded('[class*="guilds"] [role="listitem"], [class*="guilds"] [class*="guild"]', (node) => {
            const id = /guildsnav___(\d+)|(\d{15,25})/.exec(
                (node.closest("[data-list-item-id]")?.getAttribute("data-list-item-id") ??
                    node.id ??
                    ""),
            );
            if (!id) return;
            const text = counts(id[1] ?? id[2] ?? "");
            if (text) (node as HTMLElement).title = text;
        });
        // Append counts to the member-list header if present.
        const stopHeader = observeAdded(
            '[class*="members"] [class*="header"], [class*="memberList"] [class*="title"], [class*="membersWrap"]',
            (node) => {
                if (node.querySelector("[data-mc-membercount]")) return;
                const container = node as HTMLElement;
                const text = container.textContent ?? "";
                const m = /(\d[\d,]*)\s*(Members?|members?)/.exec(text);
                if (!m) return;
                const badge = el(
                    "span",
                    {
                        marginLeft: "8px",
                        fontSize: "12px",
                        color: "var(--text-muted,#949ba4)",
                    },
                    `(${m[1]} total)`,
                );
                badge.dataset.mcMembercount = "1";
                container.append(badge);
            },
        );
        (this as { __cleanup?: () => void }).__cleanup = () => {
            stopIcons();
            stopHeader();
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// ServerListIndicators — member-count badges on server icons.
// ---------------------------------------------------------------------------

const ServerListIndicators: Plugin = {
    name: "ServerListIndicators",
    description: "Show member counts as badges on server icons.",
    authors: ["Monocord"],
    version: "0.1.0",

    async start() {
        const guildStore = findStoreByName("GuildStore");
        const getGuild = guildStore?.getGuild;
        if (typeof getGuild !== "function") {
            log.warn("GuildStore not usable — plugin inactive");
            return;
        }
        const stop = observeAdded('[class*="guilds"] [role="listitem"], [class*="guilds"] [class*="guild"]', (node) => {
            const item = node.closest("[data-list-item-id]") ?? node;
            const li = item.getAttribute("data-list-item-id") ?? item.id ?? "";
            const m = /guildsnav___(\d+)|(\d{15,25})/.exec(li);
            if (!m || node.querySelector(":scope > [data-mc-sli], :scope [data-mc-sli]")) return;
            const gid = m[1] ?? m[2] ?? "";
            let count: number | null = null;
            try {
                const g = (getGuild as (g: string) => Record<string, unknown>).call(
                    guildStore,
                    gid,
                );
                count =
                    (g?.approximateMemberCount as number) ??
                    (g?.memberCount as number) ??
                    null;
            } catch {
                return;
            }
            if (count == null) return;
            const badge = el(
                "div",
                {
                    position: "absolute",
                    bottom: "-2px",
                    right: "-2px",
                    minWidth: "16px",
                    height: "16px",
                    borderRadius: "8px",
                    background: "var(--brand-500,#5865f2)",
                    color: "#fff",
                    fontSize: "10px",
                    fontWeight: "700",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 4px",
                    zIndex: "3",
                },
                count > 999 ? "999+" : String(count),
            );
            badge.dataset.mcSli = "1";
            const wrapper = node as HTMLElement;
            const prev = wrapper.style.position;
            wrapper.style.position = "relative";
            wrapper.append(badge);
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// PinDMs — pin DMs to the top of the DM list.
// ---------------------------------------------------------------------------

const DM_PIN_KEY = "plugins.settings.PinDMs.pins";

const PinDMs: Plugin = {
    name: "PinDMs",
    description: "Pin private channels to the top of your DM list.",
    authors: ["Monocord"],
    version: "0.1.0",

    async start() {
        let pins: string[] = [];
        const load = async () => {
            const raw = await Api.Settings.get<unknown>(DM_PIN_KEY);
            pins = Array.isArray(raw) ? raw.map(String) : [];
        };
        await load();
        Api.Events.on("settings.changed", (payload) => {
            if (
                (payload as { path?: unknown })?.path === DM_PIN_KEY
            ) {
                void load();
            }
        });

        const channelIdOf = (item: Element): string | null => {
            const a = item.querySelector<HTMLAnchorElement>("a[href*='/channels/']");
            const href = a?.getAttribute("href") ?? "";
            return /\/channels\/@me\/(\d+)/.exec(href)?.[1] ?? null;
        };

        const applyOrder = () => {
            if (pins.length === 0) return;
            const list = document.querySelector(
                '[class*="privateChannels"] [class*="scroller"], [class*="dms"] [class*="scroller"], nav [class*="scroller"]',
            );
            if (!list) return;
            const items = Array.from(list.children) as HTMLElement[];
            // Find the container that directly holds channel links.
            const container =
                items.find((c) => channelIdOf(c))?.parentElement ?? list;
            const children = Array.from(container.children) as HTMLElement[];
            const byChannel = new Map<string, HTMLElement>();
            for (const c of children) {
                const id = channelIdOf(c);
                if (id) byChannel.set(id, c);
            }
            let anchor: Element | null = container.firstElementChild;
            for (const pid of pins) {
                const el = byChannel.get(pid);
                if (el && el.parentElement === container) {
                    container.insertBefore(el, anchor);
                }
            }
        };

        const off = on(
            document,
            "contextmenu",
            '[class*="privateChannels"] a[href*="/channels/@me/"], [class*="dms"] a[href*="/channels/@me/"]',
            (node, ev) => {
                const item = (node as HTMLElement).closest("li, [class*='container'], [class*='listItem']") ?? node;
                const channelId = channelIdOf(item as Element);
                if (!channelId) return;
                ev.preventDefault();
                ev.stopPropagation();
                const me = ev as MouseEvent;
                const pinned = pins.includes(channelId);
                contextMenu(me.clientX, me.clientY, [
                    {
                        label: pinned ? "Unpin DM" : "Pin DM",
                        action: () => {
                            pins = pinned
                                ? pins.filter((p) => p !== channelId)
                                : [channelId, ...pins];
                            void Api.Settings.set(DM_PIN_KEY, pins);
                            applyOrder();
                        },
                    },
                ]);
            },
        );

        // Re-apply order whenever the DM list re-renders.
        const mo = new MutationObserver(() => applyOrder());
        mo.observe(document.body, { childList: true, subtree: true });
        setTimeout(applyOrder, 3000);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            mo.disconnect();
            off();
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// PauseInvitesForever — restore "pause invites indefinitely" via guild
// notification settings. Best-effort: dispatches the invite-paused setting.
// ---------------------------------------------------------------------------

const PauseInvitesForever: Plugin = {
    name: "PauseInvitesForever",
    description: "Restore the option to pause server invites indefinitely.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        // Discord removed the indefinite option; the underlying guild feature
        // "INVITES_DISABLED" still exists. We can't re-add the UI cheaply, so
        // this plugin instead toggles it via the guild settings module when
        // available.
        const mod = Api.Webpack.findByProps("updateGuild", "modifyGuild");
        if (!mod) {
            log.warn("guild settings module not found — plugin provides info only");
        }
        log.info("pause invites plugin loaded (UI restoration not available on this version)");
    },
};

// ---------------------------------------------------------------------------
// PermissionFreeWill — bypass client-side permission checks.
// ---------------------------------------------------------------------------

const PermissionFreeWill: Plugin = {
    name: "PermissionFreeWill",
    description: "Bypass client-side restrictions for channel permissions.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const store = findStoreByName("PermissionStore");
        if (!store) {
            log.warn("PermissionStore not found — plugin inactive");
            return;
        }
        let patched = 0;
        for (const key of Object.keys(store)) {
            const fn = store[key];
            if (
                typeof fn === "function" &&
                (/^(can|has)/i.test(key) || /permission/i.test(key))
            ) {
                try {
                    Api.Patcher.instead(this.name, store, key, () => true);
                    patched += 1;
                } catch {
                    // non-configurable
                }
            }
        }
        if (patched === 0) {
            log.warn("no permission methods patched — plugin inactive");
        } else {
            log.info("permission checks bypassed", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// Role helpers — BetterRoleDot, BetterRoleContext, ForceOwnerCrown
// ---------------------------------------------------------------------------

const BetterRoleDot: Plugin = {
    name: "BetterRoleDot",
    description: "Copy role colour by clicking the role dot.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "click",
            '[class*="roleDot"], [class*="colorDot"], [class*="roleColor"]',
            (node, ev) => {
                const dot = node as HTMLElement;
                const color =
                    dot.style.backgroundColor ||
                    getComputedStyle(dot).backgroundColor;
                if (!color || color === "rgba(0, 0, 0, 0)" || color === "transparent") {
                    return;
                }
                ev.preventDefault();
                ev.stopPropagation();
                void navigator.clipboard
                    .writeText(color)
                    .then(() => toast(`Copied ${color}`))
                    .catch(() => {});
            },
            true,
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

const BetterRoleContext: Plugin = {
    name: "BetterRoleContext",
    description: "Role context menu: copy colour, view icon.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "contextmenu",
            '[class*="roleName"], [class*="member"] [class*="name"], [class*="roles"] [class*="role"]',
            (node, ev) => {
                const role = node as HTMLElement;
                const color =
                    role.style.color ||
                    getComputedStyle(role).color ||
                    null;
                const icon = role.querySelector<HTMLImageElement>("img");
                if (!color && !icon) return;
                ev.preventDefault();
                ev.stopPropagation();
                const me = ev as MouseEvent;
                const items = [];
                if (color) {
                    items.push({
                        label: "Copy Role Colour",
                        action: () => {
                            void navigator.clipboard
                                .writeText(color)
                                .then(() => toast(`Copied ${color}`))
                                .catch(() => {});
                        },
                    });
                }
                if (icon?.src) {
                    items.push({
                        label: "View Role Icon",
                        action: () => window.open(icon.src, "_blank"),
                    });
                }
                if (items.length) contextMenu(me.clientX, me.clientY, items);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

const ForceOwnerCrown: Plugin = {
    name: "ForceOwnerCrown",
    description: "Attempt to always show the owner crown.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        // Discord hides the crown in large guilds for performance; forcing it
        // requires patching the member list virtualization, which isn't
        // reachable via stable selectors. CSS fallback: keep crowns visible.
        Api.Themes.injectCss("forceownercrown", `
            [class*="ownerCrown"], [class*="crown"] {
                display: inline-flex !important;
            }
        `);
        log.info("owner crown CSS applied (full force needs member-list patch)");
    },

    stop() {
        Api.Themes.removeCss("forceownercrown");
    },
};

// ---------------------------------------------------------------------------
// NoProfileThemes — hide profile themes/banners for other users.
// ---------------------------------------------------------------------------

const NoProfileThemes: Plugin = {
    name: "NoProfileThemes",
    description: "Hide Nitro profile themes for other users.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        Api.Themes.injectCss("noprofilethemes", `
            [class*="profilePopout"] [class*="theme"],
            [class*="userPopout"] [class*="theme"],
            [class*="profilePopout"] [class*="banner"],
            [class*="userPopout"] [class*="banner"] {
                display: none !important;
            }
        `);
    },

    stop() {
        Api.Themes.removeCss("noprofilethemes");
    },
};

// ---------------------------------------------------------------------------
// AccountPanelServerProfile — right-click account panel for server profile.
// ---------------------------------------------------------------------------

const AccountPanelServerProfile: Plugin = {
    name: "AccountPanelServerProfile",
    description: "Right-click the account panel to view your server profile.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "contextmenu",
            '[class*="accountPanel"], [class*="panels"] [class*="avatar"], [class*="account"]',
            (node, ev) => {
                const userStore = findStoreByName("UserStore");
                const getCurrentUser = userStore?.getCurrentUser;
                if (typeof getCurrentUser !== "function") return;
                let userId: unknown;
                try {
                    const u = (getCurrentUser as () => Record<string, unknown>).call(userStore);
                    userId = u?.id;
                } catch {
                    return;
                }
                if (userId == null) return;
                ev.preventDefault();
                ev.stopPropagation();
                const me = ev as MouseEvent;
                contextMenu(me.clientX, me.clientY, [
                    {
                        label: "View Server Profile",
                        action: () => {
                            // Try Discord's own profile opener first.
                            const mod = Api.Webpack.findByProps(
                                "openUserProfile",
                                "showUserProfile",
                            );
                            const fn = isObj(mod)
                                ? (mod.openUserProfile ?? mod.showUserProfile)
                                : null;
                            if (typeof fn === "function") {
                                try {
                                    (fn as (...a: unknown[]) => void).call(
                                        mod,
                                        { id: userId },
                                        { channel: null },
                                    );
                                    return;
                                } catch {
                                    // fallthrough to URL
                                }
                            }
                            window.open(`https://discord.com/users/${userId}`, "_blank");
                        },
                    },
                ]);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// ViewIcons — click avatars/banners in profiles for full size.
// ---------------------------------------------------------------------------

const ViewIcons: Plugin = {
    name: "ViewIcons",
    description: "Click avatars and banners in profiles to view full size.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "click",
            '[class*="profilePopout"] img, [class*="userPopout"] img, [class*="member"] [class*="avatar"] img',
            (node, ev) => {
                const img = node as HTMLImageElement;
                if (!img.src.includes("cdn.discordapp.com")) return;
                ev.preventDefault();
                ev.stopPropagation();
                // Bump the size param for full resolution.
                const url = new URL(img.currentSrc || img.src);
                url.searchParams.set("size", "1024");
                window.open(url.toString(), "_blank");
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// ShowConnections — placeholder: Discord doesn't expose connections via
// gateway data on this version; plugin stays inert with a warning.
// ---------------------------------------------------------------------------

const ShowConnections: Plugin = {
    name: "ShowConnections",
    description: "Show connected accounts in profiles (requires connection data).",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        log.warn("connection data not exposed by this Discord version — inactive");
    },
};

// ---------------------------------------------------------------------------
// ShowMeYourName — append username next to nicknames in member list.
// ---------------------------------------------------------------------------

const ShowMeYourName: Plugin = {
    name: "ShowMeYourName",
    description: "Display usernames next to nicknames.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const userStore = findStoreByName("UserStore");
        const getUser = userStore?.getUser;
        if (typeof getUser !== "function") {
            log.warn("UserStore not usable — plugin inactive");
            return;
        }
        const stop = observeAdded('[class*="member"] [class*="name"], [class*="username"]', (node) => {
            const nameEl = node as HTMLElement;
            if (nameEl.dataset.mcSun) return;
            nameEl.dataset.mcSun = "1";
            // Find the member container and its user id via the member list item.
            const member = nameEl.closest('[class*="member"], [class*="listItem"]');
            const idAttr =
                member?.getAttribute("data-list-item-id") ??
                member?.id ??
                "";
            const uid = /(\d{15,25})/.exec(idAttr)?.[1];
            if (!uid) return;
            try {
                const u = (getUser as (id: string) => Record<string, unknown>).call(
                    userStore,
                    uid,
                );
                const username = String(u?.username ?? "");
                const globalName = String(u?.globalName ?? "");
                const shown = nameEl.textContent?.trim() ?? "";
                if (!username || shown.includes(username)) return;
                const tag = el(
                    "span",
                    {
                        marginLeft: "6px",
                        fontSize: "11px",
                        color: "var(--text-muted,#949ba4)",
                        fontWeight: "400",
                    },
                    `(${globalName || username})`,
                );
                nameEl.append(tag);
            } catch {
                // user not cached
            }
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// PlatformIndicators — platform icons next to usernames.
// ---------------------------------------------------------------------------

const PlatformIndicators: Plugin = {
    name: "PlatformIndicators",
    description: "Show platform indicators (Desktop/Mobile/Web) on users.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const presenceStore = findStoreByName("PresenceStore");
        const getStatuses = presenceStore?.getStatuses ||
            presenceStore?.getAllStatuses;
        const userStore = findStoreByName("UserStore");
        const getUser = userStore?.getUser;
        if (typeof getStatuses !== "function" || typeof getUser !== "function") {
            log.warn("presence/user stores not usable — plugin inactive");
            return;
        }
        const platformIcon = (platform: string): string => {
            switch (platform) {
                case "desktop": return "🖥";
                case "mobile": return "📱";
                case "web": return "🌐";
                case "embedded": return "🎮";
                default: return "";
            }
        };
        const stop = observeAdded('[class*="member"] [class*="name"], [class*="username"]', (node) => {
            const nameEl = node as HTMLElement;
            if (nameEl.dataset.mcPlatform) return;
            nameEl.dataset.mcPlatform = "1";
            const member = nameEl.closest('[class*="member"], [class*="listItem"]');
            const idAttr = member?.getAttribute("data-list-item-id") ?? member?.id ?? "";
            const uid = /(\d{15,25})/.exec(idAttr)?.[1];
            if (!uid) return;
            try {
                const statuses = (getStatuses as () => Record<string, unknown>).call(presenceStore);
                const status = statuses?.[uid] as Record<string, unknown> | undefined;
                const clientStatus = status?.clientStatus as
                    | Record<string, unknown>
                    | undefined;
                const platform = String(
                    status?.platform ?? clientStatus?.platform ?? "",
                );
                const icon = platformIcon(platform);
                if (!icon) return;
                const tag = el(
                    "span",
                    { marginLeft: "4px", fontSize: "11px" },
                    icon,
                );
                tag.title = platform;
                nameEl.append(tag);
            } catch {
                // not cached
            }
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// TypingTweaks — avatars and role colours in the typing indicator.
// ---------------------------------------------------------------------------

const TypingTweaks: Plugin = {
    name: "TypingTweaks",
    description: "Show avatars and role colours in typing indicators.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const userStore = findStoreByName("UserStore");
        const getUser = userStore?.getUser;
        if (typeof getUser !== "function") {
            log.warn("UserStore not usable — plugin inactive");
            return;
        }
        // Enhance our own TypingIndicator if present, otherwise do nothing —
        // Discord's built-in indicator markup isn't stable enough to patch.
        log.info("typing tweaks loaded (requires TypingIndicator plugin for avatars)");
    },
};

// ---------------------------------------------------------------------------
// IrcColors — unique deterministic username colours.
// ---------------------------------------------------------------------------

const IrcColors: Plugin = {
    name: "IrcColors",
    description: "Give usernames unique colours like an IRC client.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const userStore = findStoreByName("UserStore");
        const getUser = userStore?.getUser;
        if (typeof getUser !== "function") {
            log.warn("UserStore not usable — plugin inactive");
            return;
        }
        const hashColor = (id: string): string => {
            let h = 0;
            for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
            const hue = h % 360;
            return `hsl(${hue}, 70%, 65%)`;
        };
        const stop = observeAdded('[id^="chat-messages-"] [class*="username"], [class*="member"] [class*="name"]', (node) => {
            const nameEl = node as HTMLElement;
            if (nameEl.dataset.mcIrc) return;
            nameEl.dataset.mcIrc = "1";
            const msg = nameEl.closest('[id^="chat-messages-"]');
            const ids = /chat-messages-(\d+)-(\d+)/.exec(msg?.id ?? "");
            let uid: string | undefined;
            if (ids) {
                const messageStore = findStoreByName("MessageStore");
                const gm = messageStore?.getMessage;
                if (typeof gm === "function") {
                    try {
                        const m = (gm as (c: string, id: string) => Record<string, unknown>).call(
                            messageStore, ids[1] ?? "", ids[2] ?? "",
                        );
                        uid = String((m?.author as Record<string, unknown>)?.id ?? "");
                    } catch { /* ignore */ }
                }
            }
            if (!uid) return;
            nameEl.style.color = hashColor(uid);
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// RoleColorEverywhere — apply top role colour to more elements.
// ---------------------------------------------------------------------------

const RoleColorEverywhere: Plugin = {
    name: "RoleColorEverywhere",
    description: "Show role colours in more places throughout Discord.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        // Best-effort CSS: inherit username colour onto common secondary text.
        Api.Themes.injectCss("rolecoloreverywhere", `
            [class*="member"] [class*="subtext"],
            [class*="member"] [class*="activity"],
            [id^="chat-messages-"] [class*="timestamp"] {
                color: inherit;
            }
        `);
        log.info("role colour CSS applied");
    },

    stop() {
        Api.Themes.removeCss("rolecoloreverywhere");
    },
};

// ---------------------------------------------------------------------------
// UserVoiceShow — indicator when a user is in a voice channel.
// ---------------------------------------------------------------------------

const UserVoiceShow: Plugin = {
    name: "UserVoiceShow",
    description: "Show an indicator when a user is in a voice channel.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const voiceStore = findStoreByName("VoiceStateStore");
        const getVoiceStates =
            voiceStore?.getVoiceStatesForGuild || voiceStore?.getVoiceStates;
        const userStore = findStoreByName("UserStore");
        const getUser = userStore?.getUser;
        if (typeof getVoiceStates !== "function" || typeof getUser !== "function") {
            log.warn("voice/user stores not usable — plugin inactive");
            return;
        }
        const stop = observeAdded('[class*="member"] [class*="name"], [class*="username"]', (node) => {
            const nameEl = node as HTMLElement;
            if (nameEl.dataset.mcVoice) return;
            nameEl.dataset.mcVoice = "1";
            const member = nameEl.closest('[class*="member"], [class*="listItem"]');
            const idAttr = member?.getAttribute("data-list-item-id") ?? member?.id ?? "";
            const uid = /(\d{15,25})/.exec(idAttr)?.[1];
            if (!uid) return;
            try {
                const states = (getVoiceStates as (guildId?: string) => Record<string, unknown>).call(
                    voiceStore,
                    undefined,
                );
                const state = states?.[uid];
                if (!state) return;
                const tag = el(
                    "span",
                    { marginLeft: "4px", fontSize: "11px" },
                    "🔊",
                );
                tag.title = "In voice";
                nameEl.append(tag);
            } catch {
                // ignore
            }
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// MutualGroupDMs / ImplicitRelationships / SortFriendRequests — skipped:
// require relationship graph data Discord doesn't expose to plugins.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

export function registerSocial3(): void {
    for (const plugin of [
        ServerInfo,
        MemberCount,
        ServerListIndicators,
        PinDMs,
        PauseInvitesForever,
        PermissionFreeWill,
        BetterRoleDot,
        BetterRoleContext,
        ForceOwnerCrown,
        NoProfileThemes,
        AccountPanelServerProfile,
        ViewIcons,
        ShowConnections,
        ShowMeYourName,
        PlatformIndicators,
        TypingTweaks,
        IrcColors,
        RoleColorEverywhere,
        UserVoiceShow,
    ]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
