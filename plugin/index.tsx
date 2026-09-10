/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, closeModal, Menu, UserStore } from "@webpack/common";

import { Native } from "./bridge";
import { resolveExportChannel } from "./channels";
import { openExportModal } from "./ExportModal";
import { settings } from "./settings";

const TokenProvider = findByPropsLazy("getToken") as { getToken(): string | null; };

function patchMenu(menu: string): NavContextMenuPatchCallback {
    return (children, props) => {
        const channel = resolveExportChannel(menu, props, ChannelStore);
        if (!channel) return;
        const recipientNames = channel.recipients?.map(id => {
            const user = UserStore.getUser(id);
            return user?.globalName || user?.username || id;
        }).join(", ");
        const name = channel.name || recipientNames || `Chat ${channel.id}`;
        children.push(
            <Menu.MenuGroup key="vc-discord-chat-exporter">
                <Menu.MenuItem
                    id="vc-export-chat"
                    label="Export chat"
                    action={() => openExportModal({ id: channel.id, name, type: channel.type }, () => {
                        try {
                            return TokenProvider.getToken();
                        } catch {
                            return null;
                        }
                    })}
                />
            </Menu.MenuGroup>
        );
    };
}

export default definePlugin({
    name: "DiscordChatExporter",
    description: "Export DMs, group chats and server channels through DiscordChatExporter with a native export dialog.",
    authors: [{ name: "tomerh2001", id: 0n }],
    settings,
    contextMenus: {
        "channel-context": patchMenu("channel-context"),
        "thread-context": patchMenu("thread-context"),
        "gdm-context": patchMenu("gdm-context"),
        "user-context": patchMenu("user-context")
    },
    stop() {
        closeModal("vc-discord-chat-exporter");
        void Native.cleanup().catch(() => { });
    }
});
