/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ExportChannel {
    id: string;
    name?: string;
    type: number;
    recipients?: string[];
}

export interface MenuProps {
    channel?: ExportChannel;
    channelId?: string;
    guildId?: string;
    user?: { id: string; };
}

interface ChannelLookup {
    getChannel(id: string): ExportChannel | undefined;
    getDMFromUserId(id: string): string | undefined;
}

// Text, DM, voice chat, group DM, announcement, thread, stage chat and forum.
// DCE 2.48 does not recognize media containers (16); their individual threads work.
const MESSAGE_CHANNEL_TYPES = new Set([0, 1, 2, 3, 5, 10, 11, 12, 13, 15]);

export function resolveExportChannel(menu: string, props: MenuProps, store: ChannelLookup): ExportChannel | undefined {
    let channel = props.channel ?? (props.channelId ? store.getChannel(props.channelId) : undefined);
    if (menu === "user-context") {
        // A server member menu must never silently target the surrounding channel.
        if (props.guildId || (channel && channel.type !== 1 && channel.type !== 3)) return;
        if (!channel && props.user) {
            const id = store.getDMFromUserId(props.user.id);
            if (id) channel = store.getChannel(id);
        }
        if (channel && channel.type !== 1 && channel.type !== 3) return;
    }
    if (!channel || !MESSAGE_CHANNEL_TYPES.has(channel.type) || !/^\d{17,20}$/.test(channel.id)) return;
    return channel;
}
