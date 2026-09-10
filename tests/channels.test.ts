import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveExportChannel } from "../plugin/channels";

const dm = { id: "123456789012345678", type: 1 };
const server = { id: "223456789012345678", type: 0 };
const lookup = {
    getChannel: (id: string) => id === dm.id ? dm : id === server.id ? server : undefined,
    getDMFromUserId: (id: string) => id === "friend" ? dm.id : undefined
};

test("private menu uses the DM channel ID, never the recipient ID", () => {
    assert.equal(resolveExportChannel("user-context", { user: { id: "friend" } }, lookup), dm);
    assert.equal(resolveExportChannel("user-context", { user: { id: "stranger" } }, lookup), undefined);
});

test("server member context cannot export a surrounding channel or unrelated DM", () => {
    assert.equal(resolveExportChannel("user-context", { channel: server, user: { id: "friend" } }, lookup), undefined);
    assert.equal(resolveExportChannel("user-context", { guildId: "guild", user: { id: "friend" } }, lookup), undefined);
});

test("supported chat surfaces resolve while categories do not", () => {
    for (const type of [0, 1, 2, 3, 5, 10, 11, 12, 13, 15]) {
        const channel = { ...server, type };
        assert.equal(resolveExportChannel("channel-context", { channel }, lookup), channel);
    }
    assert.equal(resolveExportChannel("channel-context", { channel: { ...server, type: 4 } }, lookup), undefined);
    assert.equal(resolveExportChannel("channel-context", { channel: { ...server, type: 16 } }, lookup), undefined);
    assert.equal(resolveExportChannel("thread-context", { channelId: server.id }, lookup), server);
    assert.equal(resolveExportChannel("gdm-context", {}, lookup), undefined);
});
